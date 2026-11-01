/**
 * CR-08 — Store integrity.
 *
 *  a) Reads are all-or-nothing: a single malformed audit line / skill record
 *     disables the whole store instead of skipping the bad entry.
 *  b) The in-process write lock is keyed by module identity, not by file, so two
 *     module instances (two processes, or a src/dist duplicate in one process)
 *     lose each other's read-modify-write of the entire file.
 *  c) `reject()` rewrites an already published (supposedly immutable) Skill.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AuditStore } from '../../../packages/dsh-cu-core/src/audit.ts'
import { SkillStore } from '../../../packages/dsh-cu-core/src/skill-store.ts'
import { createCandidateFromTrajectory } from '../../../packages/dsh-cu-core/src/skill-builder.ts'
// A second, independent module instance of the same package (the built output).
import { AuditStore as AuditStoreDist } from '../../../packages/dsh-cu-core/dist/audit.js'
import { SkillStore as SkillStoreDist } from '../../../packages/dsh-cu-core/dist/skill-store.js'

const dirs: string[] = []
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cr08-'))
  dirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
})

const trajectory = {
  route: 'd1', status: 'success',
  trace: [{ operation: 'CLICK', targetName: 'Search flights', dispatched: true }],
  verify: [{ type: 'text_visible', text: 'Results' }],
  match: { urlPath: '/search', origin: 'https://air.example' },
  risk: 'reversible' as const,
}

describe('CR-08 store integrity', () => {
  it('one malformed audit line permanently stops auditing', async () => {
    const dir = await temp()
    const path = join(dir, 'audit.jsonl')
    await writeFile(path, '{"id":"a","at":"2026-11-01T00:00:00.000Z","agentId":"a","kind":"run_started"}\n{"truncated":\n')
    const store = new AuditStore(path)
    await expect(store.append({ agentId: 'a', kind: 'run_started' })).rejects.toThrow(/JSON/)
    await expect(store.list()).rejects.toThrow(/JSON/)
    // Append never succeeds again: every later audit event is lost.
    await expect(store.append({ agentId: 'a', kind: 'run_finished' })).rejects.toThrow(/JSON/)
  })

  it('one malformed skill record disables every Skill and every replay', async () => {
    const dir = await temp()
    const path = join(dir, 'skills.json')
    const good = await (async () => {
      const store = new SkillStore(path)
      const candidate = await createCandidateFromTrajectory(store, trajectory)
      return candidate!
    })()
    const file = JSON.parse(await readFile(path, 'utf8'))
    file.skills.push({ ...file.skills[0], id: 'legacy', unknownField: true })   // strict schema
    await writeFile(path, JSON.stringify(file))
    const store = new SkillStore(path)
    await expect(store.get(good.id)).rejects.toThrow()
    await expect(store.list('verified')).rejects.toThrow()
  })

  it('a newer file version bricks the store (no forward compatibility)', async () => {
    const dir = await temp()
    const path = join(dir, 'skills.json')
    await writeFile(path, JSON.stringify({ version: 2, skills: [] }))
    await expect(new SkillStore(path).list()).rejects.toThrow()
  })

  it('a second module instance loses the other writer\u2019s records (per-module lock, not per-file)', async () => {
    const dir = await temp()
    const path = join(dir, 'audit.jsonl')
    const a = new AuditStore(path)
    const b = new AuditStoreDist(path) as unknown as AuditStore
    await Promise.all([
      a.append({ agentId: 'a', kind: 'run_started', detail: { limit: 1 } }),
      b.append({ agentId: 'b', kind: 'run_started', detail: { limit: 2 } }),
    ])
    const lines = (await readFile(path, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)   // one of the two events was silently overwritten
  })

  it('the same lost update applies to published Skills', async () => {
    const dir = await temp()
    const path = join(dir, 'skills.json')
    const a = new SkillStore(path)
    const b = new SkillStoreDist(path) as unknown as SkillStore
    await Promise.all([
      createCandidateFromTrajectory(a, trajectory),
      createCandidateFromTrajectory(b, { ...trajectory, match: { urlPath: '/other', origin: 'https://air.example' } }),
    ])
    const file = JSON.parse(await readFile(path, 'utf8'))
    expect(file.skills.length).toBe(1)
  })

  it('reject() rewrites an already published Skill', async () => {
    const dir = await temp()
    const store = new SkillStore(join(dir, 'skills.json'))
    const candidate = await createCandidateFromTrajectory(store, trajectory)
    await store.recordVerification(candidate!.id, {
      status: 'passed', independent: true, at: new Date().toISOString(), summary: 'ok',
    })
    const latest = (await store.get(candidate!.id))!.history.at(-1)!
    const published = await store.publish(candidate!.id, latest.id, 'user')
    expect(published.state).toBe('verified')
    await expect(store.recordVerification(candidate!.id, {
      status: 'failed', independent: true, at: new Date().toISOString(), summary: 'late',
    })).rejects.toThrow('immutable')

    const rejected = await store.reject(candidate!.id, 'user_changed_mind')
    expect(rejected.state).toBe('rejected')        // a published v1 is mutated in place
    expect((await store.get(candidate!.id))!.state).toBe('rejected')
  })

  it('file and directory permissions are private (control that holds)', async () => {
    const dir = await temp()
    const path = join(dir, 'nested', 'skills.json')
    const store = new SkillStore(path)
    await createCandidateFromTrajectory(store, trajectory)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'nested'))).mode & 0o777).toBe(0o700)
  })
})
