/**
 * CR-01 / CR-03 — a Skill may not lower the caller's risk, and a Skill may only
 * replay on the provider that owns its match scope.
 */
import { describe, expect, it } from 'vitest'
import { assertSkillProvider, skillPolicy, SkillError } from '../src/skills.ts'
import type { VerifiedSkill } from '../src/skills.ts'

function skill(partial: Partial<VerifiedSkill> = {}): VerifiedSkill {
  return {
    id: 'skill_test', version: 1, verifiedAt: 'now',
    match: { urlPath: '/checkout' }, fallback: 'd1', risk: 'reversible',
    verify: [{ type: 'text_visible', text: 'Done' }],
    steps: [{ type: 'click', target: 'Pay' }],
    ...partial,
  } as VerifiedSkill
}

describe('skillPolicy — risk is a maximum, never a replacement', () => {
  it('takes the maximum of caller, skill and config floor', () => {
    expect(skillPolicy({ risk: 'read_only' }, skill({ risk: 'reversible' }), {}).risk).toBe('reversible')
    expect(skillPolicy({ risk: 'consequential' }, skill({ risk: 'reversible' }), {}).risk).toBe('consequential')
    expect(skillPolicy(undefined, skill({ risk: 'reversible' }), { minRisk: 'consequential' }).risk).toBe('consequential')
    expect(skillPolicy(undefined, skill({ risk: 'consequential' }), { minRisk: 'reversible' }).risk).toBe('consequential')
  })

  it('keeps credentialsAvailable from the caller and allow* only from config', () => {
    expect(skillPolicy({ credentialsAvailable: false }, skill(), {})).toMatchObject({ credentialsAvailable: false })
    expect(skillPolicy({ credentialsAvailable: false, allowLogin: true } as any, skill(), {}).allowLogin).toBeUndefined()
    expect(skillPolicy(undefined, skill(), { preauthorizeLogin: true })).toMatchObject({ allowLogin: true })
  })

  it('rejects a read_only Skill that carries mutating steps', () => {
    const mutating = skill({ risk: 'read_only', steps: [{ type: 'type', target: 'Card', input: 'Card' }] })
    expect(() => skillPolicy(undefined, mutating, {})).toThrow(SkillError)
    expect(() => skillPolicy(undefined, mutating, {})).toThrowError(expect.objectContaining({ code: 'skill_read_only_mutation' }))
    // clicking is mutating too; a wait-only Skill is genuinely read-only
    expect(() => skillPolicy(undefined, skill({ risk: 'read_only' }), {}))
      .toThrowError(expect.objectContaining({ code: 'skill_read_only_mutation' }))
    expect(skillPolicy({ risk: 'read_only' }, skill({ risk: 'read_only', steps: [{ type: 'wait', ms: 10 }] }), {}).risk).toBe('read_only')
  })
})

describe('assertSkillProvider — CR-03 cross-provider replay', () => {
  it('requires urlPath for the browser provider', () => {
    expect(() => assertSkillProvider(skill(), 'browser')).not.toThrow()
    expect(() => assertSkillProvider(skill({ match: { windowTitle: 'Editor' } }), 'browser'))
      .toThrowError(expect.objectContaining({ code: 'skill_provider_mismatch' }))
    expect(() => assertSkillProvider(skill({ match: { appBundleId: 'com.apple.finder' } }), 'browser'))
      .toThrowError(expect.objectContaining({ code: 'skill_provider_mismatch' }))
  })

  it('requires windowTitle or appBundleId for the native provider', () => {
    expect(() => assertSkillProvider(skill({ match: { windowTitle: 'Editor' } }), 'native')).not.toThrow()
    expect(() => assertSkillProvider(skill({ match: { appBundleId: 'com.apple.finder' } }), 'native')).not.toThrow()
    expect(() => assertSkillProvider(skill(), 'native'))
      .toThrowError(expect.objectContaining({ code: 'skill_provider_mismatch' }))
  })
})
