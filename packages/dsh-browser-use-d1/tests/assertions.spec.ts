import { expect, it } from 'vitest'
import type { Page } from 'playwright'
import { assertSupportedAssertions, verifyAll } from '../src/dom.ts'

/** A page object that fails loudly if verification touches it. */
function inertPage(): Page {
  return new Proxy({}, {
    get() { throw new Error('verification must not touch the page') },
  }) as unknown as Page
}

it('rejects a custom assertion instead of silently satisfying it', () => {
  expect(() => assertSupportedAssertions([{ type: 'custom', name: 'workflow_state' }]))
    .toThrow(/custom handler "workflow_state"/u)
})

it('accepts the structured assertions the browser provider can evaluate', () => {
  expect(() => assertSupportedAssertions([
    { type: 'text_visible', text: 'Saved' },
    { type: 'url_contains', value: '/done' },
    { type: 'input_value', label: 'Email', value: 'a@b.test' },
    { type: 'checkbox', label: 'Nonstop only', checked: true },
  ])).not.toThrow()
})

it('never reports an unevaluated assertion as satisfied', async () => {
  expect(await verifyAll(inertPage(), [{ type: 'custom', name: 'workflow_state' }])).toBe(false)
})
