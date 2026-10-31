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
import { CHROME, close, fixtureServer, listen } from './fixtures.ts'

class IndependentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('D1 e2e called the Session model') }
}

const token = process.env.D1_DECISION_TOKEN
const endpoint = process.env.D1_DECISION_ENDPOINT ?? 'http://127.0.0.1:8765'
let ctx: Context
let agent: Agent
let fixtures: ReturnType<typeof fixtureServer>
let fixtureUrl: string

beforeEach(async () => {
  fixtures = fixtureServer()
  fixtureUrl = await listen(fixtures)
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(BrowserUseRegistry)
  ctx.llm.registerAdapter(['fixture'], new IndependentSessionModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  agent = await harness.create(SessionId('d1-real-model'), { provider: 'fixture', model: 'structured' })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await close(fixtures)
})

it.skipIf(!token)('completes a real flight subgoal through DSH, Chrome, and the D1 sidecar', async () => {
  await ctx.plugin(Provider, {
    mode: 'launch', executablePath: CHROME, headless: true,
    decisionEndpoint: endpoint, decisionToken: token!, textStrategy: 'speculative',
  })
  const result = await executeToolFixture(ctx, {
    agent,
    name: 'd1_browser_subgoal',
    arguments: {
      goal: 'Find one-way flights from Zürich to London on 2026-11-01.',
      url: `${fixtureUrl}/flights.html`,
      verify: [{ type: 'text_visible', text: 'Zürich to London · 2026-11-01' }],
    },
    callId: ToolCallId('real-d1-flights'),
    signal: new AbortController().signal,
  })
  expect(result.isError).toBe(false)
  const value = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
  expect(value).toMatchObject({ status: 'success', decisionRequests: 4, actionsExecuted: 4 })
  expect(JSON.stringify(value)).not.toContain('Zürich')
})
