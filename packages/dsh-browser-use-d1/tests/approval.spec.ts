import { executeToolFixture } from '@alyosha28/dsh-cu-testkit'
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
import { createCandidateFromTrajectory, evidenceFromRun } from '@alyosha28/dsh-cu-core/skill-builder'
import { SkillStore } from '@alyosha28/dsh-cu-core/skill-store'
import { CHROME, close, decisionServer, fixtureServer, listen } from './fixtures.ts'
import { FakeUserQuestions } from './approval-fixtures.ts'


class IndependentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('approval test called the Session model') }
}

let ctx: Context
let agent: Agent
let fixtures: ReturnType<typeof fixtureServer>
let decisions: ReturnType<typeof decisionServer>
let fixtureUrl: string
let decisionUrl: string
let tempRoot: string
let storePath: string
const token = 'approval-token'

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-approvals-'))
  storePath = join(tempRoot, 'skills.json')
  fixtures = fixtureServer()
  decisions = decisionServer(token)
  ;[fixtureUrl, decisionUrl] = await Promise.all([listen(fixtures), listen(decisions)])
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(BrowserUseRegistry)
  ctx.llm.registerAdapter(['fixture'], new IndependentSessionModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  agent = await harness.create(SessionId('approval-test'), { provider: 'fixture', model: 'structured' })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await Promise.all([close(fixtures), close(decisions)])
  await rm(tempRoot, { recursive: true, force: true })
})

function config(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'launch', executablePath: CHROME, headless: true,
    decisionEndpoint: decisionUrl, decisionToken: token,
    skillStorePath: storePath, captureSkills: true,
    ...overrides,
  }
}

function execute(name: string, args: unknown) {
  return executeToolFixture(ctx, {
    agent, name, arguments: args,
    callId: ToolCallId(`approval-${name}`), signal: new AbortController().signal,
  })
}

function payload(result: Awaited<ReturnType<typeof execute>>) {
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
}

it('allows and denies login through DSH user questions', async () => {
  const approved = new FakeUserQuestions(true)
  ctx.provide('userQuestions', approved)
  await ctx.plugin(Provider, config())
  const result = await execute('d1_browser_subgoal', {
    goal: 'Sign in to the fixture account.', url: `${fixtureUrl}/login-success.html`,
    verify: [{ type: 'text_visible', text: 'Signed in' }],
  })
  expect(payload(result)).toMatchObject({ status: 'success', actionsExecuted: 1 })
  expect(approved.calls).toHaveLength(1)

  approved.approve = false
  const deniedResult = await execute('d1_browser_subgoal', {
    goal: 'Sign in to the fixture account.', url: `${fixtureUrl}/login-success.html`,
    verify: [{ type: 'text_visible', text: 'Signed in' }],
  })
  expect(payload(deniedResult)).toMatchObject({
    status: 'confirmation_required', reason: 'denied_by_user', actionsExecuted: 0,
  })
})

it('requires interactive approval before publishing a Skill', async () => {
  const store = new SkillStore(storePath)
  const candidate = await createCandidateFromTrajectory(store, {
    route: 'd1', status: 'success', match: { urlPath: '/flights.html', origin: 'https://example.test' },
    verify: [{ type: 'text_visible', text: 'Done' }],
    trace: [{ operation: 'CLICK', targetName: 'Search flights', target: 'e7' }],
  })
  await store.recordVerification(candidate!.id, evidenceFromRun('success', 'independently_verified_after_skill', 0, true, 1))
  const approved = new FakeUserQuestions(true)
  ctx.provide('userQuestions', approved)
  await ctx.plugin(Provider, config())
  const result = await execute('browser_skill_publish', { skillId: candidate!.id })
  expect(payload(result)).toMatchObject({ status: 'success' })
  expect((await store.get(candidate!.id))?.state).toBe('verified')

  approved.approve = false
  const deniedResult = await execute('browser_skill_publish', { skillId: candidate!.id })
  expect(payload(deniedResult)).toMatchObject({ status: 'confirmation_required', reason: 'denied_by_user' })
})

it('exposes an authenticated control page and stops an active run', async () => {
  const controller = ctx.plugin(Provider, config({ controlToken: 'control-secret', controlPort: 0 }))
  await controller
  const running = execute('d1_browser_subgoal', {
    goal: 'no progress repeated click', url: `${fixtureUrl}/noop.html`,
    verify: [{ type: 'text_visible', text: 'Not present' }], maxSteps: 10,
  })
  await new Promise(resolve => setTimeout(resolve, 100))
  const status = await execute('browser_control', { action: 'status' })
  const value = payload(status)
  expect(value.controlUrl).toBeTypeOf('string')
  const page = await fetch(value.controlUrl as string)
  expect(await page.text()).toContain('暂停')
  const stop = await execute('browser_control', { action: 'stop' })
  expect(payload(stop)).toMatchObject({ stopped: true })
  const stoppedResult = await running
  expect(stoppedResult.isError).toBe(false)
  expect(payload(stoppedResult)).toMatchObject({ status: 'stopped', reason: 'stopped_by_user' })
})
