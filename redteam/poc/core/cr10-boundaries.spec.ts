/**
 * CR-10 — Controls that actually hold (verified boundaries, not findings).
 *
 * These are the places where the same audit tried the obvious bypass and the code
 * refused. They are recorded so the report does not over-claim.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkTargetAmbiguity } from '../../../packages/dsh-cu-core/src/policy.ts'
import { assertSkillOrigin, selectSkill, verifiedSkillSchema } from '../../../packages/dsh-cu-core/src/skills.ts'
import { createCandidateFromTrajectory } from '../../../packages/dsh-cu-core/src/skill-builder.ts'
import { SkillStore } from '../../../packages/dsh-cu-core/src/skill-store.ts'
import { RunController } from '../../../packages/dsh-cu-core/src/run-controller.ts'
import { verifyAll } from '../../../packages/dsh-browser-use-d1/src/dom.ts'
import { FakePage } from './fake-page.ts'

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
})

const base = {
  id: 's', version: 1, verifiedAt: 'x', fallback: 'd1' as const, risk: 'reversible' as const,
  verify: [{ type: 'text_visible' as const, text: 'ok' }],
  steps: [{ type: 'click' as const, target: 'Go' }],
}

describe('CR-10 boundaries that hold', () => {
  it('origin pinning is canonical: case, default port, userinfo and paths are rejected', () => {
    const accept = (origin: string) => verifiedSkillSchema.safeParse({ ...base, match: { urlPath: '/x', origin } }).success
    expect(accept('https://shop.example')).toBe(true)
    expect(accept('http://localhost:3000')).toBe(true)
    expect(accept('https://SHOP.example')).toBe(false)
    expect(accept('https://shop.example:443')).toBe(false)
    expect(accept('https://user:pw@shop.example')).toBe(false)
    expect(accept('https://shop.example/x')).toBe(false)
    expect(accept('ftp://shop.example')).toBe(false)

    const skill = verifiedSkillSchema.parse({ ...base, match: { urlPath: '/x', origin: 'https://shop.example' } })
    expect(() => assertSkillOrigin(skill, 'https://shop.example.evil.example/x')).toThrow()
    expect(() => assertSkillOrigin(skill, 'https://shop.example.')).toThrow()
    expect(() => assertSkillOrigin(skill, 'https://shop.example:8443/x')).toThrow()
    expect(() => assertSkillOrigin(skill, 'https://shop.example/x')).not.toThrow()
  })

  it('two published Skills matching one URL fail closed instead of picking one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cr10-'))
    dirs.push(dir)
    const store = new SkillStore(join(dir, 'skills.json'))
    const make = async (target: string) => {
      const candidate = await createCandidateFromTrajectory(store, {
        route: 'd1', status: 'success',
        trace: [{ operation: 'CLICK', targetName: target, dispatched: true }],
        verify: [{ type: 'text_visible', text: 'ok' }],
        match: { urlPath: '/search', origin: 'https://air.example' },
        risk: 'reversible',
      })
      await store.recordVerification(candidate!.id, {
        status: 'passed', independent: true, at: new Date().toISOString(), summary: 'ok',
      })
      const latest = (await store.get(candidate!.id))!.history.at(-1)!
      await store.publish(candidate!.id, latest.id, 'user')
    }
    await make('Search flights')
    await make('Search hotels')
    expect((await store.list('verified')).length).toBe(2)
    expect(await selectSkill({ url: 'https://air.example/search' }, store)).toBeNull()
  })

  it('an unsupported assertion type never verifies true', async () => {
    const page = new FakePage('https://a.example/', [])
    expect(await verifyAll(page as any, [{ type: 'custom', name: 'fs.exists', args: {} }] as any)).toBe(false)
    expect(await verifyAll(page as any, [{ type: 'nonsense' }] as any)).toBe(false)
  })

  it('same-name duplicate targets escalate instead of being guessed', () => {
    const observation = {
      snapshot_id: 's', version: 1, url: 'https://a.example/', title: 't', truncated: false,
      can_scroll_up: false, can_scroll_down: false,
      elements: [
        { id: '1', role: 'button', name: 'Delete', value: null, actions: ['click'], enabled: true, focused: false, context: 'Row A' },
        { id: '2', role: 'button', name: 'Delete', value: null, actions: ['click'], enabled: true, focused: false, context: 'Row B' },
      ],
    }
    const stop = checkTargetAmbiguity(observation as any, { operation: 'CLICK', target: '1' } as any, 'delete the report')
    expect(stop).toMatchObject({ status: 'escalated', reason: 'ambiguous_target' })
    // ...but a goal that names exactly one context unlocks that one.
    expect(checkTargetAmbiguity(observation as any, { operation: 'CLICK', target: '1' } as any, 'delete Row A')).toBeNull()
  })

  it('free-text failure reasons are mapped to a stable code before they reach control state or audit', () => {
    const controller = new RunController(undefined)
    const agent = { id: 'a' } as any
    controller.start(agent, 'browser_subgoal')
    controller.finish(agent, 'escalated', 'Error: connect ECONNREFUSED 127.0.0.1:8765 token=abc')
    expect(controller.status(agent).last?.reason).toBe('tool_execution_failed')
  })
})
