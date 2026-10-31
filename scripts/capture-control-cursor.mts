import { chromium } from 'playwright'
import { randomUUID } from 'node:crypto'
import { BrowserControlIndicator } from '../packages/dsh-browser-use-d1/src/indicator.ts'
import { BrowserDom } from '../packages/dsh-browser-use-d1/src/dom.ts'

const output = process.argv[2] ?? '/tmp/dsh-cu-cursor.png'
const dark = process.argv[3] === 'dark'
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } })
  await page.setContent(`<style>
    body { margin: 0; display: grid; place-items: center; height: 100vh; background: ${dark ? '#0f172a' : '#f8fafc'}; }
    button { width: 180px; height: 56px; border: 1px solid ${dark ? '#475569' : '#cbd5e1'}; border-radius: 12px;
      color: ${dark ? '#f8fafc' : '#0f172a'}; background: ${dark ? '#1e293b' : '#ffffff'}; font: 16px system-ui; }
  </style><button>Controlled action</button>`)
  const indicator = new BrowserControlIndicator(page, () => undefined)
  await indicator.start(randomUUID())
  const dom = new BrowserDom(page, 60, indicator)
  const snapshot = await dom.snapshot()
  await dom.execute(snapshot, { operation: 'CLICK', target: snapshot.elements[0].id }, 1000)
  await page.screenshot({ path: output })
  await indicator.close()
  console.log(output)
} finally {
  await browser.close()
}
