import { expect, it } from 'vitest'
import {
  assertSkillOrigin,
  assertSkillScope,
  decisionForSkillStep,
  sanitizeSkillVerifications,
  selectSkill,
  SkillError,
  verificationForSkill,
} from '../src/skills.ts'
import type { VerifiedSkill } from '../src/skills.ts'

it('selects built-in fixture Skills only by explicit ID at a compatible location', async () => {
  const url = 'http://localhost:1234/filters.html'
  expect((await selectSkill({ skillId: 'fixture.filters', url }))?.id).toBe('fixture.filters')
  expect(await selectSkill({ url })).toBeNull()
  expect(await selectSkill({ url: 'http://localhost:1234/unknown.html' })).toBeNull()
  expect(await selectSkill({ url: 'https://example.test/filters.html' })).toBeNull()
  await expect(selectSkill({ skillId: 'fixture.filters' })).rejects.toMatchObject({ code: 'skill_location_required' })
  await expect(selectSkill({ skillId: 'fixture.filters', url: 'https://example.test/filters.html' }))
    .rejects.toMatchObject({ code: 'skill_origin_mismatch' })
  await expect(selectSkill({ skillId: 'missing', url })).rejects.toThrow('Unknown verified skill')
})

it('enforces native application and window scope', () => {
  const application = {
    id: 'skill_app', version: 1, verifiedAt: 'now', match: { appBundleId: 'com.example.editor' },
    fallback: 'human' as const, risk: 'reversible' as const,
    verify: [{ type: 'text_visible' as const, text: 'Done' }], steps: [{ type: 'click' as const, target: 'Run' }],
  }
  expect(() => assertSkillScope(application, { appBundleId: 'com.example.editor' })).not.toThrow()
  expect(() => assertSkillScope(application, { appBundleId: 'com.example.other' })).toThrow(expect.objectContaining({ code: 'skill_application_mismatch' }))
  expect(() => assertSkillScope(application, {})).toThrow(expect.objectContaining({ code: 'skill_application_required' }))
  const window = { ...application, match: { windowTitle: 'Document A' } }
  expect(() => assertSkillScope(window, { windowTitle: 'Document B' })).toThrow(expect.objectContaining({ code: 'skill_window_mismatch' }))
})

it('rechecks the origin throughout replay but permits same-origin path changes', () => {
  const skill = {
    id: 'skill_origin_guard', version: 1, verifiedAt: 'now',
    match: { urlPath: '/start', origin: 'https://trusted.test' },
    fallback: 'd1', risk: 'reversible', steps: [{ type: 'click' as const, target: 'Go' }],
    verify: [{ type: 'text_visible' as const, text: 'Done' }],
  } satisfies VerifiedSkill
  expect(() => assertSkillOrigin(skill, 'https://trusted.test/next')).not.toThrow()
  expect(() => assertSkillOrigin(skill, 'https://attacker.test/next'))
    .toThrowError(expect.objectContaining({ code: 'skill_origin_mismatch' }))
})

it('converts skill steps using observed identifiers and structured inputs', () => {
  const observation = {
    elements: [{ id: 'e1', role: 'textbox', name: 'Report path', value: '', actions: ['type', 'paste'], enabled: true, focused: false }],
  } as any
  expect(decisionForSkillStep({ type: 'type', target: 'Report path', input: 'Report path' }, observation, {
    'Report path': '/tmp/report.csv',
  })).toMatchObject({ operation: 'TYPE_TEXT', target: 'e1', text: '/tmp/report.csv' })
  expect(decisionForSkillStep({ type: 'paste', target: 'Report path', input: 'Report path' }, observation, {
    'Report path': '/tmp/report.csv',
  })).toMatchObject({ operation: 'PASTE_TEXT', target: 'e1', text: '/tmp/report.csv' })
  expect(() => decisionForSkillStep({ type: 'type', target: 'Report path', input: 'Report path' }, observation, {}))
    .toThrow('Missing structured input')
  expect(() => decisionForSkillStep({ type: 'click', target: 'Missing' }, observation, {}))
    .toThrow('Skill target is unavailable')
})

it('redacts verification values and hydrates them only for replay', () => {
  const verify = [
    { type: 'text_visible' as const, text: 'Zürich to London · 2026-11-01' },
    { type: 'input_value' as const, label: 'Report path', value: '/tmp/report.csv' },
  ]
  const inputs = {
    From: 'Zürich', To: 'London', 'Departure date': '2026-11-01', 'Report path': '/tmp/report.csv',
  }
  const sanitized = sanitizeSkillVerifications(verify, inputs)
  expect(sanitized).toEqual([
    { type: 'text_visible', text: '{{inputs:From}} to {{inputs:To}} · {{inputs:Departure%20date}}' },
    { type: 'input_value', label: 'Report path', value: '{{inputs:Report%20path}}' },
  ])
  expect(JSON.stringify(sanitized)).not.toContain('Zürich')
  expect(JSON.stringify(sanitized)).not.toContain('/tmp/report.csv')
  const skill = {
    id: 'skill_test', version: 1, verifiedAt: 'now', match: { windowTitle: 'Fixture' },
    fallback: 'd1', risk: 'reversible', steps: [{ type: 'click' as const, target: 'Run' }], verify: sanitized!,
  } satisfies VerifiedSkill
  expect(verificationForSkill(skill, inputs, [{ type: 'text_visible', text: 'Done' }])).toEqual([
    ...verify,
    { type: 'text_visible', text: 'Done' },
  ])
  expect(() => verificationForSkill(skill, {}, [])).toThrow('Missing structured input')
  expect(sanitizeSkillVerifications([{ type: 'text_visible', text: 'same' }], { A: 'same', B: 'same' })).toBeNull()
  expect(sanitizeSkillVerifications([{ type: 'text_visible', text: '{{inputs:From}}' }], {})).toBeNull()
  expect(sanitizeSkillVerifications([{ type: 'text_visible', text: 'secret%20value complete' }], { Field: 'secret value' })).toBeNull()
})

it('redacts newlines, quotes, and backslashes in captured input values', () => {
  const multiline = 'line1\nline2'
  const quoted = '"secret"'
  const windowsPath = 'C:\\temp'
  const verify = [
    { type: 'text_visible' as const, text: `${multiline} ${quoted}` },
    { type: 'input_value' as const, label: 'Path', value: windowsPath },
    { type: 'custom' as const, name: 'state', args: { [`path ${windowsPath}`]: windowsPath } },
  ]
  const sanitized = sanitizeSkillVerifications(verify, { Notes: multiline, Secret: quoted, Path: windowsPath })
  expect(sanitized).toEqual([
    { type: 'text_visible', text: '{{inputs:Notes}} {{inputs:Secret}}' },
    { type: 'input_value', label: 'Path', value: '{{inputs:Path}}' },
    { type: 'custom', name: 'state', args: { 'path {{inputs:Path}}': '{{inputs:Path}}' } },
  ])
  expect(JSON.stringify(sanitized)).not.toContain(multiline)
  expect(JSON.stringify(sanitized)).not.toContain(quoted)
  expect(JSON.stringify(sanitized)).not.toContain(windowsPath)
})

it('rejects legacy Skills without persisted postconditions', () => {
  const legacy = {
    id: 'legacy', version: 1, verifiedAt: 'then', match: { windowTitle: 'Fixture' },
    fallback: 'd1', risk: 'reversible', steps: [{ type: 'click' as const, target: 'Run' }],
  } satisfies VerifiedSkill
  expect(() => verificationForSkill(legacy, {}, [])).toThrow(SkillError)
  expect(() => verificationForSkill(legacy, {}, [])).toThrowError(expect.objectContaining({ code: 'skill_verification_required' }))
})
