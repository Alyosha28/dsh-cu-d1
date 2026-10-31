import { stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Page } from 'playwright'
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

const MAX_TOTAL_BYTES = 50 * 1024 * 1024

async function validateFiles(files: string[]): Promise<{ ok: string[]; reason?: string }> {
  let total = 0
  for (const file of files) {
    if (!isAbsolute(file)) return { ok: [], reason: 'upload_requires_absolute_paths' }
    try {
      const info = await stat(file)
      if (!info.isFile()) return { ok: [], reason: 'upload_target_is_not_a_file' }
      total += info.size
      if (total > MAX_TOTAL_BYTES) return { ok: [], reason: 'upload_exceeds_size_limit' }
    } catch {
      return { ok: [], reason: 'upload_file_not_found' }
    }
  }
  return { ok: files }
}

/**
 * Uploads local files into one file input after an explicit per-call approval.
 *
 * Host file paths are sensitive: the approval names every path, the tool refuses
 * a path that is not an existing regular file, and the page never receives more
 * than the configured cap in one call.
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

  const locator = locatorFor(page, parsed.data.locator)
  const waitMs = parsed.data.timeoutMs ?? 0
  if (waitMs > 0) {
    await locator.first().waitFor({ state: 'attached', timeout: waitMs }).catch(() => undefined)
  }
  const count = await locator.count()
  if (count === 0) return { status: 'blocked', reason: 'upload_target_not_found', url: page.url() }
  if (count > 1) return { status: 'blocked', reason: 'upload_target_ambiguous', url: page.url() }

  const isFileInput = await locator.evaluate(
    element => element instanceof HTMLInputElement && element.type === 'file',
  ).catch(() => false)
  if (!isFileInput) return { status: 'blocked', reason: 'upload_target_not_a_file_input', url: page.url() }

  const title = await page.title().catch(() => '')
  const field = await locator.evaluate(element => {
    const input = element as HTMLInputElement
    return input.name || input.id || input.getAttribute('aria-label') || 'file input'
  }).catch(() => 'file input')
  const approval = await approvals.request(agent, {
    id: 'dsh-cu-upload',
    question: strings.approvals.uploadQuestion,
    detail: formatTemplate(strings.approvals.uploadDetail, {
      files: parsed.data.files.map(file => basename(file)).join(', '),
      target: field,
      scope: title || page.url(),
    }),
    approve: strings.approvals.upload,
    reject: strings.approvals.deny,
  }, signal)
  if (!approval.approved) {
    return {
      status: 'confirmation_required',
      reason: approval.reason ?? 'denied_by_user',
      field,
      url: page.url(),
    }
  }

  signal.throwIfAborted()
  try {
    await locator.setInputFiles(parsed.data.files, { timeout: config.operationTimeoutMs })
  } catch (error) {
    signal.throwIfAborted()
    const detail = error instanceof Error ? error.message : String(error)
    return {
      status: 'blocked',
      reason: /timeout/iu.test(detail) ? 'browser_operation_timeout' : 'upload_failed',
      field,
      url: page.url(),
      detail: detail.slice(0, 300),
    }
  }
  return {
    status: 'success',
    reason: 'uploaded',
    field,
    files: parsed.data.files.map(file => basename(file)),
    url: page.url(),
    title,
    trusted: false,
  }
}
