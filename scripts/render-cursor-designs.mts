import { chromium } from 'playwright'

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto('file:///tmp/dsh-cu-cursor-studio.html')
  await page.screenshot({ path: '/tmp/dsh-cu-cursor-studio.png', fullPage: true })
  await page.setViewportSize({ width: 400, height: 850 })
  await page.screenshot({ path: '/tmp/dsh-cu-cursor-studio-phone.png', fullPage: true })
  console.log(JSON.stringify({
    title: await page.title(),
    horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
  }))
} finally {
  await browser.close()
}
