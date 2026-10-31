import type { Locator, Page } from 'playwright'
import type { ExtractLocator } from '@dsh-cu/core/extract'

/** Resolves one explicit locator to a Playwright locator. */
export function locatorFor(page: Page, locator: ExtractLocator): Locator {
  if (locator.kind === 'label') return page.getByLabel(locator.text, { exact: true })
  if (locator.kind === 'role') {
    return page.getByRole(locator.role as Parameters<Page['getByRole']>[0], { name: locator.name })
  }
  if (locator.kind === 'text') return page.getByText(locator.text, { exact: locator.exact ?? false })
  return page.locator(locator.selector)
}
