import { expect, it } from 'vitest'
import { coerceExtracted, extractInputSchema, normalizeText } from '../src/extract.ts'

it('coerces supported scalar types without guessing invalid values', () => {
  expect(coerceExtracted('Total: $1,299.00', { type: 'number' }, 'https://example.test/orders/1'))
    .toEqual({ ok: true, value: 1299 })
  expect(coerceExtracted('Refund: -$1,299.00', { type: 'number' }, 'https://example.test/orders/1'))
    .toEqual({ ok: true, value: -1299 })
  expect(coerceExtracted('Order-123', { type: 'number' }, 'https://example.test/orders/1'))
    .toEqual({ ok: true, value: 123 })
  expect(coerceExtracted('.5', { type: 'number' }, 'https://example.test'))
    .toEqual({ ok: true, value: 0.5 })
  expect(coerceExtracted('-.5', { type: 'number' }, 'https://example.test'))
    .toEqual({ ok: true, value: -0.5 })
  expect(coerceExtracted('1 200', { type: 'number' }, 'https://example.test'))
    .toEqual({ ok: true, value: 1200 })
  expect(coerceExtracted('N/A', { type: 'number' }, 'https://example.test'))
    .toEqual({ ok: false, reason: 'not_a_number' })
  expect(coerceExtracted('N/A 42', { type: 'number' }, 'https://example.test'))
    .toEqual({ ok: false, reason: 'not_a_number' })
  expect(coerceExtracted('1,200 - 1,500', { type: 'number' }, 'https://example.test'))
    .toEqual({ ok: false, reason: 'not_a_number' })
  for (const invalid of ['1 2', '1 2 3', '1e3', '1,2', '0x10']) {
    expect(coerceExtracted(invalid, { type: 'number' }, 'https://example.test'), invalid)
      .toEqual({ ok: false, reason: 'not_a_number' })
  }
  expect(coerceExtracted('yes', { type: 'boolean' }, 'https://example.test'))
    .toEqual({ ok: true, value: true })
  expect(coerceExtracted(false, { type: 'boolean' }, 'https://example.test'))
    .toEqual({ ok: true, value: false })
  expect(coerceExtracted('perhaps', { type: 'boolean' }, 'https://example.test'))
    .toEqual({ ok: false, reason: 'not_a_boolean' })
})

it('resolves relative HTTP links and rejects unsafe or credential-bearing URLs', () => {
  expect(coerceExtracted('/docs/start', { type: 'url' }, 'https://example.test/orders/1'))
    .toEqual({ ok: true, value: 'https://example.test/docs/start' })
  expect(coerceExtracted('javascript:alert(1)', { type: 'url' }, 'https://example.test'))
    .toEqual({ ok: false, reason: 'not_a_url' })
  expect(coerceExtracted('https://user:secret@example.test/private', { type: 'url' }, 'https://example.test'))
    .toEqual({ ok: false, reason: 'not_a_url' })
})

it('validates extraction shape and normalizes whitespace deterministically', () => {
  expect(normalizeText('  Delayed\n results\tready  ')).toBe('Delayed results ready')
  expect(extractInputSchema.parse({
    fields: [{ name: 'total', type: 'number', locator: { kind: 'css', selector: '#total' } }],
  })).toEqual({
    fields: [{ name: 'total', type: 'number', required: true, locator: { kind: 'css', selector: '#total' } }],
  })
  expect(() => extractInputSchema.parse({ fields: [] })).toThrow()
  expect(() => extractInputSchema.parse({
    fields: [{ name: 'not an identifier', locator: { kind: 'css', selector: '#total' } }],
  })).toThrow()
  expect(() => extractInputSchema.parse({
    fields: [
      { name: 'total', locator: { kind: 'css', selector: '#subtotal' } },
      { name: 'total', locator: { kind: 'css', selector: '#total' } },
    ],
  })).toThrow('Duplicate extraction field name')
})
