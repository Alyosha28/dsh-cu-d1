import { executeToolFixture } from '@albaincompleta/dsh-cu-testkit'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import * as Provider from '../src/index.ts'
import { CHROME, close, listen } from './fixtures.ts'

class IndependentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('public smoke called the Session model') }
}

let ctx: Context
let agent: Agent
let decisions: Server
let decisionUrl: string
let decisionCalls: number

beforeEach(async () => {
  decisionCalls = 0
  decisions = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/decide' || request.headers.authorization !== 'Bearer public-smoke') {
      response.writeHead(401).end()
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body) as { observation: { elements: Array<{ id: string; name: string }> } }
    decisionCalls += 1
    const learnMore = payload.observation.elements.find(element => element.name === 'Learn more')
    const decision = decisionCalls === 1 && learnMore !== undefined
      ? { operation: 'CLICK', target: learnMore.id }
      : { operation: 'BLOCKED', target: null }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      decision, usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
    }))
  })
  decisionUrl = await listen(decisions)
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(BrowserUseRegistry)
  ctx.llm.registerAdapter(['fixture'], new IndependentSessionModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  agent = await harness.create(SessionId('public-chrome-smoke'), { provider: 'fixture', model: 'structured' })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await close(decisions)
})

it('uses installed Google Chrome on the real Example Domain without waiting for navigation inside click', async () => {
  await ctx.plugin(Provider, {
    mode: 'launch', executablePath: CHROME, headless: true,
    decisionEndpoint: decisionUrl, decisionToken: 'public-smoke',
    operationTimeoutMs: 15000, verificationTimeoutMs: 10000,
  })
  const result = await executeToolFixture(ctx, {
    agent,
    name: 'd1_browser_subgoal',
    arguments: {
      goal: 'Follow Learn more to the public IANA documentation.',
      url: 'https://example.com/',
      verify: [{ type: 'url_contains', value: 'iana.org' }],
      maxSteps: 2,
    },
    callId: ToolCallId('real-public-example-domain'),
    signal: new AbortController().signal,
  })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const value = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
  expect(value).toMatchObject({ status: 'success', reason: 'independently_verified_after_action', actionsExecuted: 1 })
  expect(decisionCalls).toBe(1)
})
