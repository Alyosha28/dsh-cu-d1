import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createCandidateFromTrajectory, evidenceFromRun, stepsFromTrajectory } from '../src/skill-builder.ts'
import { selectSkill, verificationForSkill } from '../src/skills.ts'
import { SkillStore } from '../src/skill-store.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup())) })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cu-skill-store-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const store = new SkillStore(join(directory, 'skills.json'))
  const candidate = await createCandidateFromTrajectory(store, {
    route: 'd1', status: 'success',
    match: { urlPath: '/flights.html', origin: 'https://example.test' },
    verify: [{ type: 'text_visible', text: 'Zürich to London · 2026-11-01' }],
    inputs: { From: 'Zürich', To: 'London', 'Departure date': '2026-11-01' },
    trace: [
      { operation: 'TYPE_TEXT', targetName: 'From', target: 'e1' },
      { operation: 'TYPE_TEXT', targetName: 'To', target: 'e3' },
      { operation: 'TYPE_TEXT', targetName: 'Departure date', target: 'e6' },
      { operation: 'CLICK', targetName: 'Search flights', target: 'e7' },
    ],
  })
  if (candidate === undefined) throw new Error('Expected candidate')
  return { store, candidate, directory }
}

it('requires independent verification, user approval, and an exact replay origin', async () => {
  const { store, candidate, directory } = await fixture()
  expect(candidate.state).toBe('candidate')
  expect(candidate.match).toEqual({ urlPath: '/flights.html', origin: 'https://example.test' })
  expect(candidate.verify).toEqual([
    { type: 'text_visible', text: '{{inputs:From}} to {{inputs:To}} · {{inputs:Departure%20date}}' },
  ])
  expect((await store.list('verified')).find(skill => skill.id === candidate.id)).toBeUndefined()
  await expect(store.publish(candidate.id, 'missing', 'user')).rejects.toThrow('verification_required')

  const evidence = evidenceFromRun('success', 'independently_verified_after_skill', 0, true, 1)
  await store.recordVerification(candidate.id, evidence)
  await expect(store.publish(candidate.id, 'not-latest', 'user')).rejects.toThrow('verification_required')
  await expect(store.publish(candidate.id, 'not-latest', 'system')).rejects.toThrow('approval_required')

  const latest = (await store.get(candidate.id))!.history.at(-1)!
  const published = await store.publish(candidate.id, latest.id, 'user')
  expect(published.state).toBe('verified')
  expect(published.verifiedAt).toBe(latest.at)
  const reloaded = new SkillStore(join(directory, 'skills.json'))
  expect((await reloaded.get(candidate.id))?.state).toBe('verified')
  expect((await selectSkill({ skillId: candidate.id, url: 'https://example.test/flights.html' }, reloaded))?.id)
    .toBe(candidate.id)
  await expect(selectSkill({ skillId: candidate.id, url: 'https://other.test/flights.html' }, reloaded))
    .rejects.toMatchObject({ code: 'skill_origin_mismatch' })
  expect(await selectSkill({ url: 'https://other.test/flights.html' }, reloaded)).toBeNull()
  await expect(reloaded.recordVerification(candidate.id, evidence)).rejects.toThrow('immutable')
  expect(await readFile(join(directory, 'skills.json'), 'utf8')).not.toContain('Zürich')
  expect(await readFile(join(directory, 'skills.json'), 'utf8')).not.toContain('London')
  expect((await stat(join(directory, 'skills.json'))).mode & 0o777).toBe(0o600)
})

it('evolves a published skill into a new versioned candidate that requires fresh approval', async () => {
  const { store, candidate } = await fixture()
  const evidence = evidenceFromRun('success', 'independently_verified_after_skill', 0, true, 1)
  await store.recordVerification(candidate.id, evidence)
  const latest = (await store.get(candidate.id))!.history.at(-1)!
  const published = await store.publish(candidate.id, latest.id, 'user')
  expect(published.version).toBe(1)

  const repaired = await createCandidateFromTrajectory(store, {
    route: 'd1', status: 'success',
    match: { urlPath: '/flights.html', origin: 'https://example.test' },
    verify: [{ type: 'text_visible', text: 'Zürich to London · 2026-11-01' }],
    inputs: { From: 'Zürich', To: 'London', 'Departure date': '2026-11-01' },
    trace: [
      { operation: 'TYPE_TEXT', targetName: 'From', target: 'e1', dispatched: true },
      { operation: 'TYPE_TEXT', targetName: 'To', target: 'e3', dispatched: true },
      { operation: 'TYPE_TEXT', targetName: 'Departure date', target: 'e6', dispatched: true },
      { operation: 'CLICK', targetName: 'Search', target: 'e9', dispatched: true },
    ],
    evolveFrom: candidate.id,
  })
  expect(repaired).toBeDefined()
  expect(repaired!.id).not.toBe(candidate.id)
  expect(repaired!.version).toBe(2)
  expect(repaired!.evolvedFrom).toBe(candidate.id)
  expect(repaired!.state).toBe('candidate')

  // The original published Skill remains verified and immutable.
  const original = await store.get(candidate.id)
  expect(original?.state).toBe('verified')
  expect(original?.version).toBe(1)
  await expect(store.recordVerification(candidate.id, evidence)).rejects.toThrow('immutable')

  // The repaired candidate is not yet replayable and must pass the standard publish gate.
  await expect(selectSkill({ skillId: repaired!.id, url: 'https://example.test/flights.html' }, store))
    .rejects.toThrow('Unknown verified skill')
  await expect(store.publish(repaired!.id, 'missing', 'user')).rejects.toThrow('verification_required')
  await store.recordVerification(repaired!.id, evidenceFromRun('success', 'independently_verified_after_skill', 0, true, 1))
  const repairedLatest = (await store.get(repaired!.id))!.history.at(-1)!
  const republished = await store.publish(repaired!.id, repairedLatest.id, 'user')
  expect(republished.state).toBe('verified')
  expect(republished.version).toBe(2)
  expect((await store.list('verified')).map(skill => skill.id).sort()).toEqual([candidate.id, repaired!.id].sort())
})

it('rejects evolution from an unknown parent skill', async () => {
  const { store } = await fixture()
  await expect(store.createCandidate({
    match: { urlPath: '/flights.html', origin: 'https://example.test' },
    fallback: 'd1', risk: 'reversible',
    verify: [{ type: 'text_visible', text: 'Done' }],
    steps: [{ type: 'click', target: 'Run' }],
  }, { evolveFrom: 'skill_does_not_exist' })).rejects.toThrow('Unknown skill to evolve')
})

it('rejects unsupported trajectories and allows explicit candidate rejection', async () => {
  expect(stepsFromTrajectory([{ operation: 'TYPE_TEXT', target: 'e1' }])).toBeNull()
  expect(stepsFromTrajectory([{ operation: 'SCROLL_DOWN', targetName: 'Results' }])).toBeNull()
  const { store, candidate } = await fixture()
  await expect(store.createCandidate({
    match: { origin: 'https://trusted.test' }, fallback: 'd1', risk: 'reversible',
    verify: [{ type: 'text_visible', text: 'Done' }], steps: [{ type: 'click', target: 'Run' }],
  })).rejects.toThrow('match_required')
  const metadataCandidate = await createCandidateFromTrajectory(store, {
    route: 'd1', status: 'success',
    match: { urlPath: '/users/secret', origin: 'https://example.test' },
    verify: [{ type: 'text_visible', text: 'Done' }], inputs: { User: 'secret' },
    trace: [{ operation: 'CLICK', targetName: 'Run', target: 'e1' }],
  })
  expect(metadataCandidate).toBeUndefined()
  const encodedMetadataCandidate = await createCandidateFromTrajectory(store, {
    route: 'd1', status: 'success',
    match: { urlPath: '/users/secret%20value', origin: 'https://example.test' },
    verify: [{ type: 'text_visible', text: 'Done' }], inputs: { User: 'secret value' },
    trace: [{ operation: 'CLICK', targetName: 'Run', target: 'e1' }],
  })
  expect(encodedMetadataCandidate).toBeUndefined()
  expect(await store.list()).toHaveLength(1)
  const rejected = await store.reject(candidate.id, 'verification failed')
  expect(rejected.state).toBe('rejected')
  await expect(selectSkill({ skillId: candidate.id, url: 'https://example.test/flights.html' }, store))
    .rejects.toThrow('Unknown verified skill')
})

it('redacts repeated inputs and special target names with per-step replay keys', async () => {
  expect(stepsFromTrajectory([
    { operation: 'TYPE_TEXT', targetName: 'Field' },
    { operation: 'TYPE_TEXT', targetName: 'Field' },
    { operation: 'TYPE_TEXT', targetName: 'Field#2' },
  ])?.map(step => step.type === 'type' ? step.input : undefined)).toEqual(['Field', 'Field#2', 'Field#2#2'])
  const { store, directory } = await fixture()
  const repeated = await createCandidateFromTrajectory(store, {
    route: 'd1', status: 'success', match: { windowTitle: 'Repeated' },
    verify: [{ type: 'text_visible', text: 'firstSecret secondSecret complete' }],
    capturedValues: [
      { targetName: 'Field', value: 'firstSecret' },
      { targetName: 'Field', value: 'secondSecret' },
    ],
    trace: [
      { operation: 'TYPE_TEXT', targetName: 'Field', target: 'e1', dispatched: true },
      { operation: 'TYPE_TEXT', targetName: 'Field', target: 'e1', dispatched: true },
      { operation: 'CLICK', targetName: 'Done', target: 'e2', dispatched: true },
    ],
  })
  expect(repeated?.steps).toEqual([
    { type: 'type', target: 'Field', input: 'Field' },
    { type: 'type', target: 'Field', input: 'Field#2' },
    { type: 'click', target: 'Done' },
  ])
  expect(repeated?.verify).toEqual([
    { type: 'text_visible', text: '{{inputs:Field}} {{inputs:Field%232}} complete' },
  ])

  const special = await createCandidateFromTrajectory(store, {
    route: 'd1', status: 'success', match: { windowTitle: 'Special' },
    verify: [{ type: 'text_visible', text: 'fieldSecret complete' }],
    capturedValues: [{ targetName: '__proto__', value: 'fieldSecret' }],
    trace: [
      { operation: 'TYPE_TEXT', targetName: '__proto__', target: 'e1', dispatched: true },
      { operation: 'CLICK', targetName: 'Done', target: 'e2', dispatched: true },
    ],
  })
  expect(special?.steps[0]).toEqual({ type: 'type', target: '__proto__', input: '__proto__' })
  expect(special?.verify).toEqual([{ type: 'text_visible', text: '{{inputs:__proto__}} complete' }])
  const inputs = JSON.parse('{"__proto__":"fieldSecret"}') as Record<string, string>
  expect(verificationForSkill(special!, inputs, [])[0]).toMatchObject({ text: 'fieldSecret complete' })
  expect(() => verificationForSkill(special!, {}, [])).toThrow('Missing structured input')
  const conflict = await createCandidateFromTrajectory(store, {
    route: 'd1', status: 'success', match: { windowTitle: 'Conflict' },
    verify: [{ type: 'text_visible', text: 'structuredSecret capturedSecret complete' }],
    inputs: { Field: 'structuredSecret' },
    capturedValues: [{ targetName: 'Field', value: 'capturedSecret' }],
    trace: [
      { operation: 'TYPE_TEXT', targetName: 'Field', target: 'e1', dispatched: true },
      { operation: 'CLICK', targetName: 'Done', target: 'e2', dispatched: true },
    ],
  })
  expect(conflict).toBeUndefined()
  const persisted = await readFile(join(directory, 'skills.json'), 'utf8')
  for (const secret of ['firstSecret', 'secondSecret', 'fieldSecret', 'structuredSecret', 'capturedSecret']) {
    expect(persisted).not.toContain(secret)
  }
})

it('does not treat fixture-like store IDs as built-in identity', async () => {
  const { store, candidate, directory } = await fixture()
  const evidence = evidenceFromRun('success', 'independently_verified_after_skill', 0, true, 1)
  await store.recordVerification(candidate.id, evidence)
  const latest = (await store.get(candidate.id))!.history.at(-1)!
  await store.publish(candidate.id, latest.id, 'user')
  const path = join(directory, 'skills.json')
  const file = JSON.parse(await readFile(path, 'utf8'))
  file.skills[0].id = 'fixture.filters'
  delete file.skills[0].match.origin
  await writeFile(path, JSON.stringify(file))
  const selected = await selectSkill({ url: 'http://localhost:1234/flights.html' }, store)
  expect(selected).toBeNull()
  await expect(selectSkill({ skillId: 'fixture.filters', url: 'http://localhost:1234/flights.html' }, store))
    .rejects.toMatchObject({ code: 'skill_origin_required' })
})

it('rejects zero-action evidence, malformed Unicode and ambiguous target capture', async () => {
  expect(evidenceFromRun('success', 'independently_verified', 0, true, 0).status).toBe('failed')
  expect(stepsFromTrajectory([
    { operation: 'TYPE_TEXT', targetName: 'Report path', targetIdentifier: 'field-unique', target: '2', dispatched: true },
  ])).toEqual([{ type: 'type', target: 'field-unique', input: 'Report path' }])
  expect(stepsFromTrajectory([
    { operation: 'PASTE_TEXT', targetName: 'Body', targetIdentifier: 'document-body', target: '4', dispatched: true },
  ])).toEqual([{ type: 'paste', target: 'document-body', input: 'Body' }])
  const { store } = await fixture()
  await expect(createCandidateFromTrajectory(store, {
    route: 'd1', status: 'success', match: { windowTitle: 'Unicode' },
    verify: [{ type: 'text_visible', text: 'Done' }],
    inputs: { Field: '\uD800' },
    trace: [{ operation: 'TYPE_TEXT', targetName: 'Field', target: '1', dispatched: true }],
  })).resolves.toBeUndefined()
})

it('serializes verification and publication mutations without losing the latest evidence', async () => {
  const { store, candidate } = await fixture()
  const passed = evidenceFromRun('success', 'independently_verified_after_skill', 0, true, 1)
  await store.recordVerification(candidate.id, passed)
  const latest = (await store.get(candidate.id))!.history.at(-1)!
  const failedWrite = store.recordVerification(candidate.id, evidenceFromRun('failed', 'independent_failure', 0, true, 1))
  const publication = store.publish(candidate.id, latest.id, 'user')
  await failedWrite
  await expect(publication).rejects.toThrow('verification_required')
  const current = await store.get(candidate.id)
  expect(current?.state).toBe('candidate')
  expect(current?.history.at(-1)?.status).toBe('failed')
})

it('loads but never replays legacy records without an origin or postconditions', async () => {
  const { store, candidate, directory } = await fixture()
  const evidence = evidenceFromRun('success', 'independently_verified_after_skill', 0, true, 1)
  await store.recordVerification(candidate.id, evidence)
  const latest = (await store.get(candidate.id))!.history.at(-1)!
  await store.publish(candidate.id, latest.id, 'user')
  const path = join(directory, 'skills.json')
  const file = JSON.parse(await readFile(path, 'utf8'))
  delete file.skills[0].match.origin
  await writeFile(path, JSON.stringify(file))
  expect(await selectSkill({ url: 'https://example.test/flights.html' }, store)).toBeNull()
  await expect(selectSkill({ skillId: candidate.id, url: 'https://example.test/flights.html' }, store))
    .rejects.toMatchObject({ code: 'skill_origin_required' })

  delete file.skills[0].verify
  await writeFile(path, JSON.stringify(file))
  expect(await selectSkill({ url: 'https://example.test/flights.html' }, store)).toBeNull()
  await expect(selectSkill({ skillId: candidate.id, url: 'https://example.test/flights.html' }, store))
    .rejects.toMatchObject({ code: 'skill_verification_required' })
})
