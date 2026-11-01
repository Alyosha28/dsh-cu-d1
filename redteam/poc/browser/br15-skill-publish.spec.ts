/**
 * BR-15 — the Skill publication approval shows counts, not content.
 *
 * index.ts:233-244 `skillDetail()` renders scope, risk, step count, assertion
 * count and evidence age. The human approving publication never sees the step
 * targets, the typed values or the assertion text of the macro they are about to
 * make replayable by any page on that origin.
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
import * as Provider from '../../../packages/dsh-browser-use-d1/src/index.ts'
import { createCandidateFromTrajectory, evidenceFromRun } from '@albaincompleta/dsh-cu-core/skill-builder'
import { SkillStore } from '@albaincompleta/dsh-cu-core/skill-store'
import { executeToolFixture } from '@albaincompleta/dsh-cu-testkit'
import { FakeUserQuestions } from '../../../packages/dsh-browser-use-d1/tests/approval-fixtures.ts'
import { CHROME } from './harness.ts'

class NoModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('skill publication must not call the Session model') }
}

let ctx: Context
let agent: Agent
let tempRoot: string
let storePath: string

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'br15-publish-'))
  storePath = join(tempRoot, 'skills.json')
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(BrowserUseRegistry)
  ctx.llm.registerAdapter(['fixture'], new NoModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  agent = await harness.create(SessionId('br15'), { provider: 'fixture', model: 'structured' })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(tempRoot, { recursive: true, force: true })
})

it('approves publication of a destructive macro without showing what it does', async () => {
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
  await store.recordVerification(candidate!.id, evidenceFromRun('success', 'independently_verified', 0, true, 2))

  const questions = new FakeUserQuestions(true)
  ctx.provide('userQuestions', questions)
  await ctx.plugin(Provider, {
    mode: 'launch', executablePath: CHROME, headless: true,
    decisionToken: 'redteam', skillStorePath: storePath,
  })

  const result = await executeToolFixture(ctx, {
    agent, name: 'browser_skill_publish', arguments: { skillId: candidate!.id },
    callId: ToolCallId('br15-publish'), signal: new AbortController().signal,
  })
  expect((result.content[0] as { text: string }).text).toContain('"status":"success"')
  expect(questions.calls).toHaveLength(1)
  const detail = (questions.calls[0]!.questions[0] as { detail: string }).detail
  console.log('[BR-15] publication approval detail:\n' + detail)
  // Scope and counts only: no step targets, no assertion text.
  expect(detail).toContain('https://bank.example/admin')
  expect(detail).toContain('Steps: 2')
  expect(detail).not.toContain('Delete beneficiary')
  expect(detail).not.toContain('Beneficiary removed')
})
