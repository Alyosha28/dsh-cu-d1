import { chromium } from 'playwright'
import type { Browser } from 'playwright'

/** A launch failure the caller can explain to the user instead of retrying blindly. */
export class BrowserUnavailableError extends Error {
  readonly code = 'browser_unavailable'

  constructor(readonly detail: string) {
    super(`browser_unavailable: ${detail}`)
    this.name = 'BrowserUnavailableError'
  }
}

const MISSING_BROWSER = /Executable doesn't exist|Looks like Playwright was just installed|browserType\.launch:.*not found/iu

export interface LaunchOptions {
  headless: boolean
  executablePath?: string
}

/**
 * Launches Chromium for a controlled run.
 *
 * Playwright's own browser build is optional: many machines have Google Chrome
 * or Edge installed but never ran `playwright install`. A missing bundled build
 * falls back to an installed browser channel before giving up, so the plugin
 * works with the browser the user already has. A configured executablePath is
 * authoritative and never falls back.
 */
export async function launchControlledBrowser(options: LaunchOptions): Promise<Browser> {
  const base = { headless: options.headless }
  if (options.executablePath !== undefined) {
    return chromium.launch({ ...base, executablePath: options.executablePath })
  }
  try {
    return await chromium.launch(base)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!MISSING_BROWSER.test(message)) throw error
  }
  const failures: string[] = []
  for (const channel of ['chrome', 'msedge'] as const) {
    try {
      return await chromium.launch({ ...base, channel })
    } catch (error) {
      failures.push(`${channel}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }
  throw new BrowserUnavailableError(
    `no Chromium build is available; run "npx playwright install chromium", install Google Chrome, or set executablePath. ${failures.join('; ')}`,
  )
}
