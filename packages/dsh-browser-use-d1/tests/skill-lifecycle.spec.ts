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
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import * as Provider from '../src/index.ts'
import { runBrowserSkill } from '../src/skill-runner.ts'
import { RunBudget } from '@albaincompleta/dsh-cu-core/budget'
import { createCandidateFromTrajectory, evidenceFromRun } from '@albaincompleta/dsh-cu-core/skill-builder'
import { selectSkill } from '@albaincompleta/dsh-cu-core/skills'
import type { VerifiedSkill } from '@albaincompleta/dsh-cu-core/skills'
import { SkillStore } from '@albaincompleta/dsh-cu-core/skill-store'
import { CHROME, close, decisionServer, fixtureServer, listen } from './fixtures.ts'


class IndependentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('Skill lifecycle called the Session model') }
}

let ctx: Context
let agent: Agent
let browser: Browser
let fixtures: ReturnType<typeof fixtureServer>
let decisions: ReturnType<typeof decisionServer>
let fixtureUrl: string
let decisionUrl: string
let tempRoot: string
let storePath: string
const token = 'skill-lifecycle-token'

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-skill-lifecycle-'))
  storePath = join(tempRoot, 'skills.json')
  fixtures = fixtureServer()
  decisions = decisionServer(token)
  ;[fixtureUrl, decisionUrl] = await Promise.all([listen(fixtures), listen(decisions)])
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(BrowserUseRegistry)
  ctx.llm.registerAdapter(['fixture'], new IndependentSessionModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  agent = await harness.create(SessionId('skill-lifecycle'), { provider: 'fixture', model: 'structured' })
  browser = await chromium.launch({ executablePath: CHROME, headless: true })
})

afterEach(async () => {
  await browser.close()
  await ctx.fiber.dispose()
  await Promise.all([close(fixtures), close(decisions)])
  await rm(tempRoot, { recursive: true, force: true })
})

function config() {
  return {
    mode: 'launch', executablePath: CHROME, headless: true,
    decisionEndpoint: decisionUrl, decisionToken: token,
    skillStorePath: storePath, captureSkills: true,
  }
}

function execute(args: unknown) {
  return executeToolFixture(ctx, {
    agent, name: 'd1_browser_subgoal', arguments: args,
    callId: ToolCallId('skill-lifecycle-call'), signal: new AbortController().signal,
  })
}

function payload(result: Awaited<ReturnType<typeof execute>>) {
  expect(result.isError).toBe(false)
  return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
}

it('captures, verifies, approves, and reuses a trajectory as a verified Skill', async () => {
  const provider = ctx.plugin(Provider, config())
  await provider
  const initial = await execute({
    goal: 'Find one-way flights from Zürich to London on 2026-11-01.',
    url: `${fixtureUrl}/flights.html`,
    verify: [{ type: 'text_visible', text: 'Zürich to London · 2026-11-01' }],
  })
  const first = payload(initial)
  expect(first).toMatchObject({ route: 'd1', status: 'success' })
  expect(first.candidateId).toBeTypeOf('string')
  const candidateId = first.candidateId as string

  const store = new SkillStore(storePath)
  const candidate = await store.get(candidateId)
  expect(candidate).toMatchObject({
    state: 'candidate',
    match: { urlPath: '/flights.html', origin: fixtureUrl },
    verify: [{ type: 'text_visible', text: '{{inputs:From}} to {{inputs:To}} · {{inputs:Departure%20date}}' }],
  })
  expect(candidate?.steps).toEqual([
    { type: 'type', target: 'From', input: 'From' },
    { type: 'type', target: 'To', input: 'To' },
    { type: 'type', target: 'Departure date', input: 'Departure date' },
    { type: 'click', target: 'Search flights' },
  ])
  expect((await store.list('verified')).find(skill => skill.id === candidateId)).toBeUndefined()

  const page = await browser.newPage()
  await page.goto(`${fixtureUrl}/flights.html`, { waitUntil: 'domcontentloaded' })
  const verification = await runBrowserSkill(page, candidate!, {
    goal: 'Find one-way flights from Zürich to London on 2026-11-01.',
    url: `${fixtureUrl}/flights.html`,
    inputs: { From: 'Zürich', To: 'London', 'Departure date': '2026-11-01' },
    verify: [{ type: 'text_visible', text: 'Book a flight' }],
  }, Provider.Config(config()), new AbortController().signal)
  await page.close()
  expect(verification).toMatchObject({ status: 'success', route: 'skill', modelForwardCalls: 0, actionsExecuted: 4 })
  const evidence = evidenceFromRun(verification!.status, verification!.reason, verification!.modelForwardCalls, true, verification!.actionsExecuted)
  await store.recordVerification(candidateId, evidence)
  const latest = (await store.get(candidateId))!.history.at(-1)!
  await expect(store.publish(candidateId, latest.id, 'system')).rejects.toThrow('approval_required')
  await store.publish(candidateId, latest.id, 'user')

  const reloaded = new SkillStore(storePath)
  expect((await selectSkill({ skillId: candidateId, url: `${fixtureUrl}/flights.html` }, reloaded))?.state).toBe('verified')
  const second = payload(await execute({
    goal: 'Find one-way flights from Zürich to London on 2026-11-01.',
    url: `${fixtureUrl}/flights.html`,
    inputs: { From: 'Zürich', To: 'London', 'Departure date': '2026-11-01' },
    verify: [{ type: 'text_visible', text: 'Zürich to London · 2026-11-01' }],
  }))
  expect(second).toMatchObject({ route: 'skill', status: 'success', decisionRequests: 0, modelForwardCalls: 0 })

  const otherOrigin = fixtureServer()
  const otherUrl = await listen(otherOrigin)
  try {
    const mismatch = payload(await execute({
      goal: 'Find one-way flights from Zürich to London on 2026-11-01.',
      url: `${otherUrl}/flights.html`, skillId: candidateId,
      inputs: { From: 'Zürich', To: 'London', 'Departure date': '2026-11-01' },
      verify: [{ type: 'text_visible', text: 'Zürich to London · 2026-11-01' }],
    }))
    expect(mismatch).toMatchObject({ route: 'human', reason: 'skill_origin_mismatch', actionsExecuted: 0 })
  } finally {
    await close(otherOrigin)
  }
  expect(JSON.stringify(await readFile(storePath, 'utf8'))).not.toContain('Zürich')
  expect(JSON.stringify(await readFile(storePath, 'utf8'))).not.toContain('London')
  await provider.dispose()
}, 30000)

it('evolves a stale published skill through a bounded D1 repair into a new candidate', async () => {
  const provider = ctx.plugin(Provider, config())
  await provider
  const store = new SkillStore(storePath)
  const stale = await store.createCandidate({
    match: { urlPath: '/flights.html', origin: fixtureUrl },
    fallback: 'd1', risk: 'reversible',
    verify: [{ type: 'text_visible', text: '{{inputs:From}} to {{inputs:To}} · {{inputs:Departure%20date}}' }],
    steps: [{ type: 'click', target: 'Retired Search Button' }],
  })
  await store.recordVerification(stale.id, evidenceFromRun('success', 'independently_verified_after_skill', 0, true, 1))
  const latest = (await store.get(stale.id))!.history.at(-1)!
  await store.publish(stale.id, latest.id, 'user')

  const result = payload(await execute({
    goal: 'Find one-way flights from Zürich to London on 2026-11-01.',
    url: `${fixtureUrl}/flights.html`,
    inputs: { From: 'Zürich', To: 'London', 'Departure date': '2026-11-01' },
    verify: [{ type: 'text_visible', text: 'Zürich to London · 2026-11-01' }],
  }))
  expect(result).toMatchObject({
    route: 'd1', status: 'success', fallbackReason: 'skill_fallback', evolvedFromSkillId: stale.id,
  })
  const repaired = await store.get(result.candidateId as string)
  expect(repaired).toMatchObject({ state: 'candidate', version: 2, evolvedFrom: stale.id })
  expect(repaired?.steps).toEqual([
    { type: 'type', target: 'From', input: 'From' },
    { type: 'type', target: 'To', input: 'To' },
    { type: 'type', target: 'Departure date', input: 'Departure date' },
    { type: 'click', target: 'Search flights' },
  ])
  expect((await store.get(stale.id))?.state).toBe('verified')
  await provider.dispose()
}, 30000)

it('cancels Skill waits and enforces wall-clock and step budgets', async () => {
  const skill: VerifiedSkill = {
    id: 'skill_wait_guard', version: 1, verifiedAt: 'now',
    match: { urlPath: '/noop.html', origin: fixtureUrl }, fallback: 'human', risk: 'reversible',
    verify: [{ type: 'text_visible', text: 'Not present' }],
    steps: [{ type: 'wait', ms: 500 }, { type: 'click', target: 'Run' }],
  }
  const args = {
    goal: 'Wait then click', url: `${fixtureUrl}/noop.html`, verify: [{ type: 'text_visible' as const, text: 'Not present' }],
  }
  const page = await browser.newPage()
  await page.goto(args.url)
  const limited = await runBrowserSkill(page, skill, args, Provider.Config(config()), new AbortController().signal,
    new RunBudget({ maxWallClockMs: 1, maxInputTokens: 10, maxOutputTokens: 10 }), 1)
  expect(limited).toMatchObject({ status: 'escalated', reason: 'wall_clock_budget_exhausted', actionsExecuted: 0 })
  const controller = new AbortController()
  const running = runBrowserSkill(page, skill, args, Provider.Config(config()), controller.signal)
  setTimeout(() => controller.abort(), 20)
  await expect(running).rejects.toThrow()
  await page.close()
})

it('does not capture a trajectory whose actions span multiple origins', async () => {
  let otherUrl = ''
  const start = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<title>Start</title><a href="${otherUrl}/final">Go</a>`)
  })
  const other = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<title>Other</title><div>Attacker success</div>')
  })
  const [startUrl, resolvedOtherUrl] = await Promise.all([listen(start), listen(other)])
  otherUrl = resolvedOtherUrl
  const provider = ctx.plugin(Provider, config())
  await provider
  try {
    const result = payload(await execute({
      goal: 'cross-origin capture', url: `${startUrl}/start`,
      verify: [{ type: 'text_visible', text: 'Attacker success' }],
    }))
    expect(result).toMatchObject({ status: 'success', route: 'd1', actionsExecuted: 1 })
    expect(result.candidateId).toBeUndefined()
    expect(await new SkillStore(storePath).list()).toEqual([])
  } finally {
    await provider.dispose()
    await Promise.all([close(start), close(other)])
  }
})

it('rejects replay success after an action navigates to another origin', async () => {
  const page = await browser.newPage()
  await page.route('https://trusted.test/start', route => route.fulfill({
    contentType: 'text/html', body: '<title>Trusted</title><a href="https://attacker.test/next">Go</a>',
  }))
  await page.route('https://attacker.test/next', route => route.fulfill({
    contentType: 'text/html', body: '<title>Attacker</title><div>Attacker success</div>',
  }))
  await page.goto('https://trusted.test/start')
  const skill: VerifiedSkill = {
    id: 'skill_origin_guard', version: 1, verifiedAt: 'now',
    match: { urlPath: '/start', origin: 'https://trusted.test' },
    fallback: 'd1', risk: 'reversible',
    verify: [{ type: 'text_visible', text: 'Attacker success' }],
    steps: [{ type: 'click', target: 'Go' }],
  }
  const result = await runBrowserSkill(page, skill, {
    goal: 'Go', url: 'https://trusted.test/start',
    verify: [{ type: 'text_visible', text: 'Attacker success' }],
  }, Provider.Config(config()), new AbortController().signal)
  expect(result).toMatchObject({
    status: 'escalated', route: 'human', reason: 'skill_origin_mismatch', actionsExecuted: 1,
  })
  expect(page.url()).toBe('https://attacker.test/next')
  await page.close()
})

it('redacts repeated inputs through real browser capture and the SkillStore', async () => {
  await ctx.plugin(Provider, config())
  const result = payload(await execute({
    goal: 'repeated secrets', url: `${fixtureUrl}/repeated-input.html`,
    verify: [{ type: 'text_visible', text: 'firstSecret secondSecret complete' }],
  }))
  expect(result).toMatchObject({ status: 'success', route: 'd1' })
  const candidate = await new SkillStore(storePath).get(result.candidateId as string)
  expect(candidate?.steps).toEqual([
    { type: 'type', target: '__proto__', input: '__proto__' },
    { type: 'type', target: '__proto__', input: '__proto__#2' },
    { type: 'click', target: 'Done' },
  ])
  expect(candidate?.verify).toEqual([
    { type: 'text_visible', text: '{{inputs:__proto__}} {{inputs:__proto__%232}} complete' },
  ])
  const persisted = await readFile(storePath, 'utf8')
  expect(persisted).not.toContain('firstSecret')
  expect(persisted).not.toContain('secondSecret')
})
