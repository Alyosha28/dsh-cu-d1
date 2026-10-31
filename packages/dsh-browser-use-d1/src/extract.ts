import type { Locator, Page } from 'playwright'
import {
  coerceExtracted,
  describeLocator,
  EXTRACT_DEFAULT_TIMEOUT_MS,
  EXTRACT_MAX_VALUES,
  extractInputSchema,
  normalizeText,
} from '@albaincompleta/dsh-cu-core/extract'
import type {
  ExtractField,
  ExtractFieldEvidence,
  ExtractLocator,
  ExtractResult,
} from '@albaincompleta/dsh-cu-core/extract'
import type { ExecutionHandle } from '@albaincompleta/dsh-cu-core/run-controller'
import type { ResolvedConfig } from './config.ts'
import { navigationUrl } from './dom.ts'
import { locatorFor } from './locators.ts'
import { readPageTitle } from './tab-marker.ts'
import { uiStrings } from '@albaincompleta/dsh-cu-core/locale'


async function readRawValue(
  locator: Locator,
  field: ExtractField,
  timeout: number,
): Promise<string | boolean | null> {
  if (field.attribute !== undefined) return locator.getAttribute(field.attribute, { timeout })
  const descriptor = await locator.evaluate(element => ({
    tag: element.tagName.toLowerCase(),
    inputType: element instanceof HTMLInputElement ? element.type : '',
  }), undefined, { timeout })
  if (descriptor.tag === 'input' && ['checkbox', 'radio'].includes(descriptor.inputType)) {
    return locator.isChecked({ timeout })
  }
  if (['input', 'textarea', 'select'].includes(descriptor.tag)) return locator.inputValue({ timeout })
  return locator.innerText({ timeout })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Playwright has no AbortSignal option; bound every browser wait explicitly. */
async function bounded<T>(operation: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  signal.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Browser extraction aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Browser extraction operation exceeded ${timeoutMs} ms`)), timeoutMs)
  })
  try {
    return await Promise.race([operation, aborted, timedOut])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Reads caller-addressed DOM values without invoking the decision model or
 * dispatching input. Missing, ambiguous, and uncoercible values fail closed.
 */
export async function runBrowserExtract(
  page: Page,
  config: ResolvedConfig,
  rawArgs: unknown,
  signal: AbortSignal,
  execution?: ExecutionHandle,
): Promise<ExtractResult> {
  const args = extractInputSchema.parse(rawArgs)
  const activeSignal = execution === undefined ? signal : AbortSignal.any([signal, execution.signal])
  const evidence: ExtractResult['evidence'] = {
    source: 'dom', trusted: false, url: page.url(), title: '', fields: [],
  }
  const admissionStop = execution?.admit()
  if (admissionStop !== null && admissionStop !== undefined) {
    return { status: admissionStop.status, reason: admissionStop.reason, evidence }
  }

  activeSignal.throwIfAborted()
  if (args.url !== undefined) {
    await bounded(page.goto(navigationUrl(args.url), {
      waitUntil: 'domcontentloaded', timeout: config.operationTimeoutMs,
    }), activeSignal, config.operationTimeoutMs)
  }
  evidence.url = page.url()
  evidence.title = await bounded(readPageTitle(page, uiStrings(config.locale).panel.tabMark), activeSignal, config.operationTimeoutMs)

  const deadline = Date.now() + (args.timeoutMs ?? EXTRACT_DEFAULT_TIMEOUT_MS)
  const data = Object.create(null) as Record<string, unknown>
  const missing: string[] = []
  const empty: string[] = []
  const requiredMissing: string[] = []
  const truncated: Array<{ field: string; count: number; returned: number }> = []

  for (const field of args.fields) {
    activeSignal.throwIfAborted()
    const fieldEvidence: ExtractFieldEvidence = {
      name: field.name,
      type: field.type,
      locator: describeLocator(field.locator),
      count: 0,
      ok: false,
    }
    evidence.fields.push(fieldEvidence)
    try {
      const locator = locatorFor(page, field.locator)
      let count = await bounded(locator.count(), activeSignal, config.operationTimeoutMs)
      if (count === 0 && field.required) {
        const remaining = deadline - Date.now()
        if (remaining > 0) {
          try {
            await bounded(locator.first().waitFor({ state: 'attached', timeout: remaining }), activeSignal, remaining)
          } catch {
            // The count below is authoritative; a timeout only means still absent.
          }
          activeSignal.throwIfAborted()
          count = await bounded(locator.count(), activeSignal, config.operationTimeoutMs)
        }
      }
      fieldEvidence.count = count

      if (count > 1 && field.all !== true) {
        fieldEvidence.reason = 'ambiguous'
        return {
          status: 'escalated', reason: 'extract_locator_ambiguous',
          details: { field: field.name, count, locator: fieldEvidence.locator }, evidence,
        }
      }

      const values: unknown[] = []
      let fieldMissing = count === 0
      let fieldEmpty = false
      const readCount = Math.min(count, EXTRACT_MAX_VALUES)
      if (count > EXTRACT_MAX_VALUES) truncated.push({ field: field.name, count, returned: readCount })

      for (let index = 0; index < readCount && !fieldMissing; index += 1) {
        activeSignal.throwIfAborted()
        const raw = await bounded(
          readRawValue(locator.nth(index), field, config.operationTimeoutMs),
          activeSignal,
          config.operationTimeoutMs,
        )
        // A null read means the element or attribute is absent. An empty string
        // means the element exists and its value is blank: that is data for a
        // string field, and an uncoercible value for every other type.
        if (raw === null) {
          fieldMissing = true
          break
        }
        if (typeof raw === 'string' && normalizeText(raw) === '') {
          if (field.type === 'string') {
            fieldEmpty = true
            values.push('')
            continue
          }
          fieldEvidence.reason = 'empty_value'
          fieldEvidence.empty = true
          return {
            status: 'blocked', reason: 'extract_field_invalid',
            details: { field: field.name, expectedType: field.type, reason: 'empty_value' }, evidence,
          }
        }
        const coerced = coerceExtracted(raw, field, page.url())
        if (!coerced.ok) {
          fieldEvidence.reason = coerced.reason
          return {
            status: 'blocked', reason: 'extract_field_invalid',
            details: { field: field.name, expectedType: field.type, reason: coerced.reason }, evidence,
          }
        }
        values.push(coerced.value)
      }

      if (fieldMissing) {
        fieldEvidence.reason = 'missing'
        missing.push(field.name)
        if (field.required) requiredMissing.push(field.name)
        continue
      }
      data[field.name] = field.all === true ? values : values[0]
      fieldEvidence.ok = true
      if (fieldEmpty) {
        fieldEvidence.empty = true
        empty.push(field.name)
      }
    } catch (error) {
      activeSignal.throwIfAborted()
      fieldEvidence.reason = 'read_failed'
      return {
        status: 'blocked', reason: 'extract_read_failed',
        details: { field: field.name, message: errorMessage(error).slice(0, 500) }, evidence,
      }
    }
  }

  if (requiredMissing.length > 0) {
    return {
      status: 'blocked', reason: 'extract_field_missing', missing,
      ...empty.length > 0 ? { empty } : {},
      details: { required: requiredMissing }, evidence,
    }
  }
  return {
    status: 'success',
    reason: missing.length > 0
      ? 'extracted_with_missing_optional_fields'
      : empty.length > 0 ? 'extracted_with_empty_fields' : 'extracted',
    data,
    ...missing.length > 0 ? { missing } : {},
    ...empty.length > 0 ? { empty } : {},
    ...truncated.length > 0 ? { details: { truncated } } : {},
    evidence,
  }
}
