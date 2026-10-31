import { z } from 'zod'
import { stripTabMarker } from './tab-marker.ts'
import type { BrowserContext, Page } from 'playwright'

export const tabsInput = z.object({
  action: z.enum(['list', 'select', 'open', 'close']),
  index: z.number().int().min(0).optional(),
  url: z.string().min(1).optional(),
}).strict()
export type TabsInput = z.infer<typeof tabsInput>

export interface TabInfo {
  index: number
  url: string
  title: string
  active: boolean
}

/** Lists every page in the controlled context with its current title. */
export async function describeTabs(context: BrowserContext, active: Page, mark?: string): Promise<TabInfo[]> {
  const pages = context.pages()
  return Promise.all(pages.map(async (page, index) => ({
    index,
    url: page.url(),
    title: stripTabMarker(await page.title().catch(() => ''), mark ?? ''),
    active: page === active,
  })))
}

/**
 * Resolves a tab by its current index. Indices are positions in
 * `context.pages()`, so a caller must re-list after closing or opening a tab.
 */
export function tabAt(context: BrowserContext, index: number): Page | undefined {
  return context.pages()[index]
}

/** Chooses the page a close should leave active: the previous one, else the next. */
export function neighbourOf(context: BrowserContext, closed: Page): Page | undefined {
  const pages = context.pages().filter(page => page !== closed)
  return pages.at(-1)
}
