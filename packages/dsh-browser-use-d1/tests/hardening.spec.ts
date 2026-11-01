/**
 * Blue-team regressions for the red-team browser findings (BR-01, BR-04, BR-05,
 * BR-06, BR-10, BR-14) plus sensitive-value masking.
 *
 * Every case drives the production code against a real Chromium page whose only
 * job is to be hostile: the page owns its own DOM, so it can re-point ids, copy
 * labels, sit on a redirect and write fake success text. The assertions below
 * encode the safe outcome, not the attack.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Browser } from 'playwright'
import { navigationUrl, StaleSnapshot, verifyAll } from '../src/dom.ts'
import { BrowserDom } from '../src/dom.ts'
import { runBrowserNavigate } from '../src/navigate.ts'
import { Config } from '../src/config.ts'
import { CHROME, close, fixtureServer, listen } from './fixtures.ts'
import type { Server } from 'node:http'

let browser: Browser
beforeAll(async () => {
  const { chromium } = await import('playwright')
  browser = await chromium.launch({ executablePath: CHROME, headless: true })
})
afterAll(async () => { await browser.close() })

/** A fresh page whose URL is a loopback fixture origin (url_contains needs an origin). */
async function fixturePage(server: Server, path: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${await listen(server)}${path}`)
  return page
}

async function setContent(html: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  await page.setContent(html)
  return page
}

// ---------------------------------------------------------------------------
// BR-01 — snapshot freshness must not be hosted by the page.
// ---------------------------------------------------------------------------

const TRAP = `
  <button id="real" type="button">Pay invoice</button>
  <button id="trap" type="button" style="position:absolute;top:160px;left:0">Delete everything</button>
  <script>
    window.__clicked = [];
    for (const id of ['real', 'trap']) {
      document.getElementById(id).addEventListener('click', () => window.__clicked.push(id));
    }
  </script>`

it('BR-01: refuses to click after the page moves the decision id to another element', async () => {
  const page = await setContent(TRAP)
  const dom = new BrowserDom(page)
  const snapshot = await dom.snapshot()
  const real = snapshot.elements.find(element => element.name === 'Pay invoice')!

  // The attribute-copy attack from the red-team report: steal the id off the
  // approved control and hand it to the trap. Nothing else changes.
  await page.evaluate(id => {
    document.getElementById('real')!.removeAttribute('data-dsh-decision-id')
    document.getElementById('trap')!.setAttribute('data-dsh-decision-id', id)
  }, real.id)

  await expect(dom.execute(snapshot, { operation: 'CLICK', target: real.id }, 1000))
    .rejects.toBeInstanceOf(StaleSnapshot)
  expect(await page.evaluate(() => (window as unknown as { __clicked: string[] }).__clicked)).toEqual([])
  await page.context().close()
})

it('BR-01: a page-frozen observer global cannot freeze the freshness version', async () => {
  const page = await setContent(TRAP)
  // One script tag at document start used to disable the observer for good.
  await page.evaluate(() => {
    ;(window as unknown as { __dshDecisionObserver: boolean }).__dshDecisionObserver = true
    ;(window as unknown as { __dshDecisionVersion: number }).__dshDecisionVersion = 0
  })
  const dom = new BrowserDom(page)
  const snapshot = await dom.snapshot()
  const real = snapshot.elements.find(element => element.name === 'Pay invoice')!

  await page.evaluate(id => {
    const replacement = document.createElement('button')
    replacement.textContent = 'Approve 5000 EUR'
    replacement.setAttribute('data-dsh-decision-id', id)
    replacement.addEventListener('click', () => {
      ;(window as unknown as { __substituted: number }).__substituted =
        ((window as unknown as { __substituted?: number }).__substituted ?? 0) + 1
    })
    document.getElementById('real')!.replaceWith(replacement)
  }, real.id)

  await expect(dom.execute(snapshot, { operation: 'CLICK', target: real.id }, 1000))
    .rejects.toBeInstanceOf(StaleSnapshot)
  expect(await page.evaluate(() => (window as unknown as { __substituted?: number }).__substituted)).toBeUndefined()
  await page.context().close()
})

it('BR-01: deleting the snapshot state turns every later action stale', async () => {
  const page = await setContent(TRAP)
  const dom = new BrowserDom(page)
  const snapshot = await dom.snapshot()
  const real = snapshot.elements.find(element => element.name === 'Pay invoice')!

  // The page cannot know the state key, so it deletes every attribute that is
  // not part of its own markup. State carried by the DOM therefore dies here.
  await page.evaluate(() => {
    for (const element of Array.from(document.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name.startsWith('data-dsh-')) element.removeAttribute(attribute.name)
      }
    }
  })

  await expect(dom.execute(snapshot, { operation: 'CLICK', target: real.id }, 1000))
    .rejects.toBeInstanceOf(StaleSnapshot)
  expect(await page.evaluate(() => (window as unknown as { __clicked: string[] }).__clicked)).toEqual([])
  await page.context().close()
})

it('BR-01: an untouched page still dispatches the observed target', async () => {
  const page = await setContent(TRAP)
  const dom = new BrowserDom(page)
  const snapshot = await dom.snapshot()
  const real = snapshot.elements.find(element => element.name === 'Pay invoice')!
  await dom.execute(snapshot, { operation: 'CLICK', target: real.id }, 1000)
  expect(await page.evaluate(() => (window as unknown as { __clicked: string[] }).__clicked)).toEqual(['real'])
  await page.context().close()
})

// ---------------------------------------------------------------------------
// BR-14 — ids must be unique and cannot survive into a later snapshot.
// ---------------------------------------------------------------------------

it('BR-14: a scrolled-out element never shares its id with a new target', async () => {
  const page = await setContent(`
    <button id="top" type="button">Top action</button>
    <div style="height:2200px"></div>
    <button id="bottom" type="button">Bottom action</button>
    <script>window.__clicked = []; document.querySelectorAll('button').forEach(
      button => button.addEventListener('click', () => window.__clicked.push(button.id)))</script>`)
  const dom = new BrowserDom(page)

  const first = await dom.snapshot()
  expect(first.elements.find(element => element.name === 'Top action')!.id).toBe('e1')

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  const second = await dom.snapshot()
  const bottom = second.elements.find(element => element.name === 'Bottom action')!
  expect(bottom.id).toBe('e1')

  // Exactly one node may answer any decision id at a time.
  expect(await page.evaluate(() => document.querySelectorAll('[data-dsh-decision-id]').length)).toBe(1)
  expect(await page.evaluate(() => document.querySelectorAll('[data-dsh-decision-id="e1"]').length)).toBe(1)

  await dom.execute(second, { operation: 'CLICK', target: bottom.id }, 1000)
  expect(await page.evaluate(() => (window as unknown as { __clicked: string[] }).__clicked)).toEqual(['bottom'])
  await page.context().close()
})

it('BR-14: a stale id from an earlier snapshot is rejected, not resolved to a new node', async () => {
  const page = await setContent(`
    <button id="top" type="button">Top action</button>
    <div style="height:2200px"></div>
    <button id="bottom" type="button">Bottom action</button>`)
  const dom = new BrowserDom(page)
  const first = await dom.snapshot()
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  const second = await dom.snapshot()
  await expect(dom.execute(first, { operation: 'CLICK', target: 'e1' }, 1000))
    .rejects.toBeInstanceOf(StaleSnapshot)
  // …and the current snapshot still works, so the guard is not a blanket denial.
  await dom.execute(second, { operation: 'CLICK', target: 'e1' }, 1000)
  await page.context().close()
})

// ---------------------------------------------------------------------------
// BR-04 — text_visible is an exact, visible, unique text match.
// ---------------------------------------------------------------------------

it('BR-04: a negated phrase does not satisfy the positive assertion', async () => {
  const page = await setContent(`
    <h1>Account</h1>
    <div role="alert">Not saved. The account was not deleted.</div>`)
  expect(await verifyAll(page, [{ type: 'text_visible', text: 'Saved' }])).toBe(false)
  expect(await verifyAll(page, [{ type: 'text_visible', text: 'deleted' }])).toBe(false)
  expect(await verifyAll(page, [{ type: 'text_visible', text: 'Not saved. The account was not deleted.' }])).toBe(true)
  await page.context().close()
})

it('BR-04: unrelated-region copy does not satisfy the assertion', async () => {
  const page = await setContent(`
    <main><h1>Checkout</h1><div role="alert">Payment declined</div></main>
    <footer>Demo store — an order confirmed here is only a sample.</footer>`)
  expect(await verifyAll(page, [{ type: 'text_visible', text: 'order confirmed' }])).toBe(false)
  await page.context().close()
})

it('BR-04: two visible copies of the text fail closed instead of picking the first', async () => {
  const page = await setContent(`
    <div data-template>Transfer complete</div>
    <main><div role="alert">Transfer complete</div></main>`)
  expect(await verifyAll(page, [{ type: 'text_visible', text: 'Transfer complete' }])).toBe(false)
  await page.context().close()
})

it('BR-04: a hidden copy alone never satisfies the assertion', async () => {
  const page = await setContent('<div style="display:none">Transfer complete</div><div>Transfer failed</div>')
  expect(await verifyAll(page, [{ type: 'text_visible', text: 'Transfer complete' }])).toBe(false)
  await page.context().close()
})

it('BR-04: whitespace is normalized on both sides before comparing', async () => {
  const page = await setContent('<div role="status">  Transfer\n   complete  </div>')
  expect(await verifyAll(page, [{ type: 'text_visible', text: 'Transfer complete' }])).toBe(true)
  // The hidden copy no longer doubles the match count for the normalized text.
  await page.context().close()
})

// ---------------------------------------------------------------------------
// BR-05 — input_value / checkbox bind to one visible, enabled element.
// ---------------------------------------------------------------------------

it('BR-05: a hidden labelled decoy does not satisfy input_value', async () => {
  const page = await setContent(`
    <h1>Transfer</h1>
    <div>Recipient email</div>
    <input id="recipient" type="email" placeholder="name@example.com">
    <input id="mirror" type="hidden" aria-label="Recipient email" value="attacker@evil.test">`)
  expect(await page.locator('#recipient').inputValue()).toBe('')
  expect(await verifyAll(page, [{ type: 'input_value', label: 'Recipient email', value: 'attacker@evil.test' }]))
    .toBe(false)
  await page.context().close()
})

it('BR-05: an off-screen labelled decoy does not satisfy input_value', async () => {
  const page = await setContent(`
    <div>Amount</div>
    <input id="amount" value="" placeholder="0.00">
    <input aria-label="Amount" value="10.00"
           style="position:absolute;left:-4000px;top:0;width:10px;height:10px">`)
  expect(await verifyAll(page, [{ type: 'input_value', label: 'Amount', value: '10.00' }])).toBe(false)
  await page.context().close()
})

it('BR-05: a hidden checked decoy does not satisfy checkbox', async () => {
  const page = await setContent(`
    <input id="agree" type="checkbox"><span>I accept the terms</span>
    <input type="checkbox" aria-label="I accept the terms" checked hidden>`)
  expect(await page.locator('#agree').isChecked()).toBe(false)
  expect(await verifyAll(page, [{ type: 'checkbox', label: 'I accept the terms', checked: true }])).toBe(false)
  await page.context().close()
})

it('BR-05: the visible, enabled element still satisfies the assertion', async () => {
  const fixture = fixtureServer()
  const page = await fixturePage(fixture, '/filters.html')
  await page.locator('#adults').fill('3')
  await page.locator('#nonstop').check()
  expect(await verifyAll(page, [{ type: 'input_value', label: 'Adults', value: '3' }])).toBe(true)
  expect(await verifyAll(page, [{ type: 'checkbox', label: 'Nonstop only', checked: true }])).toBe(true)
  // A disabled control is not evidence of anything.
  await page.evaluate(() => { document.querySelector<HTMLInputElement>('#adults')!.disabled = true })
  expect(await verifyAll(page, [{ type: 'input_value', label: 'Adults', value: '3' }])).toBe(false)
  await page.context().close()
  await close(fixture)
})

// ---------------------------------------------------------------------------
// BR-06 — url_contains is an origin + path-boundary match.
// ---------------------------------------------------------------------------

it('BR-06: a look-alike host does not satisfy an origin assertion', async () => {
  const page = await browser.newPage()
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<h1>harness</h1>' }))
  await page.goto('https://example.com.account-verify.test/steal')
  expect(await verifyAll(page, [{ type: 'url_contains', value: 'example.com' }])).toBe(false)
  await page.context().close()
})

it('BR-06: a query parameter carrying the expected URL does not satisfy the assertion', async () => {
  const page = await browser.newPage()
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<h1>harness</h1>' }))
  await page.goto('https://evil.test/phish?next=https://example.com/dashboard')
  expect(await verifyAll(page, [{ type: 'url_contains', value: 'https://example.com/dashboard' }])).toBe(false)
  await page.context().close()
})

it('BR-06: a userinfo trick does not satisfy an origin assertion', async () => {
  const page = await browser.newPage()
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<h1>harness</h1>' }))
  await page.goto('https://evil.test//a.com@evil/dashboard')
  expect(await verifyAll(page, [{ type: 'url_contains', value: 'a.com' }])).toBe(false)
  await page.context().close()
})

it('BR-06: the real origin and path prefix still satisfy the assertion', async () => {
  const page = await browser.newPage()
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<h1>harness</h1>' }))
  await page.goto('https://example.com/dashboard/reports?id=3')
  expect(await verifyAll(page, [{ type: 'url_contains', value: 'https://example.com' }])).toBe(true)
  expect(await verifyAll(page, [{ type: 'url_contains', value: 'example.com' }])).toBe(true)
  expect(await verifyAll(page, [{ type: 'url_contains', value: '/dashboard' }])).toBe(true)
  expect(await verifyAll(page, [{ type: 'url_contains', value: '/dash' }])).toBe(false)
  expect(await verifyAll(page, [{ type: 'url_contains', value: '/other' }])).toBe(false)
  await page.context().close()
})

// ---------------------------------------------------------------------------
// BR-10 — cloud metadata endpoints are unreachable, before and after redirects.
// ---------------------------------------------------------------------------

it('BR-10: metadata endpoints are rejected at the navigation boundary', () => {
  expect(navigationUrl('http://127.0.0.1:9200/_cat/indices')).toBe('http://127.0.0.1:9200/_cat/indices')
  for (const url of [
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://169.254.170.2/creds',
    'http://100.100.100.200/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://[fe80::1]/',
  ]) {
    expect(() => navigationUrl(url)).toThrow(/metadata/iu)
  }
})

it('BR-10: a redirect into a metadata endpoint fails closed after the hop', async () => {
  const { createServer } = await import('node:http')
  const redirect: Server = createServer((_request, response) => {
    response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
    response.end()
  })
  await new Promise<void>(resolve => { redirect.listen(0, '127.0.0.1', resolve) })
  const address = redirect.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  const page = await browser.newPage()
  try {
    const result = await runBrowserNavigate(
      page, Config({ mode: 'launch', decisionToken: 't' }),
      { url: `http://127.0.0.1:${address.port}/` }, new AbortController().signal,
    )
    expect(result).toMatchObject({ status: 'blocked', reason: 'navigation_blocked_destination' })
  } finally {
    await page.context().close()
    await close(redirect)
  }
})

it('BR-10: verification fails closed when the page sits on a metadata endpoint', async () => {
  const page = await browser.newPage()
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<h1>meta</h1>' }))
  await page.goto('http://169.254.169.254/latest/meta-data/')
  expect(await verifyAll(page, [{ type: 'text_visible', text: 'meta' }])).toBe(false)
  await page.context().close()
})

// ---------------------------------------------------------------------------
// Sensitive values never leave the page in a snapshot.
// ---------------------------------------------------------------------------

it('masks secret field values but keeps the metadata policy needs', async () => {
  const page = await setContent(`
    <form>
      <label for="user">User</label>
      <input id="user" name="user" value="ada">
      <label for="pass">Password</label>
      <input id="pass" name="pass" type="password" value="hunter2-correct-horse">
      <label for="pin">PIN</label>
      <input id="pin" name="pin" value="4821">
    </form>`)
  const dom = new BrowserDom(page)
  const snapshot = await dom.snapshot()
  const byName = (name: string) => snapshot.elements.find(element => element.name === name)!
  expect(byName('User').value).toBe('ada')
  expect(byName('Password').value).not.toContain('hunter2')
  expect(byName('PIN').value).not.toContain('4821')
  // Input type survives masking: the credential gate depends on it.
  expect(byName('Password').inputType).toBe('password')
  expect(byName('PIN').autocomplete ?? '').toBe('')
  await page.context().close()
})

it('keeps the inlined page classifier in agreement with the core policy', async () => {
  const { isSensitiveInput } = await import('@albaincompleta/dsh-cu-core/policy')
  const page = await setContent(`
    <form>
      <label for="a">Full name</label><input id="a" autocomplete="name" value="Ada">
      <label for="b">Password</label><input id="b" type="password" value="x">
      <label for="c">Card number</label><input id="c" value="4111">
      <label for="d">Verification code</label><input id="d" value="123456">
      <label for="e">City</label><input id="e" value="Zürich">
      <input id="f" aria-label="OTP" value="999">
      <textarea id="g" aria-label="Notes">hello</textarea>
      <select id="h" aria-label="Country"><option>CH</option></select>
    </form>`)
  const snapshot = await new BrowserDom(page).snapshot()
  const expected = snapshot.elements.filter(element => isSensitiveInput(element)).map(element => element.id).sort()
  const masked = snapshot.elements.filter(element => element.sensitive === true).map(element => element.id).sort()
  expect(masked).toEqual(expected)
  // A masked value is never the raw secret, and a non-secret keeps its value.
  for (const element of snapshot.elements) {
    if (element.sensitive === true && element.value !== null) {
      expect(element.value).not.toMatch(/^x$|^4111$|^123456$|^999$/u)
    }
  }
  expect(snapshot.elements.find(element => element.id === 'e1')?.value).toBe('Ada')
  await page.context().close()
})
