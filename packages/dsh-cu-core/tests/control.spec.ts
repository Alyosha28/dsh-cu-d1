import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AuditStore } from '../src/audit.ts'
import { ControlServer } from '../src/control-server.ts'
import { RunController } from '../src/run-controller.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup())) })

it('pauses in place, resumes the same run, and keeps stop and takeover terminal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cu-control-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const agent = { id: 'agent-1' } as any
  const controller = new RunController(new AuditStore(join(directory, 'audit.jsonl')))
  const run = controller.start(agent, 'test_run')
  expect(run.admit()).toBeNull()
  controller.pause(agent)
  expect(run.admit()).toBeNull()
  expect(controller.status(agent).active?.status).toBe('paused')
  let resumed = false
  const waiting = run.waitWhilePaused().then(stop => { resumed = true; return stop })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(resumed).toBe(false)
  expect(() => controller.start(agent, 'second')).toThrow('already active')
  controller.resume(agent)
  expect(await waiting).toBeNull()
  expect(controller.status(agent).active?.status).toBe('running')
  controller.stop(agent)
  expect(run.admit()).toMatchObject({ status: 'stopped' })
  expect(await run.waitWhilePaused()).toMatchObject({ status: 'stopped' })
  controller.resume(agent)
  const second = controller.start(agent, 'second')
  controller.takeover(agent)
  expect(second.admit()).toMatchObject({ status: 'takeover', reason: 'human_takeover' })
  controller.resume(agent)
  const third = controller.start(agent, 'third')
  controller.takeover(agent, 'takeover_detected')
  expect(third.admit()).toMatchObject({ status: 'takeover', reason: 'takeover_detected' })
  controller.resume(agent)
  const fourth = controller.start(agent, 'fourth')
  controller.stop(agent, 'indicator_unavailable')
  expect(fourth.admit()).toMatchObject({ status: 'stopped', reason: 'indicator_unavailable' })
  const events = await controller.auditEvents()
  expect(events.map(event => event.kind)).toEqual(expect.arrayContaining([
    'run_started', 'run_paused', 'run_resumed', 'run_stopped', 'run_takeover',
  ]))
  expect(JSON.stringify(events)).not.toContain('secret-value')
})

it('excludes paused time from the run wall clock', () => {
  let now = 1000
  const agent = { id: 'agent-paused-credit' } as any
  const controller = new RunController(undefined, () => now)
  const run = controller.start(agent, 'budget_run')
  controller.pause(agent)
  now += 5000
  controller.resume(agent)
  expect(run.pausedMs()).toBe(5000)
  controller.pause(agent)
  now += 3000
  expect(run.pausedMs()).toBe(8000)
  controller.stop(agent)
})

it('keeps raw exception details out of control status and audit records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cu-control-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const agent = { id: 'agent-1' } as any
  const controller = new RunController(new AuditStore(join(directory, 'audit.jsonl')))
  controller.start(agent, 'test_run')
  controller.finish(agent, 'escalated', 'Error: sensitive-user-input at /private/path')
  expect(controller.status(agent).last?.reason).toBe('tool_execution_failed')
  expect(JSON.stringify(await controller.auditEvents())).not.toContain('sensitive-user-input')
})

it('serves a loopback control page with authenticated control actions', async () => {
  const agent = { id: 'agent-1' } as any
  const controller = new RunController()
  const server = new ControlServer(controller, agent, 'test-token', { locale: 'en' })
  const base = await server.start()
  cleanups.push(() => server.close())
  expect(base).toBe(await server.start())
  expect((await fetch(`${base}/api/status`)).status).toBe(401)
  const page = await fetch(base)
  expect(page.status).toBe(200)
  const html = await page.text()
  expect(html).toContain('Pause')
  expect(html).toContain('Run status')
  const status = await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer test-token' } })
  expect(status.status).toBe(200)
  const run = controller.start(agent, 'http_run')
  const stopped = await fetch(`${base}/api/stop`, { method: 'POST', headers: { authorization: 'Bearer test-token' } })
  expect(stopped.status).toBe(200)
  expect(run.admit()).toMatchObject({ status: 'stopped' })
  await fetch(`${base}/api/resume`, { method: 'POST', headers: { authorization: 'Bearer test-token' } })
  const takeover = await fetch(`${base}/api/takeover`, { method: 'POST', headers: { authorization: 'Bearer test-token' } })
  expect(takeover.status).toBe(200)
  expect(controller.admit(agent)).toMatchObject({ status: 'takeover' })
})

it('exposes Skills and permission status through the authenticated control page', async () => {
  const agent = { id: 'agent-1' } as any
  const controller = new RunController()
  const server = new ControlServer(controller, agent, 'test-token', {
    locale: 'en',
    listSkills: async () => [{
      id: 'skill_demo', state: 'verified', version: 2, risk: 'reversible',
      steps: 3, verifiedAt: '2026-10-31T00:00:00.000Z', scope: 'https://example.test/form',
    }],
    permissionStatus: async () => ({ accessibility: true, screenRecording: false, application: 'DSH' }),
    openPermission: async () => undefined,
    removeSkill: async id => id === 'skill_demo',
  })
  const base = await server.start()
  cleanups.push(() => server.close())
  const headers = { authorization: 'Bearer test-token' }
  const skills = await (await fetch(`${base}/api/skills`, { headers })).json() as any
  expect(skills.skills).toHaveLength(1)
  expect(skills.skills[0]).toMatchObject({ id: 'skill_demo', state: 'verified' })
  const permissions = await (await fetch(`${base}/api/permissions`, { headers })).json() as any
  expect(permissions).toMatchObject({ available: true, accessibility: true, screenRecording: false })
  const opened = await fetch(`${base}/api/open-permission`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ pane: 'screenRecording' }),
  })
  expect(opened.status).toBe(200)
  const removed = await fetch(`${base}/api/skills/remove`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'skill_demo' }),
  })
  expect(removed.status).toBe(200)
  expect(await removed.json()).toEqual({ removed: true })
})
