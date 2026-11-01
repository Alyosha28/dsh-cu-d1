/**
 * CR-06 / CR-08 — a single bad line must not poison the audit chain, and a
 * user stop must be terminal for the model.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AuditStore } from '../src/audit.ts'
import { RunController } from '../src/run-controller.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup())) })

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

it('keeps appending after one failed write, without an unhandled rejection', async () => {
  const path = await directory('dsh-cu-audit-recover-')
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    let failures = 1
    const store = new AuditStore(join(path, 'audit.jsonl'))
    const append = store.append.bind(store)
    // First append fails, the rest succeed.
    store.append = async event => {
      if (failures > 0) {
        failures -= 1
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      }
      return append(event)
    }
    const controller = new RunController(store)
    const agent = { id: 'agent-1' } as any
    controller.start(agent, 'first_run')
    controller.pause(agent)
    controller.resume(agent)
    controller.finish(agent, 'success', 'independently_verified')
    const events = await controller.auditEvents()
    expect(events.map(event => event.kind)).toEqual(expect.arrayContaining(['run_paused', 'run_resumed', 'run_finished']))
    expect(controller.auditWriteFailures).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(unhandled).toEqual([])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

it('refuses to start a new run after an audit write failure', async () => {
  const path = await directory('dsh-cu-audit-failopen-')
  const store = new AuditStore(join(path, 'audit.jsonl'))
  store.append = async () => { throw new Error('ENOSPC') }
  const controller = new RunController(store)
  const agent = { id: 'agent-1' } as any
  controller.start(agent, 'first_run')
  await expect.poll(() => controller.auditWriteFailures, { timeout: 1000 }).toBeGreaterThan(0)
  controller.finish(agent, 'success', 'independently_verified')
  await expect.poll(() => controller.auditWriteFailures, { timeout: 1000 }).toBeGreaterThan(1)
  expect(() => controller.start(agent, 'second_run')).toThrow(/audit/u)
})

it('treats a stop or takeover as terminal for resume', async () => {
  const path = await directory('dsh-cu-control-terminal-')
  const controller = new RunController(new AuditStore(join(path, 'audit.jsonl')))
  const agent = { id: 'agent-1' } as any
  const run = controller.start(agent, 'run')
  controller.stop(agent)
  expect(run.admit()).toMatchObject({ status: 'stopped' })
  controller.resume(agent)
  // The model calling `resume` must not undo the user's stop.
  expect(controller.admit(agent)).toMatchObject({ status: 'stopped' })
  expect(controller.status(agent).stopped).toBe(true)

  const takeover = controller.start(agent, 'second')
  expect(takeover.id).toBe('')
  expect(controller.admit(agent)).toMatchObject({ status: 'stopped' })

  const other = { id: 'agent-2' } as any
  const live = controller.start(other, 'run')
  controller.takeover(other, 'human_takeover')
  expect(live.admit()).toMatchObject({ status: 'takeover' })
  controller.resume(other)
  expect(controller.admit(other)).toMatchObject({ status: 'takeover' })
})

it('resumes only a paused run', async () => {
  const path = await directory('dsh-cu-control-pause-')
  const controller = new RunController(new AuditStore(join(path, 'audit.jsonl')))
  const agent = { id: 'agent-1' } as any
  const run = controller.start(agent, 'run')
  controller.pause(agent)
  expect(run.admit()).toBeNull()
  controller.resume(agent)
  expect(controller.status(agent).active?.status).toBe('running')
})

it('quarantines unparseable audit lines instead of losing the whole chain', async () => {
  const path = await directory('dsh-cu-audit-quarantine-')
  const file = join(path, 'audit.jsonl')
  const store = new AuditStore(file)
  await store.append({ agentId: 'a1', kind: 'run_started' })
  await writeFile(file, `${await readFile(file, 'utf8')}{"id":"broken"\n`)

  const event = await store.append({ agentId: 'a1', kind: 'run_finished', detail: { status: 'success' } })
  expect(event.kind).toBe('run_finished')
  expect((await store.list()).map(item => item.kind)).toEqual(['run_finished', 'run_started'])
  expect(store.quarantinedLines).toBe(1)

  const quarantined = await readdir(path)
  expect(quarantined).toContain('audit.jsonl.corrupt')
  expect(await readFile(join(path, 'audit.jsonl.corrupt'), 'utf8')).toContain('"id":"broken"')
})

it('records a terminal event even when no run is active', async () => {
  const path = await directory('dsh-cu-audit-terminal-')
  const store = new AuditStore(join(path, 'audit.jsonl'))
  const controller = new RunController(store)
  controller.finish({ id: 'agent-1' } as any, 'blocked', 'policy_blocked')
  await expect.poll(async () => (await controller.auditEvents()).map(event => event.kind))
    .toContain('run_finished')
})
