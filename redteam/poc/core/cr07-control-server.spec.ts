/**
 * CR-07 — Control plane: unauthenticated page, no Host validation, unlogged
 * mutations, internal error echo, and a body-limit path that destroys the socket.
 *
 * Contract under test: ARCHITECTURE_PLAN.md §8 ("审计只保存白名单操作字段"), the
 * ControlServer doc comment ("the configured control token never enters a tool
 * result URL") and README's control-panel description.
 */
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AuditStore } from '../../../packages/dsh-cu-core/src/audit.ts'
import { ControlServer } from '../../../packages/dsh-cu-core/src/control-server.ts'
import { RunController } from '../../../packages/dsh-cu-core/src/run-controller.ts'

const agent = { id: 'agent-control' } as any
const TOKEN = 'control-token-7d1f'
const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
})

interface Reply { status: number; headers: Record<string, unknown>; body: string }

function call(url: string, path: string, options: {
  method?: string
  token?: string
  host?: string
  body?: string
} = {}): Promise<Reply> {
  const target = new URL(path, url)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: options.method ?? 'GET',
      headers: {
        ...options.host === undefined ? {} : { host: options.host },
        ...options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
        ...options.body === undefined ? {} : {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(options.body),
        },
      },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk as Buffer))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers as Record<string, unknown>,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

async function server(options: { removeSkill?: (id: string) => Promise<boolean> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cr07-'))
  dirs.push(dir)
  const audit = new AuditStore(join(dir, 'audit.jsonl'))
  const controller = new RunController(audit)
  const removed: string[] = []
  const control = new ControlServer(controller, agent, TOKEN, {
    locale: 'en',
    listSkills: async () => [],
    removeSkill: options.removeSkill ?? (async id => { removed.push(id); return true }),
    permissionStatus: async () => ({ accessibility: true, screenRecording: false }),
    openPermission: async () => undefined,
  })
  const url = await control.start(0)
  return { control, controller, url, removed }
}

describe('CR-07 control server', () => {
  it('serves the control page to any caller, with no Host check', async () => {
    const { control, url } = await server()
    try {
      const plain = await call(url, '/')
      expect(plain.status).toBe(200)
      expect(plain.body).toContain('<title>')

      const rebound = await call(url, '/', { host: 'attacker.example' })
      expect(rebound.status).toBe(200)   // DNS-rebinding host accepted

      expect((await call(url, '/favicon.ico')).status).toBe(204)
    } finally {
      await control.close()
    }
  })

  it('the API is header-gated, and responses carry no CORS grant', async () => {
    const { control, url } = await server()
    try {
      const anonymous = await call(url, '/api/status')
      expect(anonymous.status).toBe(401)
      expect(anonymous.headers['access-control-allow-origin']).toBeUndefined()

      // A rebound host with a stolen bearer token is served normally.
      const rebound = await call(url, '/api/status', { token: TOKEN, host: 'attacker.example' })
      expect(rebound.status).toBe(200)
      expect(rebound.headers['access-control-allow-origin']).toBeUndefined()

      // Exact-string routing: a query string 404s a valid authenticated call.
      expect((await call(url, '/api/status?x=1', { token: TOKEN })).status).toBe(404)
    } finally {
      await control.close()
    }
  })

  it('skill deletion is a privileged mutation that writes no audit event', async () => {
    const { control, controller, url, removed } = await server()
    try {
      const reply = await call(url, '/api/skills/remove', { method: 'POST', token: TOKEN, body: JSON.stringify({ id: 'skill_published' }) })
      expect(reply.status).toBe(200)
      expect(removed).toEqual(['skill_published'])
      expect(await controller.auditEvents()).toEqual([])   // nothing recorded
    } finally {
      await control.close()
    }
  })

  it('internal error text is echoed to the client', async () => {
    const { control, url } = await server({
      removeSkill: async () => { throw new Error('ENOENT: no such file or directory, open \'/Users/alice/.dsh-cu/skills.json\'') },
    })
    try {
      const reply = await call(url, '/api/skills/remove', { method: 'POST', token: TOKEN, body: JSON.stringify({ id: 'x' }) })
      expect(reply.status).toBe(500)
      expect(reply.body).toContain('/Users/alice/.dsh-cu/skills.json')
      expect(reply.body).toContain('ENOENT')
    } finally {
      await control.close()
    }
  })

  it('an oversized body destroys the socket; the server survives but the caller gets nothing', async () => {
    const { control, url } = await server()
    try {
      const huge = JSON.stringify({ id: 'x'.repeat(20_000) })
      let outcome = 'resolved'
      try {
        const reply = await call(url, '/api/skills/remove', { method: 'POST', token: TOKEN, body: huge })
        outcome = `status:${reply.status}`
      } catch (error) {
        outcome = `socket_error:${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`
      }
      // Either an abrupt socket error or an empty reply — never a 4xx/5xx JSON body.
      expect(outcome === 'status:500' || outcome.startsWith('socket_error')).toBe(true)
      // The server keeps serving afterwards.
      expect((await call(url, '/', {})).status).toBe(200)
    } finally {
      await control.close()
    }
  })
})
