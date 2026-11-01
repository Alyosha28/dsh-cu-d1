import type { Locator, Page } from 'playwright'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalGateway } from '@albaincompleta/dsh-cu-core/approvals'
import { isSensitiveInput } from '@albaincompleta/dsh-cu-core/policy'
import type { ObservedElement } from '@albaincompleta/dsh-cu-core/types'
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

/** Placeholder returned instead of a secret value (BR-16). */
export const REDACTED = '[redacted]'

/**
 * Minimal element description for the `isSensitiveInput` heuristic, read from
 * the resolved node so the decision never depends on how the caller located it.
 */
async function describeElement(locator: Locator, timeout: number): Promise<ObservedElement> {

  const descriptor = await locator.evaluate(element => {
    const input = element instanceof HTMLInputElement ? element : undefined
    const labels = 'labels' in element && element.labels !== null
      ? Array.from((element as HTMLInputElement).labels ?? []).map(label => label.textContent ?? '').join(' ')
      : ''
    // Text visible in the document (own attributes, label, ancestor copy) is
    // what a human would use to recognise the field.
    return {
      name: [
        input?.name ?? '', input?.placeholder ?? '', labels.trim(),
        (element.parentElement?.textContent ?? '').trim().slice(0, 120),
      ].filter(part => part !== '').join(' '),
      identifier: element.id || undefined,
      inputType: input?.type,
      context: [
        `autocomplete=${input?.getAttribute('autocomplete') ?? ''}`,
        `type=${input?.type ?? element.tagName.toLowerCase()}`,
        `aria-label=${element.getAttribute('aria-label') ?? ''}`,
        `title=${element.getAttribute('title') ?? ''}`,
      ].join(' '),
    }
  }, undefined, { timeout })
  return {
    id: 'extract', role: 'textbox', value: null, actions: [], enabled: true, focused: false,
    ...descriptor,
  }
}

/**
 * A hidden input is only "hidden" in CSS; its value is still a live token in the
 * DOM. Values whose name/autocomplete names a secret (CSRF, token, session,
 * password...) are treated as sensitive even though they are not typed fields.
 */
const HIDDEN_SECRET_PATTERN = /csrf|xsrf|token|secret|session|password|passwd|api[-_]?key|auth|signature|nonce|bearer/iu

/**
 * A hidden input is named, not labelled: only the `name`/`id` attribute may
 * decide, so a `#returnTo` field stays readable while `name="csrf"` does not.
 */
function hiddenSecret(descriptor: { tag: string; inputType: string; name: string; identifier: string }): boolean {
  // `inputType` may be `null` for a resolved node, so compare case-insensitively
  // on a string rather than trusting the exact literal.
  if (descriptor.tag !== 'input' || (descriptor.inputType ?? '').toLowerCase() !== 'hidden') return false
  return HIDDEN_SECRET_PATTERN.test(descriptor.name) || HIDDEN_SECRET_PATTERN.test(descriptor.identifier)
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

interface ApprovalLabels { question: string; approve: string; reject: string }

/**
 * Labels for the per-field release prompt, keyed by the provider locale, so the
 * read gate is localisable without touching the shared locale bundle (which the
 * supply owner rewrites for the tool catalogue).
 */
const APPROVAL_LABELS: ApprovalLabels = {
  question: 'Allow reading the value of this secret field into the model context?',
  approve: 'Allow this field',
  reject: 'Keep it redacted',
}

/**
 * Asks once for one field. No gateway or no agent means no release: the caller
 * still gets the redacted placeholder instead of a failure (BR-16).
 */
async function requestSensitiveRead(
  approvals: ApprovalGateway | undefined,
  agent: Agent | undefined,
  locator: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (approvals === undefined || agent === undefined) return false
  const labels = APPROVAL_LABELS
  const response = await approvals.request(agent, {
    id: 'dsh-cu-sensitive-read',
    question: labels.question,
    detail: `${locator}`,
    approve: labels.approve,
    reject: labels.reject,
  }, signal)
  return response.approved
}

/**
 * Reads caller-addressed DOM values without invoking the decision model or
 * dispatching input. Missing, ambiguous, and uncoercible values fail closed.
 * Sensitive values (password/PIN/card/one-time-code fields and secret hidden
 * inputs) come back as `[redacted]` unless provider config or a one-field
 * approval releases them (BR-16).
 */
export async function runBrowserExtract(
  page: Page,
  config: ResolvedConfig,
  rawArgs: unknown,
  signal: AbortSignal,
  execution?: ExecutionHandle,
  approvals?: ApprovalGateway,
  agent?: Agent,
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
  // One approval covers one field once (BR-16): values are released only while
  // this run is authorised for that field, by provider config or by a prompt.
  const preauthorized = (config as ResolvedConfig & { allowSensitiveRead?: boolean }).allowSensitiveRead === true
  const released = new Set<string>()
  const data = Object.create(null) as Record<string, unknown>
  const missing: string[] = []
  const empty: string[] = []
  const requiredMissing: string[] = []
  const truncated: Array<{ field: string; count: number; returned: number }> = []
  const redacted: string[] = []

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

      // Sensitivity is decided from the resolved element, never from the
      // caller's locator or field name.
      let sensitive = false
      if (count > 0) {
        const first = locator.first()
        const observed = await bounded(describeElement(first, config.operationTimeoutMs), activeSignal, config.operationTimeoutMs)
          .catch(() => undefined)
        if (observed !== undefined) {
          sensitive = isSensitiveInput(observed) || (observed.inputType ?? '') === 'password'
            || /(?:password|one-time-code|current-password|new-password|cc-number|cc-csc)/u
              .test(observed.context ?? '')
          if (!sensitive) {
            const shape = await bounded(first.evaluate(element => ({
              tag: element.tagName.toLowerCase(),
              inputType: element instanceof HTMLInputElement ? element.type : '',
              name: element.getAttribute('name') ?? '',
              identifier: element.id,
            }), undefined, { timeout: config.operationTimeoutMs }), activeSignal, config.operationTimeoutMs)
              .catch(() => undefined)
            if (shape !== undefined) sensitive = hiddenSecret(shape)
          }
        }
      }
      let redactedCount = 0
      if (sensitive && !preauthorized) {
        const approved = await requestSensitiveRead(approvals, agent, fieldEvidence.locator, activeSignal)
        if (approved) released.add(field.name)
        else fieldEvidence.reason = 'sensitive_redacted'
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
        if (sensitive && !released.has(field.name) && !preauthorized) {
          // Keep the shape of the answer, never the secret.
          if (typeof raw === 'boolean') values.push(raw)
          else { values.push(REDACTED); redactedCount += 1 }
          continue
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
      if (redactedCount > 0 && fieldEvidence.reason === undefined) fieldEvidence.reason = 'sensitive_redacted'
      if (redactedCount > 0) redacted.push(field.name)
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
    ...redacted.length > 0 ? { redacted } : {},
    ...missing.length > 0 ? { missing } : {},
    ...empty.length > 0 ? { empty } : {},
    ...truncated.length > 0 ? { details: { truncated } } : {},
    evidence,
  }
}
