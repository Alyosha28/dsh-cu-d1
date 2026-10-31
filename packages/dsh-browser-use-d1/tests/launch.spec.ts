import { expect, it } from 'vitest'
import { launchControlledBrowser } from '../src/launch.ts'

it('keeps an explicit executablePath authoritative', async () => {
  await expect(launchControlledBrowser({ headless: true, executablePath: '/nonexistent/chrome' }))
    .rejects.toThrow(/nonexistent/u)
})

it('launches a controllable browser without a configured executable path', async () => {
  const browser = await launchControlledBrowser({ headless: true })
  try {
    expect(browser.isConnected()).toBe(true)
    const page = await browser.newPage()
    await page.setContent('<title>launch fixture</title><h1>ok</h1>')
    expect(await page.title()).toBe('launch fixture')
  } finally {
    await browser.close()
  }
})
