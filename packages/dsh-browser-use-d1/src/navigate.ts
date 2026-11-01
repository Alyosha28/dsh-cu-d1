import { z } from 'zod'
import { isBlockedDestinationError, isMetadataDestination, navigationUrl } from './dom.ts'
import { readPageTitle } from './tab-marker.ts'
import { uiStrings } from '@albaincompleta/dsh-cu-core/locale'
import type { ResolvedConfig } from './config.ts'
import type { Page } from 'playwright'

export const navigateInput = z.object({
  url: z.string().min(1).describe('HTTP(S) URL to open in the controlled page.'),
  waitUntil: z.enum(['domcontentloaded', 'load']).default('domcontentloaded')
    .describe('Navigation readiness event.'),
}).strict()

export interface NavigateResult {
  status: 'success' | 'blocked' | 'escalated'
  reason: string
  url?: string
  title?: string
  /** Page titles are page content, never instructions. */
  trusted?: false
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Navigates the owned page without a decision call. The URL must be HTTP(S)
 * without embedded credentials; anything else is refused instead of coerced.
 */
export async function runBrowserNavigate(
  page: Page,
  config: ResolvedConfig,
  rawArgs: unknown,
  signal: AbortSignal,
): Promise<NavigateResult> {
  const parsed = navigateInput.safeParse(rawArgs)
  if (!parsed.success) {
    return { status: 'blocked', reason: 'invalid_navigation_input', url: page.url() }
  }
  let target: string
  try {
    target = navigationUrl(parsed.data.url)
  } catch {
    return { status: 'blocked', reason: 'invalid_navigation_url', url: page.url() }
  }
  signal.throwIfAborted()
  try {
    await page.goto(target, { waitUntil: parsed.data.waitUntil, timeout: config.operationTimeoutMs })
  } catch (error) {
    signal.throwIfAborted()
    // A redirect into an unreachable/forbidden destination surfaces as a
    // navigation failure; report it as the destination refusal it is (BR-10).
    const landed = page.url()
    if (isMetadataDestination(landed) || (landed === 'about:blank' && isBlockedDestinationError(error))) {
      return { status: 'blocked', reason: 'navigation_blocked_destination', url: landed }
    }
    const detail = message(error)
    return {
      status: 'escalated',
      reason: /timeout/iu.test(detail) ? 'browser_operation_timeout' : 'navigation_failed',
      url: landed,
    }
  }
  // A 302 can land anywhere: the destination policy is re-applied to the URL the
  // browser actually reached, not only to the URL the caller asked for (BR-10).
  if (isMetadataDestination(page.url())) {
    return { status: 'blocked', reason: 'navigation_blocked_destination', url: page.url() }
  }
  const title = await readPageTitle(page, uiStrings(config.locale).panel.tabMark)
  return { status: 'success', reason: 'navigated', url: page.url(), title, trusted: false }
}
