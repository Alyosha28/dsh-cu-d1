/**
 * CR-09 — Skill input sanitising and hydration.
 *
 *  a) The placeholder guard works for captured (TYPE_TEXT) values — control group.
 *  b) Values that never enter the capture map are persisted verbatim: the redaction
 *     is only as wide as `inputs`, and D1 only ever captures TYPE_TEXT.
 *  c) `verificationForSkill` concatenates the Skill's assertions with the caller's
 *     and then enforces `max(12)` on the sum. SKILL.md rule 1 makes a caller
 *     assertion mandatory, so *any* published Skill that carries 12 assertions
 *     can never be replayed: the replay throws a raw ZodError.
 *  d) Hydration is single-pass: an input value cannot inject a second placeholder.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createCandidateFromTrajectory } from '../../../packages/dsh-cu-core/src/skill-builder.ts'
import { SkillStore } from '../../../packages/dsh-cu-core/src/skill-store.ts'
import { sanitizeSkillVerifications, verificationForSkill } from '../../../packages/dsh-cu-core/src/skills.ts'

const dirs: string[] = []
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cr09-'))
  dirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
})

const SECRET = 'hunter2-0TP'

describe('CR-09 skill sanitising and hydration', () => {
  it('replaces captured literal values with placeholders (control that holds)', () => {
    const sanitized = sanitizeSkillVerifications(
      [{ type: 'text_visible', text: `Signed in as ${SECRET}` }],
      { Password: SECRET },
    )
    expect(sanitized).toEqual([{ type: 'text_visible', text: 'Signed in as {{inputs:Password}}' }])
  })

  it('rejects pre-injected placeholders and percent-encoded duplicates (control that holds)', () => {
    expect(sanitizeSkillVerifications([{ type: 'text_visible', text: '{{inputs:X}} ok' }], {})).toBeNull()
    expect(sanitizeSkillVerifications(
      [{ type: 'text_visible', text: `a%20b ${'a b'}` }], { X: 'a b' },
    )).toBeNull()
  })

  it('values outside the capture map are persisted verbatim into the Skill file', async () => {
    const dir = await temp()
    const path = join(dir, 'skills.json')
    const store = new SkillStore(path)
    // A trajectory as produced by any caller that does not supply capturedValues.
    const candidate = await createCandidateFromTrajectory(store, {
      route: 'd1', status: 'success',
      trace: [{ operation: 'TYPE_TEXT', targetName: 'Password', dispatched: true }],
      verify: [{ type: 'text_visible', text: `Signed in as ${SECRET}` }],
      match: { urlPath: '/login', origin: 'https://shop.example' },
      risk: 'reversible',
    })
    expect(candidate).toBeDefined()
    const file = await readFile(path, 'utf8')
    expect(file).toContain(SECRET)                      // plaintext secret on disk
    expect(file).not.toContain('{{inputs:Password}}')
  })

  it('hydration is single-pass, so an input cannot inject another placeholder', () => {
    const skill = {
      id: 's', version: 1, verifiedAt: 'x', fallback: 'd1', risk: 'reversible',
      match: { urlPath: '/x', origin: 'https://a.example' },
      verify: [{ type: 'text_visible', text: 'value={{inputs:A}}' }],
      steps: [{ type: 'click', target: 'Go' }],
    } as any
    const [assertion] = verificationForSkill(skill, { A: '{{inputs:B}}' }, [{ type: 'text_visible', text: 'ok' }])
    expect((assertion as any).text).toBe('value={{inputs:B}}')
  })

  it('the merged assertion list is never re-validated (max 12 does not hold for the effective set)', () => {
    const assertions = Array.from({ length: 12 }, (_, index) => ({ type: 'text_visible' as const, text: `t${index}` }))
    const skill = {
      id: 's12', version: 1, verifiedAt: 'x', fallback: 'd1', risk: 'reversible',
      match: { urlPath: '/x', origin: 'https://a.example' },
      verify: assertions,
      steps: [{ type: 'click', target: 'Go' }],
    } as any
    const merged = verificationForSkill(skill, undefined, [{ type: 'text_visible', text: 'caller' }])
    expect(merged).toHaveLength(13)   // contract.ts documents verify as max(12)
  })

  it('any trajectory containing a PASTE_TEXT step is silently uncapturable', async () => {
    const dir = await temp()
    const store = new SkillStore(join(dir, 'skills.json'))
    const base = {
      route: 'd1', status: 'success',
      verify: [{ type: 'text_visible', text: 'Saved' }],
      match: { urlPath: '/x', origin: 'https://a.example' },
      risk: 'reversible' as const,
    }
    // D1 only records TYPE_TEXT into capturedValues, so the positional index the
    // builder computes for a paste can never line up.
    const pasteOnly = await createCandidateFromTrajectory(store, {
      ...base,
      trace: [{ operation: 'PASTE_TEXT', targetName: 'API key', dispatched: true }],
      capturedValues: [],
    })
    expect(pasteOnly).toBeUndefined()
    const mixed = await createCandidateFromTrajectory(store, {
      ...base,
      trace: [
        { operation: 'TYPE_TEXT', targetName: 'Email', dispatched: true },
        { operation: 'PASTE_TEXT', targetName: 'API key', dispatched: true },
      ],
      capturedValues: [{ targetName: 'Email', value: 'a@b.example' }],
    })
    expect(mixed).toBeUndefined()
  })
})
