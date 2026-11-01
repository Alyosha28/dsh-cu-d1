/**
 * CR-05 — Audit redaction is bypassable, and the audit allowlist admits free-form
 * strings (`reason`, `action`, `operation`, `status`).
 *
 * The repository's own regression test (packages/dsh-cu-core/tests/audit.spec.ts:18-37)
 * asserts that credential-like values never reach disk. These cases defeat that
 * same control: an underscore-qualified key (`access_token`), a full-width colon,
 * or a comma/semicolon/space separator all survive `safeString`.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AuditStore, sanitizeAuditDetail } from '../../../packages/dsh-cu-core/src/audit.ts'

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
})

const SECRET = 'sk-live-4f8a2c1d9e'

describe('CR-05 audit redaction bypasses', () => {
  it('redacts the documented shapes (control group)', () => {
    const safe = sanitizeAuditDetail({ reason: 'password=hunter2' })!
    expect(safe.reason).toBe('password=[redacted]')
    expect(String(sanitizeAuditDetail({ reason: 'Bearer abc.def' })!.reason)).toBe('Bearer [redacted]')
  })

  it('underscore-qualified keys are not redacted', () => {
    const safe = sanitizeAuditDetail({ reason: `access_token=${SECRET}` })!
    expect(safe.reason).toBe(`access_token=${SECRET}`)          // leaked verbatim
    expect(String(sanitizeAuditDetail({ reason: `client_secret=${SECRET}` })!.reason)).toContain(SECRET)
    expect(String(sanitizeAuditDetail({ reason: `refresh_token:${SECRET}` })!.reason)).toContain(SECRET)
  })

  it('a full-width colon defeats the pattern', () => {
    const safe = sanitizeAuditDetail({ reason: `token：${SECRET}` })!
    expect(safe.reason).toBe(`token：${SECRET}`)
  })

  it('separators truncate the redaction and leak the remainder', () => {
    // `[^\s,;]+` stops at the first space/comma/semicolon: the tail of a value
    // that contains one of those characters is written in clear.
    expect(String(sanitizeAuditDetail({ reason: 'token=abc def' })!.reason)).toBe('token=[redacted] def')
    expect(String(sanitizeAuditDetail({ reason: `password=${SECRET},retry=1` })!.reason))
      .toBe('password=[redacted],retry=1')
    expect(String(sanitizeAuditDetail({ reason: `token=${SECRET} tail-part` })!.reason))
      .toBe('token=[redacted] tail-part')
  })

  it('leaks into the persisted audit file end to end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cr05-'))
    dirs.push(dir)
    const path = join(dir, 'audit.jsonl')
    const store = new AuditStore(path)
    await store.append({
      agentId: 'agent-1', kind: 'run_finished',
      detail: { status: 'success', reason: `access_token=${SECRET}` },
    })
    const persisted = await readFile(path, 'utf8')
    expect(persisted).toContain(SECRET)
  })

  it('only allowlisted keys survive, but the allowlist is where free text enters', () => {
    const safe = sanitizeAuditDetail({
      goal: 'private user goal', url: 'https://bank.example/x', input: 'hunter2',
      reason: `token=${SECRET}`,
    })!
    expect(safe).not.toHaveProperty('goal')
    expect(safe).not.toHaveProperty('url')
    expect(safe).not.toHaveProperty('input')
    expect(safe).toHaveProperty('reason')
  })
})
