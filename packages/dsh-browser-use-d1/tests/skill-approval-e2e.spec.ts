/**
 * BR-03 / CR-01 end to end — a published Skill replayed through the real DSH
 * tool pipeline must pass the same approval gates as a live run.
 *
 * The unit tests exercise `runBrowserSkill` directly; this one proves the
 * gateway actually reaches it from `d1_browser_subgoal`, which is the wiring the
 * red-team PoC (`br03`) exploited.
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
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Provider from '../src/index.ts'
import { SkillStore } from '@albaincompleta/dsh-cu-core/skill-store'
import { executeToolFixture } from '@albaincompleta/dsh-cu-testkit'
import { CHROME, close, fixtureServer, listen } from './fixtures.ts'
import { FakeUserQuestions } from './approval-fixtures.ts'

class NoModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('Skill replay must not call the Session model') }
}

const CHECKOUT = `<!doctype html>
<title>Checkout</title>
<h1>Checkout</h1>
<button id="pay" data-dsh-decision-id="e1"
  onclick="window.__paid = (window.__paid ?? 0) + 1; document.getElementById('done').hidden = false">Pay now</button>
<div id="done" hidden>Payment complete</div>`

let ctx: Context
let agent: Agent
let tempRoot: string
let storePath: string
let server: ReturnType<typeof createServer>
let shopUrl: string

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-skill-gate-e2e-'))
  storePath = join(tempRoot, 'skills.json')
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(CHECKOUT)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  shopUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(BrowserUseRegistry)
  ctx.llm.registerAdapter(['fixture'], new NoModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  agent = await harness.create(SessionId('skill-gate-e2e'), { provider: 'fixture', model: 'structured' })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(tempRoot, { recursive: true, force: true })
})

async function publishPaySkill() {
  const store = new SkillStore(storePath)
  const candidate = await store.createCandidate({
    match: { urlPath: '/checkout', origin: shopUrl },
    fallback: 'human', risk: 'consequential',
    verify: [{ type: 'text_visible', text: 'Payment complete' }],
    steps: [{ type: 'click', target: 'Pay now' }],
  })
  const session = await store.beginVerification(candidate.id)
  await store.finishVerification(session.token, { status: 'passed', summary: 'independently_verified' })
  await store.publish(candidate.id, store.mintPublishNonce(candidate.id, { approved: true })!)
  return candidate.id
}

async function mount(approve: boolean) {
  const questions = new FakeUserQuestions(approve)
  ctx.provide('userQuestions', questions)
  await ctx.plugin(Provider, {
    mode: 'launch', executablePath: CHROME, headless: true,
    decisionEndpoint: 'http://127.0.0.1:9', decisionToken: 'unused-token',
    skillStorePath: storePath,
  })
  return questions
}

async function run(args: unknown) {
  const result = await executeToolFixture(ctx, {
    agent, name: 'd1_browser_subgoal', arguments: args,
    callId: ToolCallId(`replay-${Math.random()}`), signal: new AbortController().signal,
  })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  return JSON.parse((result.content[0] as { text: string }).text) as Record<string, any>
}

it('a replayed consequential Skill asks for approval and executes nothing when denied', async () => {
  const skillId = await publishPaySkill()
  const questions = await mount(false)
  const result = await run({
    goal: 'Pay the invoice', url: `${shopUrl}/checkout`, skillId,
    verify: [{ type: 'text_visible', text: 'Payment complete' }],
  })
  expect(result).toMatchObject({ route: 'skill', status: 'confirmation_required', actionsExecuted: 0 })
  expect(questions.calls.length).toBeGreaterThanOrEqual(1)
  const value = result as Record<string, unknown>
  expect(JSON.stringify(value)).not.toContain('independently_verified_after_action')
})

it('an approved replay runs the Skill under the caller-visible gates', async () => {
  const skillId = await publishPaySkill()
  const questions = await mount(true)
  const result = await run({
    goal: 'Pay the invoice', url: `${shopUrl}/checkout`, skillId,
    verify: [{ type: 'text_visible', text: 'Payment complete' }],
  })
  expect(questions.calls.length).toBeGreaterThanOrEqual(1)
  expect(result.route).toBe('skill')
  // Either the click ran and the postcondition held, or the page had changed
  // between the prompt and the dispatch and the replay refused to guess.
  expect(['success', 'escalated']).toContain(result.status)
  if (result.status === 'success') expect(result.actionsExecuted).toBe(1)
  else expect(result.reason).toBe('stale_skill_snapshot')
})

it('a native-scoped Skill is refused in the browser even when explicitly requested', async () => {
  await mount(true)
  const store = new SkillStore(storePath)
  const candidate = await store.createCandidate({
    match: { windowTitle: 'DSH Workflow Fixture' },
    fallback: 'human', risk: 'reversible',
    verify: [{ type: 'text_visible', text: 'Import complete' }],
    steps: [{ type: 'click', target: 'Import report' }],
  })
  const session = await store.beginVerification(candidate.id)
  await store.finishVerification(session.token, { status: 'passed', summary: 'independently_verified' })
  await store.publish(candidate.id, store.mintPublishNonce(candidate.id, { approved: true })!)

  const result = await run({
    goal: 'Import the report', url: `${shopUrl}/checkout`, skillId: candidate.id,
    verify: [{ type: 'text_visible', text: 'Payment complete' }],
  })
  expect(result).toMatchObject({
    route: 'human', reason: 'skill_provider_mismatch', actionsExecuted: 0,
  })
})

it('rejects a native-only fixture at Skill selection, before any replay', async () => {
  await mount(true)
  // Built-in fixtures are visible to both providers; the browser path must
  // refuse the window-scoped one at `selectSkill`, not halfway through a run.
  const result = await run({
    goal: 'Import the report', url: `${shopUrl}/checkout`, skillId: 'fixture.native-csv-import',
    verify: [{ type: 'text_visible', text: 'Payment complete' }],
  })
  expect(result).toMatchObject({
    route: 'human', reason: 'skill_provider_mismatch', actionsExecuted: 0, decisionRequests: 0,
  })
})

it('a readonly-flag fixture with mutating steps never replays', async () => {
  await mount(true)
  const store = new SkillStore(storePath)
  const candidate = await store.createCandidate({
    match: { urlPath: '/checkout', origin: shopUrl },
    fallback: 'human', risk: 'read_only',
    verify: [{ type: 'text_visible', text: 'Payment complete' }],
    steps: [{ type: 'click', target: 'Pay now' }],
  })
  // Selectable first: a candidate that cannot be published cannot be replayed
  // either, so the risk contradiction must be the reason it is refused.
  const session = await store.beginVerification(candidate.id)
  await store.finishVerification(session.token, { status: 'passed', summary: 'independently_verified' })
  await store.publish(candidate.id, store.mintPublishNonce(candidate.id, { approved: true })!)
  const result = await run({
    goal: 'Pay the invoice', url: `${shopUrl}/checkout`, skillId: candidate.id,
    verify: [{ type: 'text_visible', text: 'Payment complete' }],
  })
  expect(result).toMatchObject({ route: 'human', reason: 'skill_read_only_mutation', actionsExecuted: 0 })
})
