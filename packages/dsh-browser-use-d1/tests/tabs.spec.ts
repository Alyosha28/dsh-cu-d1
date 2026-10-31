import { executeToolFixture } from '@alyosha28/dsh-cu-testkit'
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

class UnusedSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('navigate/tabs must not call the Session model') }
}

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
  ctx.llm.registerAdapter(['fixture'], new UnusedSessionModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  agent = await harness.create(SessionId('tabs-run'), { provider: 'fixture', model: 'structured' })
  await ctx.plugin(Provider, {
    mode: 'launch',
    executablePath: CHROME,
    headless: true,
    decisionEndpoint: 'http://127.0.0.1:9',
    decisionToken: 'unused-token',
  })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await close(fixtures)
})

async function call(name: string, args: unknown) {
  const result = await executeToolFixture(ctx, {
    agent, name, arguments: args, callId: ToolCallId(`${name}-${Math.random()}`), signal: new AbortController().signal,
  })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  return JSON.parse((result.content[0] as { text: string }).text) as Record<string, any>
}

it('navigates the owned page without a decision call', async () => {
  const result = await call('browser_navigate', { url: `${fixtureUrl}/flights.html` })
  expect(result).toMatchObject({
    status: 'success', reason: 'navigated', url: `${fixtureUrl}/flights.html`,
    title: 'Decision Lab Flights', trusted: false,
  })
})

it('refuses non-HTTP navigation targets instead of coercing them', async () => {
  const result = await call('browser_navigate', { url: 'file:///etc/passwd' })
  expect(result).toMatchObject({ status: 'blocked', reason: 'invalid_navigation_url' })
})

it('lists, opens, selects, and closes tabs while keeping one controlled page', async () => {
  await call('browser_navigate', { url: `${fixtureUrl}/flights.html` })
  const initial = await call('browser_tabs', { action: 'list' })
  expect(initial).toMatchObject({ status: 'success', action: 'list' })
  expect(initial.tabs).toHaveLength(1)
  expect(initial.tabs[0]).toMatchObject({ index: 0, active: true })

  const opened = await call('browser_tabs', { action: 'open', url: `${fixtureUrl}/filters.html` })
  expect(opened.tabs).toHaveLength(2)
  expect(opened.tabs[1]).toMatchObject({ index: 1, active: true, url: `${fixtureUrl}/filters.html` })

  const observed = await call('browser_observe', {})
  expect(observed.observation.url).toBe(`${fixtureUrl}/filters.html`)

  const selected = await call('browser_tabs', { action: 'select', index: 0 })
  expect(selected.tabs[0]).toMatchObject({ active: true, url: `${fixtureUrl}/flights.html` })
  expect((await call('browser_observe', {})).observation.url).toBe(`${fixtureUrl}/flights.html`)

  const closed = await call('browser_tabs', { action: 'close', index: 0 })
  expect(closed.tabs).toHaveLength(1)
  expect(closed.tabs[0]).toMatchObject({ active: true, url: `${fixtureUrl}/filters.html` })
})

it('refuses to close the last tab', async () => {
  await call('browser_navigate', { url: `${fixtureUrl}/flights.html` })
  const result = await call('browser_tabs', { action: 'close', index: 0 })
  expect(result).toMatchObject({ status: 'blocked', reason: 'last_tab' })
})

it('reports a missing tab index', async () => {
  await call('browser_navigate', { url: `${fixtureUrl}/flights.html` })
  const result = await call('browser_tabs', { action: 'select', index: 4 })
  expect(result).toMatchObject({ status: 'blocked', reason: 'tab_not_found' })
})
