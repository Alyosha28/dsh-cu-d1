/**
 * BR-15 — the Skill publication approval must show what the macro does.
 *
 * A count ("Steps: 2") is not consent: the human approving publication sees
 * every step target, every verification assertion and the risk the Skill will
 * replay under, and the publication itself is bound to that approval (CR-02).
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Provider from '../src/index.ts'
import { createCandidateFromTrajectory } from '@albaincompleta/dsh-cu-core/skill-builder'
import { SkillStore } from '@albaincompleta/dsh-cu-core/skill-store'
import { executeToolFixture } from '@albaincompleta/dsh-cu-testkit'
import { CHROME } from './fixtures.ts'
import { FakeUserQuestions } from './approval-fixtures.ts'

class NoModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('publication must not call the Session model') }
}

let ctx: Context
let agent: Agent
let tempRoot: string
let storePath: string

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-publish-detail-'))
  storePath = join(tempRoot, 'skills.json')
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(BrowserUseRegistry)
  ctx.llm.registerAdapter(['fixture'], new NoModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  agent = await harness.create(SessionId('publish-detail'), { provider: 'fixture', model: 'structured' })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(tempRoot, { recursive: true, force: true })
})

async function candidateWithEvidence() {
  const store = new SkillStore(storePath)
  const candidate = await createCandidateFromTrajectory(store, {
    route: 'd1', status: 'success',
    match: { urlPath: '/admin', origin: 'https://bank.example' },
    verify: [{ type: 'text_visible', text: 'Beneficiary removed' }],
    trace: [
      { operation: 'CLICK', targetName: 'Delete beneficiary', target: 'e3' },
      { operation: 'TYPE_TEXT', targetName: 'Amount', target: 'e5' },
    ],
  })
  const session = await store.beginVerification(candidate!.id)
  await store.finishVerification(session.token, { status: 'passed', summary: 'independently_verified' })
  return candidate!.id
}

it('shows step targets and assertion text, not just counts', async () => {
  const skillId = await candidateWithEvidence()
  const questions = new FakeUserQuestions(true)
  ctx.provide('userQuestions', questions)
  await ctx.plugin(Provider, {
    mode: 'launch', executablePath: CHROME, headless: true,
    decisionToken: 'unused', skillStorePath: storePath,
  })
  const result = await executeToolFixture(ctx, {
    agent, name: 'browser_skill_publish', arguments: { skillId },
    callId: ToolCallId('publish-detail'), signal: new AbortController().signal,
  })
  expect(result.isError).toBe(false)
  expect((result.content[0] as { text: string }).text).toContain('"status":"success"')

  expect(questions.calls).toHaveLength(1)
  const detail = (questions.calls[0]!.questions[0] as { detail: string }).detail
  expect(detail).toContain('https://bank.example/admin')
  expect(detail).toContain('Delete beneficiary')
  expect(detail).toContain('Amount')
  expect(detail).toContain('Beneficiary removed')
  expect(detail).toContain('click')
  expect(detail).toContain('Risk:')
})

it('truncates long step lists instead of hiding them entirely', async () => {
  const store = new SkillStore(storePath)
  const steps = Array.from({ length: 20 }, (_value, index) => ({ type: 'click' as const, target: `Row ${index + 1}` }))
  const candidate = await store.createCandidate({
    match: { urlPath: '/admin', origin: 'https://bank.example' },
    fallback: 'human', risk: 'consequential',
    verify: [
      { type: 'text_visible', text: 'Saved' },
      { type: 'url_contains', value: '/admin' },
    ],
    steps,
  })
  const session = await store.beginVerification(candidate.id)
  await store.finishVerification(session.token, { status: 'passed', summary: 'independently_verified' })

  const questions = new FakeUserQuestions(false)
  ctx.provide('userQuestions', questions)
  await ctx.plugin(Provider, {
    mode: 'launch', executablePath: CHROME, headless: true,
    decisionToken: 'unused', skillStorePath: storePath,
  })
  const result = await executeToolFixture(ctx, {
    agent, name: 'browser_skill_publish', arguments: { skillId: candidate.id },
    callId: ToolCallId('publish-truncate'), signal: new AbortController().signal,
  })
  expect(result.isError).toBe(false)
  const value = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
  // A denied approval publishes nothing (CR-02): the nonce is never minted.
  expect(value).toMatchObject({ status: 'confirmation_required', reason: 'denied_by_user', skillId: candidate.id })
  expect((await store.get(candidate.id))?.state).toBe('candidate')

  const detail = (questions.calls[0]!.questions[0] as { detail: string }).detail
  expect(detail).toContain('Row 1')
  expect(detail).toContain('Row 12')
  expect(detail).not.toContain('Row 13')
  expect(detail).toContain('8 more step(s) not shown')
  expect(detail).toContain('/admin')
})

it('refuses to publish a candidate that has no evidence at all', async () => {
  const store = new SkillStore(storePath)
  const candidate = await store.createCandidate({
    match: { urlPath: '/admin', origin: 'https://bank.example' },
    fallback: 'human', risk: 'reversible',
    verify: [{ type: 'text_visible', text: 'Saved' }],
    steps: [{ type: 'click', target: 'Save' }],
  })
  const questions = new FakeUserQuestions(true)
  ctx.provide('userQuestions', questions)
  await ctx.plugin(Provider, {
    mode: 'launch', executablePath: CHROME, headless: true,
    decisionToken: 'unused', skillStorePath: storePath,
  })
  // The tool fails before prompting when the store holds no evidence, so no
  // approval is asked for something that cannot be published anyway.
  const attempt = await executeToolFixture(ctx, {
    agent, name: 'browser_skill_publish', arguments: { skillId: candidate.id },
    callId: ToolCallId('publish-no-evidence'), signal: new AbortController().signal,
  })
  expect(attempt.isError).toBe(true)
  expect(JSON.stringify(attempt.content)).toContain('verification_required')
  expect(questions.calls).toEqual([])
})
