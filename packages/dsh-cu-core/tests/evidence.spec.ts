/**
 * CR-02 — the evidence chain must have a producer.
 *
 * `independent: true` used to be a literal and `approvedBy` a caller-supplied
 * string, so "latest independent verification" and "user approval" were both
 * claims made by the party being constrained. Now the store mints a one-shot
 * verification token and a publish nonce, and stamps evidence with its own
 * clock.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createCandidateFromTrajectory } from '../src/skill-builder.ts'
import { SkillStore } from '../src/skill-store.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup())) })

async function fixture(options: { now?: () => Date } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cu-evidence-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const store = new SkillStore(join(directory, 'skills.json'), options)
  const candidate = await createCandidateFromTrajectory(store, {
    route: 'd1', status: 'success',
    match: { urlPath: '/flights.html', origin: 'https://example.test' },
    verify: [{ type: 'text_visible', text: 'Done' }],
    trace: [{ operation: 'CLICK', targetName: 'Search', target: 'e1' }],
  })
  if (candidate === undefined) throw new Error('Expected candidate')
  return { store, candidate, directory }
}

it('refuses any further verification for a published Skill', async () => {
  const { store, candidate } = await fixture()
  const session = await store.beginVerification(candidate.id)
  await store.finishVerification(session.token, { status: 'passed', summary: 'rerun_ok' })
  await store.publish(candidate.id, store.mintPublishNonce(candidate.id, { approved: true })!)
  const late = await store.beginVerification(candidate.id)
  const evidence = await store.finishVerification(late.token, { status: 'failed', summary: 'late_signal' })
  // The published record itself is never mutated by a late signal.
  const record = (await store.get(candidate.id))!
  expect(record.state).toBe('verified')
  expect(record.verifiedAt).not.toBe(evidence.at)
  await expect(store.recordVerification(candidate.id)).rejects.toThrow('immutable')
  await expect(store.reject(candidate.id, 'late_signal')).rejects.toMatchObject({ code: 'skill_immutable' })
})

it('mints a one-shot verification token per rerun', async () => {
  const { store, candidate } = await fixture()
  const session = await store.beginVerification(candidate.id)
  expect(session.token).toMatch(/^[a-f0-9]{64}$/u)
  expect(session.skillId).toBe(candidate.id)
  await expect(store.beginVerification('skill_unknown')).rejects.toThrow()

  const evidence = await store.finishVerification(session.token, { status: 'passed', summary: 'rerun_ok' })
  expect(evidence).toMatchObject({ status: 'passed', summary: 'rerun_ok' })
  expect(evidence.id).toMatch(/[0-9a-f-]{36}/u)
  await expect(store.finishVerification(session.token, { status: 'passed', summary: 'replay' }))
    .rejects.toMatchObject({ code: 'verification_token_invalid' })
})

it('stamps evidence time from the store clock, not from the caller', async () => {
  const fixed = new Date('2026-01-02T03:04:05.000Z')
  const { store, candidate } = await fixture({ now: () => fixed })
  const session = await store.beginVerification(candidate.id)
  const evidence = await store.finishVerification(session.token, {
    status: 'passed', summary: 'rerun_ok', at: '1999-01-01T00:00:00.000Z',
  } as any)
  expect(evidence.at).toBe(fixed.toISOString())
})

it('expires a verification token', async () => {
  let now = Date.parse('2026-01-02T03:04:05.000Z')
  const { store, candidate } = await fixture({ now: () => new Date(now) })
  const session = await store.beginVerification(candidate.id)
  expect(Date.parse(session.expiresAt)).toBeGreaterThan(now)
  now += 16 * 60 * 1000
  await expect(store.finishVerification(session.token, { status: 'passed', summary: 'late' }))
    .rejects.toMatchObject({ code: 'verification_token_invalid' })
})

it('binds a verification token to its own skill', async () => {
  const { store, candidate } = await fixture()
  const other = await store.createCandidate({
    match: { windowTitle: 'Other' }, fallback: 'd1', risk: 'reversible',
    verify: [{ type: 'text_visible', text: 'Done' }], steps: [{ type: 'click', target: 'Run' }],
  })
  const session = await store.beginVerification(candidate.id)
  await expect(store.finishVerification(session.token, { status: 'passed', summary: 'x', skillId: other.id } as any))
    .rejects.toMatchObject({ code: 'verification_token_invalid' })
})

it('refuses publication without a nonce minted from a real user approval', async () => {
  const { store, candidate } = await fixture()
  const session = await store.beginVerification(candidate.id)
  await store.finishVerification(session.token, { status: 'passed', summary: 'rerun_ok' })
  const latest = (await store.get(candidate.id))!.history.at(-1)!

  // Legacy call shape, caller-asserted approval.
  await expect(store.publish(candidate.id, latest.id, 'user')).rejects.toMatchObject({ code: 'approval_required' })
  await expect(store.publish(candidate.id, 'not-a-nonce')).rejects.toMatchObject({ code: 'approval_required' })
  await expect(store.publish(candidate.id, latest.id)).rejects.toMatchObject({ code: 'approval_required' })

  // A nonce minted from a denied approval yields no nonce at all.
  expect(store.mintPublishNonce(candidate.id, { approved: false, reason: 'denied_by_user' })).toBeUndefined()
  const nonce = store.mintPublishNonce(candidate.id, { approved: true })
  const published = await store.publish(candidate.id, nonce!)
  expect(published.state).toBe('verified')
})

it('uses the evidence timestamp for verifiedAt and consumes the nonce once', async () => {
  const fixed = new Date('2026-02-03T04:05:06.000Z')
  const { store, candidate } = await fixture({ now: () => fixed })
  const session = await store.beginVerification(candidate.id)
  const evidence = await store.finishVerification(session.token, { status: 'passed', summary: 'rerun_ok' })
  const nonce = store.mintPublishNonce(candidate.id, { approved: true })!
  const published = await store.publish(candidate.id, nonce)
  expect(published.verifiedAt).toBe(evidence.at)
  await expect(store.publish(candidate.id, nonce)).rejects.toMatchObject({ code: 'approval_required' })
})

it('mints a nonce only for the skill the user approved', async () => {
  const { store, candidate } = await fixture()
  const other = await store.createCandidate({
    match: { windowTitle: 'Other' }, fallback: 'd1', risk: 'reversible',
    verify: [{ type: 'text_visible', text: 'Done' }], steps: [{ type: 'click', target: 'Run' }],
  })
  const first = await store.beginVerification(candidate.id)
  await store.finishVerification(first.token, { status: 'passed', summary: 'rerun_ok' })
  const second = await store.beginVerification(other.id)
  await store.finishVerification(second.token, { status: 'passed', summary: 'rerun_ok' })
  const nonce = store.mintPublishNonce(candidate.id, { approved: true })!
  await expect(store.publish(other.id, nonce)).rejects.toMatchObject({ code: 'approval_required' })
  expect((await store.get(candidate.id))?.state).toBe('candidate')
})

it('refuses publication when the latest verification failed', async () => {
  const { store, candidate } = await fixture()
  const session = await store.beginVerification(candidate.id)
  await store.finishVerification(session.token, { status: 'failed', summary: 'rerun_failed' })
  const nonce = store.mintPublishNonce(candidate.id, { approved: true })!
  await expect(store.publish(candidate.id, nonce)).rejects.toThrow('verification_required')
})
