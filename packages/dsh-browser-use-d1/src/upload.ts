import { randomUUID } from 'node:crypto'
import { lstat, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ElementHandle, Page } from 'playwright'
import { extractLocatorSchema } from '@albaincompleta/dsh-cu-core/extract'
import { formatTemplate, type UiStrings } from '@albaincompleta/dsh-cu-core/locale'
import type { ApprovalGateway } from '@albaincompleta/dsh-cu-core/approvals'
import type { ResolvedConfig } from './config.ts'
import { locatorFor } from './locators.ts'

export const uploadInput = z.object({
  locator: extractLocatorSchema.describe('Explicit locator for the file input.'),
  files: z.array(z.string().min(1)).min(1).max(10)
    .describe('Absolute paths of local files to upload.'),
  timeoutMs: z.number().int().min(0).max(30000).optional()
    .describe('Optional wait for the file input to appear.'),
}).strict()

export interface UploadResult {
  status: 'success' | 'blocked' | 'confirmation_required'
  reason: string
  field?: string
  files?: string[]
  url?: string
  title?: string
  trusted?: false
  detail?: string
}

const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 50 * 1024 * 1024

interface CheckedFile {
  /** The absolute path exactly as the caller gave it. */
  path: string
  /** Byte length of the regular file, from `lstat` (never a symlink target). */
  bytes: number
}

/**
 * Validates every requested path before the approval prompt is composed, so the
 * human sees exactly what would be read.
 *
 * `lstat` (not `stat`) is deliberate: a symlink would let `invoice.pdf` stand
 * for `/etc/hosts`, so "the name the approver saw" and "the bytes written" could
 * diverge. Symlinks are refused outright instead of being resolved.
 */
async function validateFiles(files: string[]): Promise<{ ok: CheckedFile[]; reason?: string }> {
  const ok: CheckedFile[] = []
  let total = 0
  for (const file of files) {
    if (!isAbsolute(file)) return { ok: [], reason: 'upload_requires_absolute_paths' }
    let link
    try {
      link = await lstat(file)
    } catch {
      return { ok: [], reason: 'upload_file_not_found' }
    }
    if (link.isSymbolicLink()) return { ok: [], reason: 'upload_symlink_rejected' }
    if (!link.isFile()) return { ok: [], reason: 'upload_target_is_not_a_file' }
    const info = await stat(file)
    if (info.size > MAX_FILE_BYTES) return { ok: [], reason: 'upload_exceeds_file_size_limit' }
    total += info.size
    if (total > MAX_TOTAL_BYTES) return { ok: [], reason: 'upload_exceeds_size_limit' }
    ok.push({ path: file, bytes: info.size })
  }
  return { ok }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** Prompt text naming absolute paths and sizes, not just basenames (BR-09). */
function describeFiles(files: CheckedFile[]): string {
  return files.map(file => `${file.path} (${formatBytes(file.bytes)})`).join('\n')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface BoundTarget {
  page: Page
  handle: ElementHandle<SVGElement | HTMLElement>
  /** Random marker stamped on the approved node so a stand-in is detectable. */
  token: string
  /** Field label shown to the human, read once at bind time. */
  field: string
}

/**
 * Binds the upload to one DOM node *before* the human is asked, and re-reads the
 * binding after the approval.
 *
 * A Playwright `Locator` is lazy: `locator.setInputFiles()` re-resolves the
 * selector when it runs, so a page that rewrites its DOM while the prompt is
 * open would receive the approved bytes in a file input the user never saw.
 * The element handle pins the node instead.
 */
async function bindTarget(page: Page, rawArgs: z.infer<typeof uploadInput>): Promise<BoundTarget | { reason: string }> {
  const locator = locatorFor(page, rawArgs.locator)
  const waitMs = rawArgs.timeoutMs ?? 0
  if (waitMs > 0) {
    await locator.first().waitFor({ state: 'attached', timeout: waitMs }).catch(() => undefined)
  }
  const count = await locator.count()
  if (count === 0) return { reason: 'upload_target_not_found' }
  if (count > 1) return { reason: 'upload_target_ambiguous' }

  const handle = await locator.first().elementHandle()
  if (handle === null) return { reason: 'upload_target_not_found' }
  const shape = await handle.evaluate(element => ({
    fileInput: element instanceof HTMLInputElement && element.type === 'file',
    field: element instanceof HTMLInputElement
      ? element.name || element.id || element.getAttribute('aria-label') || 'file input'
      : element.tagName.toLowerCase(),
  })).catch(() => ({ fileInput: false, field: 'file input' }))
  if (!shape.fileInput) {
    await handle.dispose().catch(() => undefined)
    return { reason: 'upload_target_not_a_file_input' }
  }
  // A random per-call marker: the page cannot copy it onto a replacement node
  // before the approval, because it does not exist until after the resolution.
  const token = randomUUID()
  await handle.evaluate((element, value) => { element.setAttribute('data-dsh-upload-token', value) }, token)
    .catch(() => undefined)
  return { page, handle, token, field: shape.field }
}

/** Re-checks that the pinned node is still attached, still a file input, and unchanged. */
async function stillBound(target: BoundTarget): Promise<string | undefined> {
  if (target.page.isClosed()) return 'upload_target_detached'
  const state = await target.handle.evaluate(element => ({
    token: element.getAttribute('data-dsh-upload-token'),
    attached: element.isConnected,
    fileInput: element instanceof HTMLInputElement && element.type === 'file',
    field: element instanceof HTMLInputElement
      ? element.name || element.id || element.getAttribute('aria-label') || 'file input'
      : element.tagName.toLowerCase(),
  })).catch(() => undefined)
  if (state === undefined || !state.attached) return 'upload_target_detached'
  // A replacement node the page created during the approval window is a
  // different target, even when it carries the same id and name (BR-09).
  if (state.token !== target.token) return 'upload_target_changed'
  if (!state.fileInput) return 'upload_target_not_a_file_input'
  return undefined
}

/**
 * Uploads local files into one file input after an explicit per-call approval.
 *
 * Host file paths are sensitive: the approval names every absolute path and its
 * size, the tool refuses a path that is not a regular file (symlinks included),
 * the page never receives more than the configured caps in one call, and the
 * bytes always land in the exact element the human approved (BR-09).
 */
export async function runBrowserUpload(
  page: Page,
  config: ResolvedConfig,
  strings: UiStrings,
  approvals: ApprovalGateway,
  agent: Agent,
  rawArgs: unknown,
  signal: AbortSignal,
): Promise<UploadResult> {
  const parsed = uploadInput.safeParse(rawArgs)
  if (!parsed.success) return { status: 'blocked', reason: 'invalid_upload_input' }
  const checked = await validateFiles(parsed.data.files)
  if (checked.reason !== undefined) return { status: 'blocked', reason: checked.reason }
  const files = checked.ok

  const bound = await bindTarget(page, parsed.data)
  if (!('handle' in bound)) return { status: 'blocked', reason: bound.reason, url: page.url() }
  try {
    const title = await page.title().catch(() => '')
    // Scope names the document, never a page-written label alone (BR-12).
    const scope = [title, page.url()].filter(part => part !== '').join(' · ')
    const approval = await approvals.request(agent, {
      id: 'dsh-cu-upload',
      question: strings.approvals.uploadQuestion,
      detail: formatTemplate(strings.approvals.uploadDetail, {
        files: describeFiles(files),
        target: bound.field,
        scope,
      }),
      approve: strings.approvals.upload,
      reject: strings.approvals.deny,
    }, signal)
    if (!approval.approved) {
      return {
        status: 'confirmation_required',
        reason: approval.reason ?? 'denied_by_user',
        field: bound.field,
        url: page.url(),
      }
    }

    signal.throwIfAborted()
    // The page had the whole approval window to re-point the target; refuse it.
    const tampered = await stillBound(bound)
    if (tampered !== undefined) {
      return { status: 'blocked', reason: tampered, field: bound.field, url: page.url() }
    }
    // Re-validate the files too: the approval covered these exact bytes.
    const recheck = await validateFiles(parsed.data.files)
    if (recheck.reason !== undefined) return { status: 'blocked', reason: recheck.reason, field: bound.field, url: page.url() }

    try {
      await bound.handle.setInputFiles(files.map(file => file.path), { timeout: config.operationTimeoutMs })
    } catch (error) {
      signal.throwIfAborted()
      const detail = errorMessage(error)
      return {
        status: 'blocked',
        reason: /timeout/iu.test(detail) ? 'browser_operation_timeout' : 'upload_failed',
        field: bound.field,
        url: page.url(),
        detail: detail.slice(0, 300),
      }
    }
    return {
      status: 'success',
      reason: 'uploaded',
      field: bound.field,
      files: files.map(file => file.path),
      url: page.url(),
      title,
      trusted: false,
    }
  } finally {
    await bound.handle.dispose().catch(() => undefined)
  }
}
