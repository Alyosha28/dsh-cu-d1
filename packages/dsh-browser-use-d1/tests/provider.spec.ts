import { executeToolFixture } from '@dsh-cu/testkit'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Provider from '../src/index.ts'
import { CHROME, close, decisionServer, fixtureServer, listen } from './fixtures.ts'


class IndependentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('D1 provider called the Session model') }
}

let ctx: Context
let agent: Agent
let second: Agent
let fixtures: ReturnType<typeof fixtureServer>
let decisions: ReturnType<typeof decisionServer>
let fixtureUrl: string
let decisionUrl: string
const token = 'fixture-token'

beforeEach(async () => {
  fixtures = fixtureServer()
  decisions = decisionServer(token)
  ;[fixtureUrl, decisionUrl] = await Promise.all([listen(fixtures), listen(decisions)])
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(BrowserUseRegistry)
  ctx.llm.registerAdapter(['fixture'], new IndependentSessionModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  agent = await harness.create(SessionId('d1-first'), { provider: 'fixture', model: 'structured' })
  second = await harness.create(SessionId('d1-second'), { provider: 'fixture', model: 'structured' })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await Promise.all([close(fixtures), close(decisions)])
})

function config(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'launch',
    executablePath: CHROME,
    headless: true,
    decisionEndpoint: decisionUrl,
    decisionToken: token,
    ...overrides,
  }
}

function execute(name: string, args: unknown, owner: Agent | undefined = agent) {
  return executeToolFixture(ctx, {
    agent: owner,
    name: 'd1_browser_subgoal',
    arguments: args,
    callId: ToolCallId(`test-${name}`),
    signal: new AbortController().signal,
  })
}

function payload(result: Awaited<ReturnType<typeof execute>>) {
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const text = (result.content[0] as { type: string; text: string }).text
  return JSON.parse(text) as Record<string, unknown>
}

it('executes a bounded filters task through the real DSH tool pipeline and releases ownership', async () => {
  const provider = ctx.plugin(Provider, config())
  await provider
  expect(ctx.browserUse.providerName).toBe('d1-system-one')
  expect(ctx.tools.schemas()).toHaveLength(9)
  expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual([
    'browser_control', 'browser_downloads', 'browser_extract', 'browser_navigate', 'browser_observe',
    'browser_skill_publish', 'browser_tabs', 'browser_upload', 'd1_browser_subgoal',
  ])
  const result = await execute('filters', {
    goal: 'Show available flights for exactly 3 adults with nonstop only.',
    url: `${fixtureUrl}/filters.html`, skillId: 'fixture.filters',
    verify: [{ type: 'text_visible', text: '3 adults · Nonstop only' }],
  })
  expect(payload(result)).toMatchObject({
    status: 'success', route: 'skill', decisionRequests: 0, modelForwardCalls: 0, actionsExecuted: 3,
  })
  await provider.dispose()
  expect(ctx.browserUse.providerName).toBeUndefined()
  expect(ctx.tools.schemas()).toEqual([])
})

it('observes the owned page without a decision call or input', async () => {
  await ctx.plugin(Provider, config())
  const result = await executeToolFixture(ctx, {
    agent,
    name: 'browser_observe',
    arguments: {},
    callId: ToolCallId('observe'),
    signal: new AbortController().signal,
  })
  const value = payload(result)
  expect(value).toMatchObject({ status: 'success', reason: 'observed', trusted: false })
  expect(value.observation).toMatchObject({ elements: [] })
})

it('extracts typed DOM values and special keys through the real DSH tool pipeline', async () => {
  await ctx.plugin(Provider, config())
  const result = await executeToolFixture(ctx, {
    agent,
    name: 'browser_extract',
    arguments: {
      url: `${fixtureUrl}/filters.html`,
      fields: [
        { name: 'adults', type: 'number', locator: { kind: 'label', text: 'Adults' } },
        { name: 'nonstop', type: 'boolean', locator: { kind: 'label', text: 'Nonstop only' } },
        { name: '__proto__', type: 'boolean', locator: { kind: 'label', text: 'Nonstop only' } },
      ],
    },
    callId: ToolCallId('extract'),
    signal: new AbortController().signal,
  })
  const value = payload(result)
  expect(value).toMatchObject({
    status: 'success', reason: 'extracted',
    data: { adults: 2, nonstop: false },
    evidence: { source: 'dom', trusted: false, title: 'Decision Lab Filters' },
  })
  expect(Object.hasOwn(value.data as object, '__proto__')).toBe(true)
  expect((value.data as Record<string, unknown>)['__proto__']).toBe(false)
  const agentless = await executeToolFixture(ctx, {
    name: 'browser_extract',
    arguments: { fields: [{ name: 'adults', locator: { kind: 'label', text: 'Adults' } }] },
    callId: ToolCallId('extract-agentless'),
    signal: new AbortController().signal,
  })
  expect(agentless.isError).toBe(true)
})

it('verifies flights independently, redacts input text, and short-circuits an already satisfied goal', async () => {
  await ctx.plugin(Provider, config())
  const result = await execute('flights', {
    goal: 'Find one-way flights from Zürich to London on 2026-11-01.',
    url: `${fixtureUrl}/flights.html`, skillId: 'fixture.flights',
    inputs: { From: 'Zürich', To: 'London', 'Departure date': '2026-11-01' },
    verify: [{ type: 'text_visible', text: 'Zürich to London · 2026-11-01' }],
  })
  const value = payload(result)
  expect(value).toMatchObject({ status: 'success', route: 'skill', decisionRequests: 0, modelForwardCalls: 0, actionsExecuted: 4 })
  expect(JSON.stringify(value)).not.toContain('Zürich')
  expect(JSON.stringify(value)).not.toContain('London')

  const done = await execute('done', {
    goal: 'Stop when 3 adults and Nonstop only are visible.',
    url: `${fixtureUrl}/already-done.html`,
    verify: [{ type: 'text_visible', text: '3 adults · Nonstop only' }],
  })
  expect(payload(done)).toMatchObject({ status: 'success', decisionRequests: 0, actionsExecuted: 0 })
})

it('stops after the input token budget is reached without another decision', async () => {
  await ctx.plugin(Provider, config({ maxInputTokens: 10 }))
  const result = await execute('token-budget', {
    goal: 'Find one-way flights from Zürich to London on 2026-11-01.',
    url: `${fixtureUrl}/flights.html`,
    verify: [{ type: 'text_visible', text: 'Zürich to London · 2026-11-01' }],
  })
  expect(payload(result)).toMatchObject({
    status: 'escalated', reason: 'input_token_budget_exhausted', decisionRequests: 1, actionsExecuted: 1,
    inputTokens: 10,
  })
})

it('stops before the first decision when the wall-clock budget is exhausted', async () => {
  await ctx.plugin(Provider, config({ maxWallClockMs: 1 }))
  const result = await execute('wall-clock-budget', {
    goal: 'Find one-way flights from Zürich to London on 2026-11-01.',
    url: `${fixtureUrl}/flights.html`,
    verify: [{ type: 'text_visible', text: 'Zürich to London · 2026-11-01' }],
  })
  expect(payload(result)).toMatchObject({
    status: 'escalated', reason: 'wall_clock_budget_exhausted', decisionRequests: 0, actionsExecuted: 0,
  })
})

it('falls back to D1 only before side effects and rejects unknown skills', async () => {
  await ctx.plugin(Provider, config())
  const fallback = await execute('flights-fallback', {
    goal: 'Find one-way flights from Zürich to London on 2026-11-01.',
    url: `${fixtureUrl}/flights.html`, skillId: 'fixture.flights',
    verify: [{ type: 'text_visible', text: 'Zürich to London · 2026-11-01' }],
  })
  expect(payload(fallback)).toMatchObject({
    status: 'success', route: 'd1', fallbackReason: 'skill_fallback', decisionRequests: 4,
  })
  const unknown = await execute('unknown-skill', {
    goal: 'Run an unknown skill.', url: `${fixtureUrl}/noop.html`,
    verify: [{ type: 'text_visible', text: 'Not present' }], skillId: 'not-a-skill',
  })
  expect(payload(unknown)).toMatchObject({ route: 'human', reason: 'unknown_skill', decisionRequests: 0 })
})

it('creates independent browsers for separate live Agent owners', async () => {
  await ctx.plugin(Provider, config())
  const args = {
    goal: 'Show available flights for exactly 3 adults with nonstop only.',
    url: `${fixtureUrl}/filters.html`, skillId: 'fixture.filters',
    verify: [{ type: 'text_visible', text: '3 adults · Nonstop only' }],
  }
  expect(payload(await execute('first', args))).toMatchObject({ status: 'success' })
  expect(payload(await execute('second', args, second))).toMatchObject({ status: 'success' })
})

it('requires an exact live Agent and independent verification assertions', async () => {
  await ctx.plugin(Provider, config())
  const agentless = await executeToolFixture(ctx, {
    name: 'd1_browser_subgoal',
    arguments: { goal: 'Click Search', verify: [{ type: 'text_visible', text: 'Done' }] },
    callId: ToolCallId('agentless'),
    signal: new AbortController().signal,
  })
  expect(agentless.isError).toBe(true)
  const noVerification = await execute('no-verification', { goal: 'Click Search', verify: [] })
  expect(noVerification.isError).toBe(true)
})

it('rejects premature DONE without dispatching an action', async () => {
  await ctx.plugin(Provider, config())
  const result = await execute('premature', {
    goal: 'premature completion attempt', url: `${fixtureUrl}/noop.html`,
    verify: [{ type: 'text_visible', text: 'Not present' }],
  })
  expect(payload(result)).toMatchObject({
    status: 'escalated', reason: 'premature_done_rejected_by_verifier', actionsExecuted: 0,
  })
})

it('stops repeated no-progress actions and rejects ambiguous targets before input', async () => {
  await ctx.plugin(Provider, config())
  const repeated = await execute('no-progress', {
    goal: 'no progress repeated click', url: `${fixtureUrl}/noop.html`,
    verify: [{ type: 'text_visible', text: 'Not present' }], maxSteps: 5,
  })
  expect(payload(repeated)).toMatchObject({
    status: 'escalated', reason: 'no_progress_same_decision_repeated', actionsExecuted: 3,
  })
  const blocked = await execute('ambiguous', {
    goal: 'Click Save without choosing either the Document or Workspace section.',
    url: `${fixtureUrl}/ambiguous.html`,
    verify: [{ type: 'text_visible', text: 'Not present' }],
  })
  expect(payload(blocked)).toMatchObject({ status: 'escalated', reason: 'ambiguous_target', actionsExecuted: 0 })
})

it('enforces credential and consequential-action policy before any input', async () => {
  await ctx.plugin(Provider, config())
  const credentials = await execute('credentials', {
    goal: 'Download the private invoice with no credentials available.',
    url: `${fixtureUrl}/login-required.html`,
    verify: [{ type: 'text_visible', text: 'Not present' }],
    policy: { credentialsAvailable: false },
  })
  expect(payload(credentials)).toMatchObject({
    status: 'blocked', reason: 'credentials_unavailable', decisionRequests: 0, actionsExecuted: 0,
  })
  const login = await execute('login', {
    goal: 'Sign in to the fixture account.',
    url: `${fixtureUrl}/login-required.html`,
    verify: [{ type: 'text_visible', text: 'Not present' }],
  })
  expect(payload(login)).toMatchObject({
    status: 'confirmation_required', reason: 'approval_unavailable', actionsExecuted: 0,
  })
  const consequential = await execute('consequential', {
    goal: 'no progress repeated click',
    url: `${fixtureUrl}/noop.html`,
    verify: [{ type: 'text_visible', text: 'Not present' }],
    policy: { risk: 'consequential' },
  })
  expect(payload(consequential)).toMatchObject({
    status: 'confirmation_required', reason: 'approval_unavailable', actionsExecuted: 0,
  })
})

it('waits for asynchronous results without repeating the triggering action', async () => {
  await ctx.plugin(Provider, config())
  const result = await execute('delayed', {
    goal: 'Load the results and stop only when Delayed results are ready is visible.',
    url: `${fixtureUrl}/delayed-results.html`, skillId: 'fixture.delayed-results',
    verify: [{ type: 'text_visible', text: 'Delayed results are ready' }],
  })
  const value = payload(result)
  expect(value).toMatchObject({ status: 'success', route: 'skill', decisionRequests: 0, actionsExecuted: 1 })
  expect(['independently_verified_after_async_update', 'independently_verified_after_skill']).toContain(value.reason)
})

it('does not dispatch input from a stale snapshot', async () => {
  await ctx.plugin(Provider, config())
  const result = await execute('stale', {
    goal: 'stale snapshot action', url: `${fixtureUrl}/mutating.html`,
    verify: [{ type: 'text_visible', text: 'Not present' }], maxSteps: 2,
  })
  expect(payload(result)).toMatchObject({ status: 'escalated', actionsExecuted: 0, staleDecisions: 2 })
})

it('supports a configurable tool prefix without changing tool behavior', async () => {
  await ctx.plugin(Provider, config({ toolPrefix: 'web' }))
  expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual([
    'd1_browser_subgoal', 'web_control', 'web_downloads', 'web_extract', 'web_navigate', 'web_observe',
    'web_skill_publish', 'web_tabs', 'web_upload',
  ])
  const result = await executeToolFixture(ctx, {
    agent,
    name: 'web_extract',
    arguments: {
      url: `${fixtureUrl}/filters.html`,
      fields: [{ name: 'adults', type: 'number', locator: { kind: 'label', text: 'Adults' } }],
    },
    callId: ToolCallId('prefixed-extract'),
    signal: new AbortController().signal,
  })
  expect(payload(result)).toMatchObject({ status: 'success', data: { adults: 2 } })
})

it('rejects an invalid tool prefix before provider registration', async () => {
  await expect(ctx.plugin(Provider, config({ toolPrefix: 'Browser' }))).rejects.toThrow()
  expect(ctx.browserUse.providerName).toBeUndefined()
})

it('rejects a non-loopback decision endpoint before provider registration', async () => {
  await expect(ctx.plugin(Provider, config({ decisionEndpoint: 'https://example.com' }))).rejects.toThrow('loopback')
  expect(ctx.browserUse.providerName).toBeUndefined()
})
