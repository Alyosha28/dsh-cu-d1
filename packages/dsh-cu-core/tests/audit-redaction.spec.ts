/**
 * CR-05 — audit redaction must survive realistic key spellings, Unicode
 * separators, and comma/space separated lists.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AuditStore, sanitizeAuditDetail } from '../src/audit.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup())) })

const SECRET = 'sk-live-9f3ab27c'

it('redacts values under credential-shaped key names', () => {
  for (const key of ['access_token', 'refresh_token', 'client_secret', 'api_key', 'authorization', 'cookie', 'password', 'credential', 'private_key', 'sessionToken']) {
    const detail = sanitizeAuditDetail({ reason: `retry ${key}=${SECRET}` })!
    expect(JSON.stringify(detail), key).not.toContain(SECRET)
  }
})

it('redacts Unicode separators and list separators', () => {
  for (const text of [
    `token：${SECRET}`,
    `token＝${SECRET}`,
    `password=${SECRET},retry=1`,
    `password=abc retry ${SECRET}`,
    `access_token=${SECRET};next=1`,
    `Authorization: Bearer ${SECRET}`,
  ]) {
    expect(JSON.stringify(sanitizeAuditDetail({ reason: text })), text).not.toContain(SECRET)
  }
})

it('still keeps an ordinary control value readable', () => {
  expect(sanitizeAuditDetail({ reason: 'step_budget_exhausted' })).toEqual({ reason: 'step_budget_exhausted' })
})

it('never writes a secret into the audit file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cu-audit-redact-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const store = new AuditStore(join(directory, 'audit.jsonl'))
  await store.append({ agentId: 'a1', kind: 'run_failed', detail: { reason: `refresh_token：${SECRET}` } })
  await store.append({ agentId: 'a1', kind: 'run_failed', detail: { reason: `api_key=${SECRET},x=1` } })
  expect(await readFile(join(directory, 'audit.jsonl'), 'utf8')).not.toContain(SECRET)
})
