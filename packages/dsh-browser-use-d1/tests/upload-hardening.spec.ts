/**
 * BR-09 — the upload approval must be bound to the element that receives the
 * bytes, not to a selector that the page can re-point while the human reads the
 * prompt. The prompt must name absolute paths (with directories), the page can
 * never widen the target after approval, and symlinks never pass as files.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { runBrowserUpload } from '../src/upload.ts'
import { Config } from '../src/config.ts'
import { uiStrings } from '@albaincompleta/dsh-cu-core/locale'
import { CHROME } from './fixtures.ts'

let browser: Browser
let root: string
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: CHROME, headless: true })
  root = await mkdtemp(join(tmpdir(), 'dsh-cu-upload-hardening-'))
  await mkdir(join(root, 'private', 'customers'), { recursive: true })
  await writeFile(join(root, 'private', 'customers', 'pii.csv'), 'name,card\nada,4111\n')
  await writeFile(join(root, 'note.txt'), 'upload fixture')
})
afterAll(async () => {
  await browser.close()
  await rm(root, { recursive: true, force: true })
})

const strings = uiStrings('en')
const config = Config({ mode: 'launch', decisionToken: 'unused-token' })
const agent = { id: 'upload-hardening-agent' } as never

class SpyApprovals {
  readonly calls: Array<{ id: string; detail: string }> = []
  constructor(
    private readonly approve: boolean,
    private readonly during: () => Promise<void> | void = () => undefined,
  ) {}

  async request(_agent: unknown, request: { id: string; detail: string }) {
    this.calls.push({ id: request.id, detail: request.detail })
    await this.during()
    return this.approve ? { approved: true } : { approved: false, reason: 'denied_by_user' }
  }
}

it('writes to the element that was approved, even when the page re-points the selector', async () => {
  const page = await browser.newPage()
  await page.setContent(`
    <h1>Profile</h1>
    <form id="avatar-form" action="/upload-avatar" method="post" enctype="multipart/form-data">
      <input id="approved" name="avatar" type="file">
    </form>
    <script>
      window.__sink = null; window.__content = null;
      window.swapTargets = () => {
        const approved = document.getElementById('approved');
        const exportInput = document.createElement('input');
        exportInput.id = 'approved';
        exportInput.type = 'file';
        exportInput.name = 'account_export';
        exportInput.addEventListener('change', async () => {
          window.__sink = exportInput.name;
          window.__content = await exportInput.files[0].text();
        });
        approved.id = 'retired';
        approved.name = 'retired';
        document.body.appendChild(exportInput);
      };
    </script>`)

  const spy = new SpyApprovals(true, async () => {
    await page.evaluate(() => (window as unknown as { swapTargets: () => void }).swapTargets())
  })
  const result = await runBrowserUpload(
    page, config, strings, spy as never, agent,
    { locator: { kind: 'css', selector: '#approved' }, files: [join(root, 'private', 'customers', 'pii.csv')] },
    new AbortController().signal,
  )

  // The approved element still gets the file...
  expect(result).toMatchObject({ status: 'success', reason: 'uploaded', field: 'avatar' })
  expect(await page.evaluate(() => {
    const input = document.querySelector('[data-dsh-upload-token]') as HTMLInputElement | null
    return input?.files?.[0]?.name ?? null
  })).toBe('pii.csv')
  // ...and the input the page created mid-approval never sees the bytes.
  expect(await page.evaluate(() => (window as unknown as { __sink: string | null }).__sink)).toBe(null)
  expect(await page.evaluate(() => (window as unknown as { __content: string | null }).__content)).toBe(null)
  await page.close()
})

it('names absolute paths, sizes, and every file in the approval detail', async () => {
  const page = await browser.newPage()
  await page.setContent('<input id="f" name="avatar" type="file" multiple>')
  const spy = new SpyApprovals(true)
  const file = join(root, 'private', 'customers', 'pii.csv')
  const result = await runBrowserUpload(
    page, config, strings, spy as never, agent,
    { locator: { kind: 'css', selector: '#f' }, files: [file, join(root, 'note.txt')] },
    new AbortController().signal,
  )
  expect(result.status).toBe('success')
  expect(spy.calls).toHaveLength(1)
  const detail = spy.calls[0]!.detail
  // Full paths, not just basenames: a human must see where the bytes come from.
  expect(detail).toContain(file)
  expect(detail).toContain(join(root, 'note.txt'))
  expect(detail).toContain('avatar')
  // Sizes are part of the prompt so an unexpected multi-megabyte read is visible.
  expect(detail).toMatch(/\b\d+ (?:B|KiB|MiB)\b/u)
  await page.close()
})

it('refuses a symlink instead of uploading the file it points at', async () => {
  const page = await browser.newPage()
  await page.setContent('<input id="f" name="upload" type="file">')
  const link = join(root, 'invoice.pdf')
  await symlink('/etc/hosts', link)
  const spy = new SpyApprovals(true)
  const result = await runBrowserUpload(
    page, config, strings, spy as never, agent,
    { locator: { kind: 'css', selector: '#f' }, files: [link] },
    new AbortController().signal,
  )
  expect(result).toMatchObject({ status: 'blocked', reason: 'upload_symlink_rejected' })
  expect(spy.calls).toHaveLength(0)
  expect(await page.evaluate(() => {
    const input = document.getElementById('f') as HTMLInputElement
    return input.files?.length ?? 0
  })).toBe(0)
  await page.close()
})

it('keeps the per-file cap in addition to the total cap', async () => {
  const page = await browser.newPage()
  await page.setContent('<input id="f" name="upload" type="file">')
  const big = join(root, 'big.bin')
  // 21 MiB: below the 50 MiB total, above the per-file cap.
  await writeFile(big, Buffer.alloc(21 * 1024 * 1024, 0))
  const spy = new SpyApprovals(true)
  const result = await runBrowserUpload(
    page, config, strings, spy as never, agent,
    { locator: { kind: 'css', selector: '#f' }, files: [big] },
    new AbortController().signal,
  )
  expect(result).toMatchObject({ status: 'blocked', reason: 'upload_exceeds_file_size_limit' })
  expect(spy.calls).toHaveLength(0)
  await rm(big, { force: true })
  await page.close()
})

it('still asks first and writes nothing when the approval is denied', async () => {
  const page = await browser.newPage()
  await page.setContent('<input id="f" name="avatar" type="file">')
  const spy = new SpyApprovals(false)
  const result = await runBrowserUpload(
    page, config, strings, spy as never, agent,
    { locator: { kind: 'css', selector: '#f' }, files: [join(root, 'note.txt')] },
    new AbortController().signal,
  )
  expect(result).toMatchObject({ status: 'confirmation_required', reason: 'denied_by_user', field: 'avatar' })
  expect(spy.calls).toHaveLength(1)
  expect(await page.evaluate(() => {
    const input = document.getElementById('f') as HTMLInputElement
    return input.files?.length ?? 0
  })).toBe(0)
  await page.close()
})
