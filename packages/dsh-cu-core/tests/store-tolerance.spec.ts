/**
 * CR-08 / CR-09 — one bad record must not disable the store, published Skills
 * are immutable, and the merged assertion set is capped.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createCandidateFromTrajectory } from '../src/skill-builder.ts'
import { verificationForSkill } from '../src/skills.ts'
import type { VerifiedSkill } from '../src/skills.ts'
import { SkillStore } from '../src/skill-store.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup())) })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cu-store-tolerance-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'skills.json')
  const store = new SkillStore(path)
  const candidate = await createCandidateFromTrajectory(store, {
    route: 'd1', status: 'success',
    match: { urlPath: '/flights.html', origin: 'https://example.test' },
    verify: [{ type: 'text_visible', text: 'Done' }],
    trace: [{ operation: 'CLICK', targetName: 'Search', target: 'e1' }],
  })
  if (candidate === undefined) throw new Error('Expected candidate')
  return { store, path, directory, candidate }
}

it('quarantines a record with an unknown field instead of failing every read', async () => {
  const { store, path, directory, candidate } = await fixture()
  const file = JSON.parse(await readFile(path, 'utf8'))
  file.skills.push({ ...file.skills[0], id: 'skill_broken', unknownField: true })
  await writeFile(path, JSON.stringify(file))

  expect((await store.list()).map(skill => skill.id)).toEqual([candidate.id])
  expect((await store.get(candidate.id))?.id).toBe(candidate.id)
  // One physical record is dropped; the counter reports at least that record.
  expect(store.quarantinedRecords).toBeGreaterThanOrEqual(1)
  expect(await readFile(join(directory, 'skills.json.corrupt'), 'utf8')).toContain('skill_broken')
  // The store keeps working for writes.
  await expect(store.beginVerification(candidate.id)).resolves.toMatchObject({ skillId: candidate.id })
})

it('quarantines a future-version record and a truncated file', async () => {
  const { store, path } = await fixture()
  const file = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ version: 2, skills: file.skills }))
  expect(await store.list()).toHaveLength(1)

  await writeFile(path, '{"version":1,"skills":[{"id":"trunc')
  expect(await store.list()).toEqual([])
  await expect(store.createCandidate({
    match: { windowTitle: 'Fresh' }, fallback: 'd1', risk: 'reversible',
    verify: [{ type: 'text_visible', text: 'Done' }], steps: [{ type: 'click', target: 'Run' }],
  })).resolves.toMatchObject({ state: 'candidate' })
  expect(await store.list()).toHaveLength(1)
})

it('refuses to reject a published Skill', async () => {
  const { store, candidate } = await fixture()
  const session = await store.beginVerification(candidate.id)
  await store.finishVerification(session.token, { status: 'passed', summary: 'rerun_ok' })
  await store.publish(candidate.id, store.mintPublishNonce(candidate.id, { approved: true })!)
  await expect(store.reject(candidate.id, 'late_rejection')).rejects.toMatchObject({ code: 'skill_immutable' })
  expect((await store.get(candidate.id))?.state).toBe('verified')
  // Removal stays available and is the documented retirement path.
  expect(await store.remove(candidate.id)).toBe(true)
})

it('caps the merged assertion set at 12', () => {
  const skill = {
    id: 'skill_twelve', version: 1, verifiedAt: 'now', match: { windowTitle: 'Fixture' },
    fallback: 'd1', risk: 'reversible', steps: [{ type: 'click', target: 'Run' }],
    verify: Array.from({ length: 12 }, (_unused, index) => ({ type: 'text_visible' as const, text: `Done ${index}` })),
  } satisfies VerifiedSkill
  expect(() => verificationForSkill(skill, undefined, [{ type: 'text_visible', text: 'Extra' }])).toThrow()
  expect(verificationForSkill(skill, undefined, [])).toHaveLength(12)
  expect(() => verificationForSkill({ ...skill, verify: [] }, undefined, [])).toThrow()
})

it('drops every captured value from the candidate that is not replaced by a placeholder', async () => {
  const { store, path } = await fixture()
  // The password is dispatched but never entered into `capturedValues`.
  const candidate = await createCandidateFromTrajectory(store, {
    route: 'd1', status: 'success', match: { windowTitle: 'Vault' },
    verify: [{ type: 'text_visible', text: 'Signed in as hunter2-OTP' }],
    inputs: { User: 'alice' },
    trace: [
      { operation: 'TYPE_TEXT', targetName: 'User', target: 'e1', dispatched: true, text: 'alice' },
      { operation: 'TYPE_TEXT', targetName: 'Password', target: 'e2', dispatched: true, text: 'hunter2-OTP' },
      { operation: 'CLICK', targetName: 'Sign in', target: 'e3', dispatched: true },
    ],
  })
  expect(candidate).toBeUndefined()
  expect(await readFile(path, 'utf8')).not.toContain('hunter2-OTP')

  // Fully redacted text is still persistable.
  const clean = await createCandidateFromTrajectory(store, {
    route: 'd1', status: 'success', match: { windowTitle: 'Vault 2' },
    verify: [{ type: 'text_visible', text: 'Signed in as hunter2-OTP' }],
    capturedValues: [{ targetName: 'Password', value: 'hunter2-OTP' }],
    trace: [
      { operation: 'TYPE_TEXT', targetName: 'Password', target: 'e2', dispatched: true, text: 'hunter2-OTP' },
      { operation: 'CLICK', targetName: 'Sign in', target: 'e3', dispatched: true },
    ],
  })
  expect(clean?.verify).toEqual([{ type: 'text_visible', text: 'Signed in as {{inputs:Password}}' }])
})

it('captures a paste-only trajectory', async () => {
  const { store } = await fixture()
  const candidate = await createCandidateFromTrajectory(store, {
    route: 'd1', status: 'success', match: { windowTitle: 'Paste' },
    verify: [{ type: 'text_visible', text: 'pastedSecret accepted' }],
    capturedValues: [{ targetName: 'Body', value: 'pastedSecret' }],
    trace: [
      { operation: 'PASTE_TEXT', targetName: 'Body', targetIdentifier: 'document-body', target: 'e1', dispatched: true },
      { operation: 'CLICK', targetName: 'Save', target: 'e2', dispatched: true },
    ],
  })
  expect(candidate?.steps).toEqual([
    { type: 'paste', target: 'document-body', input: 'Body' },
    { type: 'click', target: 'Save' },
  ])
  expect(JSON.stringify(candidate?.verify)).not.toContain('pastedSecret')
})
