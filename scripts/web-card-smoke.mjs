import { chromium } from 'playwright'
const url = process.argv[2]
if (!url) { console.error('usage: node scripts/web-card-smoke.mjs <dsh-web-url>'); process.exit(2) }
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
const cont = page.getByRole('button', { name: '继续' })
if (await cont.count() > 0) await cont.first().click()
await page.waitForTimeout(1000)

const composer = page.locator('div[contenteditable="true"]').first()
await composer.click()
await composer.type('请调用 browser_tabs 工具，action 设为 list，然后只回复标签页数量。', { delay: 10 })
await page.keyboard.press('Enter')

// Wait for a settled card: the preparing row appears first and carries no result.
const card = page.locator('[data-dsh-cu-card]:not([data-dsh-cu-status="running"])').first()
let appeared = false
try { await card.waitFor({ timeout: 120000 }); appeared = true } catch {}
console.log('CARD_APPEARED', appeared)
if (appeared) {
  console.log('CARD', (await card.innerText()).slice(0, 300).replace(/\n/g, ' | '))
  console.log('ATTRS', await card.getAttribute('data-dsh-cu-card'), await card.getAttribute('data-dsh-cu-status'))
}
await page.screenshot({ path: process.argv[3] ?? '/tmp/web-card.png', fullPage: false })
await browser.close()
process.exit(appeared ? 0 : 1)
