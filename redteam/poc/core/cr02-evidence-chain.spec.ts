/**
 * CR-02 — The Skill evidence chain is self-attested.
 *
 *  a) `evidenceFromRun(..., independent=false, ...)` still writes `independent: true`.
 *  b) `recordVerification` accepts any caller-authored "passed" evidence; no run is
 *     required, no signature ties the evidence to the runner that produced it.
 *  c) `publish(id, evidenceId, 'user')` is a runtime string compare, so the
 *     "explicit user approval" gate is only as strong as the caller's argument.
 *
 * Contract under test: ARCHITECTURE_PLAN.md §7.1 ("新上下文独立复跑 → 用户批准该候选"),
 * §8 ("不由模型批准自己"), SKILL.md rule 7.
 */
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createCandidateFromTrajectory, evidenceFromRun } from '../../../packages/dsh-cu-core/src/skill-builder.ts'
import { SkillStore } from '../../../packages/dsh-cu-core/src/skill-store.ts'

const dirs: string[] = []
async function store(): Promise<SkillStore> {
  const dir = await mkdtemp(join(tmpdir(), 'cr02-'))
  dirs.push(dir)
  return new SkillStore(join(dir, 'skills.json'))
}
afterAll(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
})

const trajectory = {
  route: 'd1',
  status: 'success',
  trace: [{ operation: 'CLICK', targetName: 'Approve transfer', dispatched: true }],
  verify: [{ type: 'text_visible', text: 'Transfer sent' }],
  match: { urlPath: '/transfer', origin: 'https://bank.example' },
  risk: 'reversible' as const,
}

describe('CR-02 evidence chain', () => {
  it('evidenceFromRun hardcodes independent:true even when the run was not independent', () => {
    const notIndependent = evidenceFromRun('success', 'model_says_done', 0, false, 1)
    expect(notIndependent.independent).toBe(true)      // the 4th argument is ignored
    expect(notIndependent.status).toBe('failed')       // ...and only status reflects it

    const failedRun = evidenceFromRun('failed', 'verification_failed', 3, true, 1)
    expect(failedRun.independent).toBe(true)           // still advertised as independent
  })

  it('publishes a "verified" Skill from caller-written evidence with no run at all', async () => {
    const s = await store()
    const candidate = await createCandidateFromTrajectory(s, trajectory)
    expect(candidate?.state).toBe('candidate')

    // Any in-process caller can mint the evidence. Nothing binds it to a runner,
    // a run id, a session, or the verification assertions in the record.
    await s.recordVerification(candidate!.id, {
      status: 'passed',
      independent: true,
      at: new Date().toISOString(),
      summary: 'trust_me',
    })
    const latest = (await s.get(candidate!.id))!.history.at(-1)!
    const published = await s.publish(candidate!.id, latest.id, 'user')

    expect(published.state).toBe('verified')
    // The published record is now approval-free on every future replay (see CR-01).
    const file = JSON.parse(await readFile(join(dirs.at(-1)!, 'skills.json'), 'utf8'))
    expect(file.skills[0].state).toBe('verified')
    expect(file.skills[0].history.at(-1).summary).toBe('trust_me')
  })

  it('the shipped code never produces evidence, so the documented lifecycle cannot complete', async () => {
    const s = await store()
    const candidate = await createCandidateFromTrajectory(s, trajectory)
    expect(candidate!.history).toEqual([])
    // browser_skill_publish / computer_skill_publish compute latestEvidenceId from
    // history and bail out when it is absent (index.ts:645-648).
    await expect(s.publish(candidate!.id, undefined as unknown as string, 'user')).rejects.toThrow()
    const source = readFileSync(new URL('../../../packages/dsh-browser-use-d1/src/index.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/recordVerification\(/)
    const grepTargets = ['controller.ts', 'index.ts', 'skill-runner.ts']
    for (const file of grepTargets) {
      const text = readFileSync(new URL(`../../../packages/dsh-browser-use-d1/src/${file}`, import.meta.url), 'utf8')
      expect(text).not.toMatch(/recordVerification\(/)
    }
  })

  it('the approvedBy gate is a string compare, and verifiedAt is caller-controlled', async () => {
    const s = await store()
    const candidate = await createCandidateFromTrajectory(s, trajectory)
    await s.recordVerification(candidate!.id, {
      status: 'passed', independent: true, at: '1999-01-01T00:00:00.000Z', summary: 'ok',
    })
    const latest = (await s.get(candidate!.id))!.history.at(-1)!

    await expect(s.publish(candidate!.id, latest.id, 'system')).rejects.toThrow('approval_required')
    // 'user' is not a capability, it is a literal. Casting is enough.
    const published = await s.publish(candidate!.id, latest.id, 'user' as 'user')
    expect(published.state).toBe('verified')
    // The published "verification time" is whatever the evidence author typed.
    expect(published.verifiedAt).toBe('1999-01-01T00:00:00.000Z')
  })

  it('the user-facing publish prompt never shows the steps being approved', () => {
    const source = readFileSync(
      new URL('../../../packages/dsh-browser-use-d1/src/index.ts', import.meta.url),
      'utf8',
    )
    const detail = source.slice(source.indexOf('function skillDetail'), source.indexOf('function skillDetail') + 700)
    expect(detail).toMatch(/Steps: \$\{summary\.steps\}/)
    expect(detail).not.toMatch(/step\.target|targetName|\.steps\.map/)
    // A user approving "Steps: 3" cannot see that one of them is "Approve transfer".
  })
})
