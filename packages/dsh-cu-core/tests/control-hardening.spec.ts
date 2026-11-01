/**
 * CR-07 — control plane: Host allow-list, 413 instead of a destroyed socket,
 * generic 500 bodies, audited privilege changes, page-token TTL.
 */
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AuditStore } from '../src/audit.ts'
import { ControlServer } from '../src/control-server.ts'
import { RunController } from '../src/run-controller.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup())) })

async function fixture(options: ConstructorParameters<typeof ControlServer>[3] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cu-control-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const agent = { id: 'agent-1' } as any
  const audit = new AuditStore(join(directory, 'audit.jsonl'))
  const controller = new RunController(audit)
  const server = new ControlServer(controller, agent, 'test-token', { locale: 'en', ...options })
  const base = await server.start()
  cleanups.push(() => server.close())
  return { server, controller, agent, base, audit, headers: { authorization: 'Bearer test-token' } }
}

/** Raw request so a forged Host header reaches the server unchanged. */
function raw(base: string, options: { method?: string; path?: string; host?: string; body?: string }): Promise<{ status: number; body: string; error?: string }> {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port: Number(url.port), method: options.method ?? 'GET', path: options.path ?? '/',
      headers: { ...options.host === undefined ? {} : { host: options.host }, authorization: 'Bearer test-token' },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.end(options.body)
    else req.end()
  })
}

it('rejects a non-loopback Host header', async () => {
  const { base } = await fixture()
  expect((await raw(base, { path: '/api/status', host: 'attacker.example' })).status).toBe(403)
  expect((await raw(base, { path: '/api/status', host: '127.0.0.1:1' })).status).toBe(200)
  expect((await raw(base, { path: '/api/status', host: 'localhost' })).status).toBe(200)
  expect((await raw(base, { path: '/api/status' })).status).toBe(200)
})

it('answers 413 to an oversized body instead of resetting the socket', async () => {
  const { base, controller } = await fixture({ removeSkill: async () => true })
  const response = await raw(base, {
    method: 'POST', path: '/api/skills/remove',
    body: JSON.stringify({ id: 'x'.repeat(20_000) }),
  })
  expect(response.status).toBe(413)
  expect(response.error).toBeUndefined()
  // The server stays usable afterwards.
  expect((await raw(base, { path: '/api/status' })).status).toBe(200)
  expect(controller.status).toBeDefined()
})

it('returns a generic 500 body and keeps the detail on the server log', async () => {
  const logged: unknown[][] = []
  const original = console.error
  console.error = ((...args: unknown[]) => { logged.push(args) }) as typeof console.error
  try {
    const { base } = await fixture({
      removeSkill: async () => { throw new Error('ENOENT /Users/alice/.dsh-cu/skills.json') },
    })
    const response = await raw(base, {
      method: 'POST', path: '/api/skills/remove', body: JSON.stringify({ id: 'skill_demo' }),
    })
    expect(response.status).toBe(500)
    expect(response.body).toBe(JSON.stringify({ error: 'internal_error' }))
    expect(JSON.stringify(logged)).toContain('skills.json')
  } finally {
    console.error = original
  }
})

it('audits a skill removal', async () => {
  const { base, controller, agent } = await fixture({ removeSkill: async id => id === 'skill_demo' })
  controller.start(agent, 'run')
  const response = await raw(base, { method: 'POST', path: '/api/skills/remove', body: JSON.stringify({ id: 'skill_demo' }) })
  expect(response.status).toBe(200)
  controller.finish(agent, 'success', 'independently_verified')
  const events = await controller.auditEvents()
  const removal = events.find(event => event.kind === 'skill_removed')
  expect(removal).toBeDefined()
  expect(JSON.stringify(removal)).not.toContain('skill_demo')
  expect(JSON.stringify(removal)).toMatch(/removed|true/u)
})

it('expires an unused page token', async () => {
  const { server, base, controller, agent } = await fixture()
  let now = Date.now()
  server.now = () => now
  controller.start(agent, 'run')
  const pageToken = server.pageToken
  const pageHeaders = { authorization: `Bearer ${pageToken}` }
  expect((await fetch(`${base}/api/status`, { headers: pageHeaders })).status).toBe(200)
  now += 31 * 60 * 1000
  const expired = await fetch(`${base}/api/status`, { headers: pageHeaders })
  // Reading further is refused; the panel falls back to the configured token.
  expect(expired.status).toBe(401)
  expect((await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer test-token' } })).status).toBe(200)
})

it('serves the credential-entry shell without a token and discloses nothing', async () => {
  const { base, server, controller, agent } = await fixture()
  controller.start(agent, 'run')
  // The panel is reachable unauthenticated: it is a credential entry form, and
  // the user has to be able to load it to paste a token at all.
  const shell = await fetch(base)
  expect(shell.status).toBe(200)
  const html = await shell.text()
  expect(html).toContain('Pause')
  // The shell must not leak any credential or run state.
  expect(html).not.toContain(server.pageToken)
  expect(html).not.toContain('test-token')
  expect(html).not.toContain('agent-1')
  // Every /api/* route stays credential-gated.
  expect((await fetch(`${base}/api/status`)).status).toBe(401)
  expect((await fetch(`${base}/api/audit`)).status).toBe(401)
  expect((await fetch(`${base}/api/skills`)).status).toBe(401)
  expect((await fetch(`${base}/api/stop`, { method: 'POST' })).status).toBe(401)
  // A forged Host is refused on the shell as well as on the API.
  expect((await raw(base, { path: '/', host: 'attacker.example' })).status).toBe(403)
  expect((await raw(base, { path: '/api/status', host: 'attacker.example' })).status).toBe(403)
})

it('exposes an authenticated control page through the fragment token flow', async () => {
  const { base, server, controller, agent } = await fixture()
  controller.start(agent, 'run')
  const shell = await fetch(base)
  expect(shell.status).toBe(200)
  // The page reads the per-server token from `#token=`, exchanges it for the API,
  // then scrubs the fragment from the address bar.
  expect(await shell.text()).toContain("location.hash.slice(1)")
  const status = await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${server.pageToken}` } })
  expect(status.status).toBe(200)
  expect(await status.json()).toMatchObject({ active: { status: 'running' } })
})
