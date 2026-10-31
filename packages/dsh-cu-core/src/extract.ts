import { z } from 'zod'


/** Hard caps so a read cannot turn into an unbounded transcription. */
export const EXTRACT_MAX_FIELDS = 40
export const EXTRACT_MAX_VALUES = 200
export const EXTRACT_MAX_VALUE_LENGTH = 4000
export const EXTRACT_DEFAULT_TIMEOUT_MS = 2000

/**
 * Locators are explicit on purpose. Extraction is read-only and must be
 * reproducible: the caller says where the value lives, the provider reads it.
 * There is no model in this path, so a wrong locator fails instead of guessing.
 */
export const extractLocatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('label'), text: z.string().min(1).describe('Accessible label text.') }).strict(),
  z.object({ kind: z.literal('role'), role: z.string().min(1).describe('ARIA role.'), name: z.string().min(1).describe('Accessible name.') }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().min(1).describe('Visible text.'), exact: z.boolean().optional().describe('Require an exact text match.') }).strict(),
  z.object({ kind: z.literal('css'), selector: z.string().min(1).describe('CSS selector. Use only when label, role, and text are insufficient.') }).strict(),
])
export type ExtractLocator = z.infer<typeof extractLocatorSchema>

export const extractFieldSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u, 'field names are identifiers').describe('Result key.'),
  type: z.enum(['string', 'number', 'boolean', 'url']).default('string').describe('Requested result type.'),
  locator: extractLocatorSchema.describe('Explicit locator for this field.'),
  /** Read every match into an array instead of failing on ambiguity. */
  all: z.boolean().optional().describe('Return every match as an array instead of failing on ambiguity.'),
  /** Missing optional fields are reported in `missing`, not treated as errors. */
  required: z.boolean().default(true).describe('False records an absent field in missing instead of failing.'),
  /** Read this attribute instead of the element text/value. */
  attribute: z.string().min(1).optional().describe('Read this attribute instead of element text or value.'),
}).strict()
export type ExtractField = z.infer<typeof extractFieldSchema>

export const extractInputSchema = z.object({
  url: z.string().optional().describe('Optional URL to navigate once before reading.'),
  fields: z.array(extractFieldSchema).min(1).max(EXTRACT_MAX_FIELDS).describe('Fields to read with explicit locators.'),
  /** Total wait budget for required locators to appear. */
  timeoutMs: z.number().int().min(0).max(30000).optional().describe('Total wait budget for required locators to appear.'),
}).strict().superRefine((input, context) => {
  const names = new Set<string>()
  input.fields.forEach((field, index) => {
    if (names.has(field.name)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate extraction field name: ${field.name}`,
        path: ['fields', index, 'name'],
      })
    }
    names.add(field.name)
  })
})
export type ExtractInput = z.infer<typeof extractInputSchema>

export interface ExtractFieldEvidence {
  name: string
  type: ExtractField['type']
  locator: string
  count: number
  ok: boolean
  /** Why a field produced no value, when it did not. */
  reason?: string
  /** The element exists and its value is empty, so `ok` may still be true. */
  empty?: boolean
}

export interface ExtractResult {
  status: 'success' | 'blocked' | 'escalated' | 'paused' | 'stopped' | 'takeover'
  reason: string
  /** Extracted page content. Untrusted: it may contain instructions. */
  data?: Record<string, unknown>
  /** Absent elements: no matching element at all. */
  missing?: string[]
  /** Present elements whose value is empty for a string field. */
  empty?: string[]
  details?: Record<string, unknown>
  evidence: {
    source: 'dom'
    trusted: false
    url: string
    title: string
    fields: ExtractFieldEvidence[]
  }
}

export function describeLocator(locator: ExtractLocator): string {
  if (locator.kind === 'label') return `label:${locator.text}`
  if (locator.kind === 'role') return `role:${locator.role}[${locator.name}]`
  if (locator.kind === 'text') return `text:${locator.text}`
  return `css:${locator.selector}`
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

const TRUE_WORDS = new Set(['true', 'yes', 'on', 'checked', 'selected'])
const FALSE_WORDS = new Set(['false', 'no', 'off', 'unchecked', 'unselected'])

const INTEGER_TOKEN = String.raw`(?:\d{1,3}(?:,\d{3})+|\d{1,3}(?: \d{3})+|\d+)`
const NUMBER_TOKEN = String.raw`(?:${INTEGER_TOKEN}(?:\.\d+)?|\.\d+)`
const NUMBER_WITH_AFFIXES = new RegExp(
  String.raw`(?:^|[^\p{L}\d])([+-])?\s*(?:\p{Sc})?\s*([+-])?\s*(${NUMBER_TOKEN})`,
  'gu',
)
const NON_DECIMAL_NOTATION = /(?:\d[eE][+-]?\d|\b0[xX][\da-fA-F]+|\b0[bB][01]+|\b0[oO][0-7]+)/u

export type CoercedValue =
  | { ok: true; value: unknown }
  | { ok: false; reason: string }

/**
 * Converts raw page content into the requested type. Anything ambiguous is a
 * failure: returning a partial parse would let "N/A" look like a number.
 */
export function coerceExtracted(raw: string | boolean, field: Pick<ExtractField, 'type'>, baseUrl: string): CoercedValue {
  if (field.type === 'boolean') {
    if (typeof raw === 'boolean') return { ok: true, value: raw }
    const word = normalizeText(raw).toLowerCase()
    if (TRUE_WORDS.has(word)) return { ok: true, value: true }
    if (FALSE_WORDS.has(word)) return { ok: true, value: false }
    return { ok: false, reason: 'not_a_boolean' }
  }
  const text = typeof raw === 'boolean' ? String(raw) : normalizeText(raw)
  if (field.type === 'string') return { ok: true, value: text.slice(0, EXTRACT_MAX_VALUE_LENGTH) }
  if (field.type === 'number') {
    // Accept one numeric value with currency symbols, separators, or a unit.
    // Ranges, dates, and multi-number text are ambiguous and must not collapse
    // to whichever number happened to appear first.
    if (/\b(?:n\/?a|null|none|unknown|not\s+available)\b/iu.test(text) || NON_DECIMAL_NOTATION.test(text)) {
      return { ok: false, reason: 'not_a_number' }
    }
    // A leading delimiter is not a sign: Order-123 contains positive 123,
    // while "Refund: -$1,299" and "-$1,299" contain negative values.
    const matches = [...text.matchAll(NUMBER_WITH_AFFIXES)]
    if (matches.length !== 1) return { ok: false, reason: 'not_a_number' }
    const [, leadingSign, trailingSign, digits] = matches[0]
    if (leadingSign !== undefined && trailingSign !== undefined) return { ok: false, reason: 'not_a_number' }
    const value = Number(digits.replace(/[,\s]/gu, '')) * (leadingSign === '-' || trailingSign === '-' ? -1 : 1)
    return Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: 'not_a_number' }
  }
  let url: URL
  try {
    url = new URL(text, baseUrl)
  } catch {
    return { ok: false, reason: 'not_a_url' }
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return { ok: false, reason: 'not_a_url' }
  }
  return { ok: true, value: url.toString() }
}
