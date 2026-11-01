import { executeToolFixture } from '@albaincompleta/dsh-cu-testkit'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import * as Provider from '../src/index.ts'
import { createCandidateFromTrajectory, evidenceFromRun } from '@albaincompleta/dsh-cu-core/skill-builder'
import { SkillStore } from '@albaincompleta/dsh-cu-core/skill-store'
import { close, decisionServer, HELPER, listen, NATIVE_HELPER_AVAILABLE, pathGrant, ROOT } from './fixtures.ts'
import { FakeUserQuestions } from './approval-fixtures.ts'


class IndependentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('D1 CU called the Session model') }
}

let ctx: Context
let agent: Agent
let fixture: ChildProcess
let fixturePath: string
let decisions: ReturnType<typeof decisionServer>
let decisionUrl: string
let tempRoot: string
let reportPath: string
const token = 'native-fixture-token'

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-provider-'))
  reportPath = join(tempRoot, 'report.csv')
  await writeFile(reportPath, 'city,amount\nZürich,100\nLondon,200\n')
  fixturePath = join(tempRoot, 'workflow-fixture')
  const compile = spawn('swiftc', [join(ROOT, 'fixtures/native/WorkflowFixture.swift'), '-o', fixturePath], { stdio: 'inherit' })
  await new Promise<void>((resolve, reject) => {
    compile.once('exit', code => code === 0 ? resolve() : reject(new Error(`swiftc exited ${code}`)))
    compile.once('error', reject)
  })
  fixture = spawn(fixturePath, [join(tempRoot, 'state.json')], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((resolve, reject) => {
    fixture.stdout!.once('data', () => resolve())
    fixture.once('error', reject)
    fixture.once('exit', code => reject(new Error(`fixture exited ${code}`)))
  })
  decisions = decisionServer(token)
  decisionUrl = await listen(decisions)

  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // The official CUA provider asks the human before it touches an application;
  // a headless run has to answer that question explicitly.
  ctx.provide('userQuestions', new FakeUserQuestions(true))
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(ComputerUseRegistry)
  ctx.llm.registerAdapter(['fixture'], new IndependentSessionModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  agent = await harness.create(SessionId('d1-native'), { provider: 'fixture', model: 'structured' })
})

afterEach(async () => {
  fixture.kill('SIGTERM')
  await ctx.fiber.dispose()
  await close(decisions)
  await rm(tempRoot, { recursive: true, force: true })
  await rm(reportPath, { force: true })
})

it.skipIf(!NATIVE_HELPER_AVAILABLE)('runs a native CSV import through official CUA and the standard tool pipeline', async () => {
  const provider = ctx.plugin(Provider, {
    helperPath: HELPER,
    allowedApps: [pathGrant(fixturePath)],
    decisionEndpoint: decisionUrl,
    decisionToken: token,
  })
  await provider
  expect(ctx.computerUse.providerName).toBe('dsh-cua')
  const toolNames = ctx.tools.schemas().map(tool => tool.name)
  expect(toolNames).toEqual(expect.arrayContaining([
    'computer_control', 'computer_skill_publish', 'computer_subgoal',
  ]))
  expect(toolNames).not.toContain('skill_publish')
  expect(toolNames).not.toContain('browser_control')
  const result = await executeToolFixture(ctx, {
    agent,
    name: 'computer_subgoal',
    arguments: {
      goal: 'Import the synthetic report and verify its path before importing.',
      app: String(fixture.pid),
      inputs: { 'Report path': reportPath },
      verify: [
        { type: 'input_value', label: 'Report path', value: reportPath },
        { type: 'text_visible', text: 'Import complete' },
        { type: 'text_visible', text: 'Rows: 2 · Total: 300' },
      ],
    },
    callId: ToolCallId('native-import'),
    signal: new AbortController().signal,
  })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const value = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
  expect(value).toMatchObject({
    status: 'success', decisionRequests: 2, modelForwardCalls: 2, actionsExecuted: 2,
  })
  await provider.dispose()
  expect(ctx.computerUse.providerName).toBeUndefined()
})

it.skipIf(!NATIVE_HELPER_AVAILABLE)('stops after the input token budget is reached without another native decision', async () => {
  await ctx.plugin(Provider, {
    helperPath: HELPER,
    allowedApps: [pathGrant(fixturePath)],
    decisionEndpoint: decisionUrl,
    decisionToken: token,
    maxInputTokens: 10,
  })
  const result = await executeToolFixture(ctx, {
    agent,
    name: 'computer_subgoal',
    arguments: {
      goal: 'Import the synthetic report and verify its path before importing.',
      app: String(fixture.pid),
      inputs: { 'Report path': reportPath },
      verify: [
        { type: 'input_value', label: 'Report path', value: reportPath },
        { type: 'text_visible', text: 'Import complete' },
      ],
    },
    callId: ToolCallId('native-token-budget'),
    signal: new AbortController().signal,
  })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const value = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
  expect(value).toMatchObject({
    status: 'escalated', reason: 'input_token_budget_exhausted', decisionRequests: 1,
    actionsExecuted: 1, inputTokens: 10,
  })
})

it.skipIf(!NATIVE_HELPER_AVAILABLE)('evolves a stale published native Skill after a bounded D1 repair', async () => {
  const skillStorePath = join(tempRoot, 'skills.json')
  const store = new SkillStore(skillStorePath)
  const stale = await store.createCandidate({
    match: { windowTitle: 'DSH Workflow Fixture' }, fallback: 'd1', risk: 'reversible',
    verify: [{ type: 'text_visible', text: 'Import complete' }],
    steps: [{ type: 'click', target: 'Retired Import Button' }],
  })
  // CR-02: evidence is minted by a single-use verification session, and the
  // publish call takes the one-shot nonce that the approval produced.
  const session = await store.beginVerification(stale.id)
  await store.finishVerification(session.token, { status: 'passed', summary: 'independently_verified_after_skill' })
  const nonce = store.mintPublishNonce(stale.id, { approved: true })
  expect(nonce).toBeTypeOf('string')
  await store.publish(stale.id, nonce)

  await ctx.plugin(Provider, {
    helperPath: HELPER,
    allowedApps: [pathGrant(fixturePath)],
    decisionEndpoint: decisionUrl,
    decisionToken: token,
    skillStorePath,
    captureSkills: true,
  })
  const result = await executeToolFixture(ctx, {
    agent,
    name: 'computer_subgoal',
    arguments: {
      goal: 'Import the synthetic report and verify its path before importing.',
      app: String(fixture.pid), skillId: stale.id,
      inputs: { 'Report path': reportPath },
      verify: [
        { type: 'input_value', label: 'Report path', value: reportPath },
        { type: 'text_visible', text: 'Import complete' },
        { type: 'text_visible', text: 'Rows: 2 · Total: 300' },
      ],
    },
    callId: ToolCallId('native-skill-evolution'),
    signal: new AbortController().signal,
  })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const value = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
  expect(value).toMatchObject({
    status: 'success', route: 'd1', fallbackReason: 'skill_fallback', evolvedFromSkillId: stale.id,
  })
  const repaired = await store.get(value.candidateId as string)
  expect(repaired).toMatchObject({ state: 'candidate', version: 2, evolvedFrom: stale.id })
  expect(repaired?.steps).toEqual([
    { type: 'type', target: 'dsh-workflow-path', input: 'Report path' },
    { type: 'click', target: 'dsh-workflow-import' },
  ])
  expect((await store.get(stale.id))?.state).toBe('verified')
})

it.skipIf(!NATIVE_HELPER_AVAILABLE)('executes a verified native import skill with zero model calls', async () => {
  await ctx.plugin(Provider, {
    helperPath: HELPER,
    allowedApps: [pathGrant(fixturePath)],
    decisionEndpoint: decisionUrl,
    decisionToken: token,
  })
  const result = await executeToolFixture(ctx, {
    agent,
    name: 'computer_subgoal',
    arguments: {
      goal: 'Import the synthetic report.',
      app: String(fixture.pid),
      skillId: 'fixture.native-csv-import',
      inputs: { 'Report path': reportPath },
      verify: [{ type: 'text_visible', text: 'Report path' }],
    },
    callId: ToolCallId('native-skill-import'),
    signal: new AbortController().signal,
  })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const value = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
  expect(value).toMatchObject({
    status: 'success', route: 'skill', decisionRequests: 0, modelForwardCalls: 0, actionsExecuted: 2,
  })
})

it.skipIf(!NATIVE_HELPER_AVAILABLE)('preserves continuous foreground input during dynamic and zero-model Skill execution', async () => {
  const children: ChildProcess[] = []
  const anchorState = join(tempRoot, 'anchor-state.json')
  const anchor = spawn(fixturePath, [anchorState, '--editing'], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(anchor)
  const waitReady = async (child: ChildProcess) => new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve())
    child.once('error', reject)
  })
  const waitExit = async (child: ChildProcess) => new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`controlled_process_exited_${code}`)))
  })
  const compile = async (source: string, destination: string) => {
    const child = spawn('swiftc', [source, '-o', destination], { stdio: 'ignore' })
    await waitExit(child)
  }
  try {
    await waitReady(anchor)
    const userInputBinary = join(tempRoot, 'UserInput')
    const foregroundBinary = join(tempRoot, 'ForegroundControl')
    await Promise.all([
      compile(join(ROOT, 'fixtures/native/UserInput.swift'), userInputBinary),
      compile(join(ROOT, 'fixtures/native/ForegroundControl.swift'), foregroundBinary),
    ])
    await ctx.plugin(Provider, {
      helperPath: HELPER,
      allowedApps: [pathGrant(fixturePath)],
      decisionEndpoint: decisionUrl,
      decisionToken: token,
    })
    const target = fixture
    let expectedInput = ''
    for (const route of ['d1', 'skill'] as const) {
      if (route === 'skill') {
        process.kill(target.pid!, 'SIGHUP')
        await delay(100)
      }
      await delay(200)
      const frontmost = async (): Promise<number> => {
        const child = execFile(foregroundBinary, ['frontmost'])
        const [output] = await Promise.all([new Promise<string>((resolve, reject) => {
          let text = ''
          child.stdout!.on('data', chunk => { text += chunk.toString() })
          child.once('error', reject)
          child.once('exit', () => resolve(text))
        }), waitExit(child)])
        return Number(output.trim())
      }
      await expect.poll(frontmost).toBe(anchor.pid)
      const monitor = spawn(foregroundBinary, ['monitor'], { stdio: ['ignore', 'pipe', 'ignore'] })
      children.push(monitor)
      let foregroundEvents = ''
      monitor.stdout!.on('data', chunk => { foregroundEvents += chunk.toString() })
      const user = spawn(userInputBinary, ['30'], { stdio: 'ignore' })
      children.push(user)
      const typing = waitExit(user)
      const result = await executeToolFixture(ctx, {
        agent,
        name: 'computer_subgoal',
        arguments: {
          goal: 'Import the synthetic report without changing foreground input.',
          app: String(target.pid),
          ...route === 'skill' ? { skillId: 'fixture.native-csv-import' } : {},
          inputs: { 'Report path': reportPath },
          verify: route === 'd1' ? [
            { type: 'input_value', label: 'Report path', value: reportPath },
            { type: 'text_visible', text: 'Import complete' },
            { type: 'text_visible', text: 'Rows: 2 · Total: 300' },
          ] : [{ type: 'text_visible', text: 'Report path' }],
        },
        callId: ToolCallId(`native-noninterference-${route}`),
        signal: new AbortController().signal,
      })
      await typing
      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      const value = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
      expect(value).toMatchObject({ status: 'success', route, actionsExecuted: 2 })
      expectedInput += 'u'.repeat(30)
      await delay(100)
      const anchorValue = JSON.parse(await readFile(anchorState, 'utf8')) as { path: string }
      expect(anchorValue.path).toBe(expectedInput)
      monitor.kill('SIGTERM')
      const observedOwners = foregroundEvents.trim().split('\n').filter(Boolean)
      expect(observedOwners.length).toBeGreaterThan(0)
      expect(new Set(observedOwners)).toEqual(new Set([String(anchor.pid)]))
    }
  } finally {
    for (const child of children) child.kill('SIGTERM')
  }
}, 60000)
