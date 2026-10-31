import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AuditStore } from '../src/audit.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cu-audit-'))
  directories.push(directory)
  return { directory, path: join(directory, 'audit.jsonl') }
}

it('persists only allowlisted operational detail and redacts credential-like values', async () => {
  const { path } = await fixture()
  const store = new AuditStore(path)
  const event = await store.append({
    agentId: 'agent-1', kind: 'run_finished',
    detail: {
      status: 'success', route: 'd1', actionsExecuted: 2,
      reason: 'Bearer very-secret password=hunter2',
      goal: 'private user goal', inputs: { password: 'hunter2' }, screenshot: 'sensitive-pixels', cookie: 'session=secret',
    },
  })
  const persisted = await readFile(path, 'utf8')
  expect(persisted).not.toContain('private user goal')
  expect(persisted).not.toContain('hunter2')
  expect(persisted).not.toContain('very-secret')
  expect(persisted).not.toContain('sensitive-pixels')
  expect(persisted).not.toContain('session=secret')
  expect(event.detail).toEqual({ status: 'success', route: 'd1', actionsExecuted: 2, reason: 'Bearer [redacted] password=[redacted]' })
  expect((await stat(path)).mode & 0o777).toBe(0o600)
})

it('serializes writes from multiple store instances sharing one audit file', async () => {
  const { path } = await fixture()
  const first = new AuditStore(path)
  const second = new AuditStore(path)
  await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? first : second).append({
    agentId: 'agent-1', kind: 'run_started', detail: { limit: index },
  })))
  const events = await first.list(20)
  expect(events).toHaveLength(20)
  expect(new Set(events.map(event => event.id)).size).toBe(20)
})

it('prunes expired events on writes and reads', async () => {
  const { path } = await fixture()
  const now = new Date('2026-10-29T12:00:00.000Z')
  await writeFile(path, [
    JSON.stringify({ id: 'old', at: '2026-09-01T00:00:00.000Z', agentId: 'agent-1', kind: 'run_started' }),
    JSON.stringify({ id: 'new', at: now.toISOString(), agentId: 'agent-1', kind: 'run_finished' }),
  ].join('\n') + '\n')
  const store = new AuditStore(path, { retentionDays: 30, now: () => now })
  expect((await store.list()).map(event => event.id)).toEqual(['new'])
  expect(await readFile(path, 'utf8')).not.toContain('"old"')
})
