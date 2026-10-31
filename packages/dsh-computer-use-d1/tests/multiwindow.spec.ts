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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import * as Provider from '../src/index.ts'
import { close, decisionServer, HELPER, listen, pathGrant, ROOT } from './fixtures.ts'

class IndependentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('multiwindow test called the Session model') }
}

let ctx: Context
let agent: Agent
let fixture: ChildProcess
let fixturePath: string
let decisions: ReturnType<typeof decisionServer>
let decisionUrl: string
let tempRoot: string
let reportPath: string
const token = 'multiwindow-token'

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-multiwindow-'))
  reportPath = join(tempRoot, 'report.csv')
  await writeFile(reportPath, 'city,amount\nZürich,100\nLondon,200\n')
  fixturePath = join(tempRoot, 'workflow-fixture')
  const compile = spawn('swiftc', [join(ROOT, 'fixtures/native/WorkflowFixture.swift'), '-o', fixturePath], { stdio: 'inherit' })
  await new Promise<void>((resolve, reject) => {
    compile.once('exit', code => code === 0 ? resolve() : reject(new Error(`swiftc exited ${code}`)))
    compile.once('error', reject)
  })
  fixture = spawn(fixturePath, [join(tempRoot, 'state.json'), '--secondary'], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((resolve, reject) => {
    fixture.stdout!.once('data', () => resolve())
    fixture.once('error', reject)
    fixture.once('exit', code => reject(new Error(`fixture exited ${code}`)))
  })
  decisions = decisionServer(token)
  decisionUrl = await listen(decisions)
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(ComputerUseRegistry)
  ctx.llm.registerAdapter(['fixture'], new IndependentSessionModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  agent = await harness.create(SessionId('d1-multiwindow'), { provider: 'fixture', model: 'structured' })
})

afterEach(async () => {
  fixture.kill('SIGTERM')
  await ctx.fiber.dispose()
  await close(decisions)
  await rm(tempRoot, { recursive: true, force: true })
  await rm(reportPath, { force: true })
})

it('requires an explicit window before allowing native input', async () => {
  await ctx.plugin(Provider, {
    helperPath: HELPER,
    allowedApps: [pathGrant(fixturePath)],
    decisionEndpoint: decisionUrl,
    decisionToken: token,
  })
  const ambiguous = await executeToolFixture(ctx, {
    agent,
    name: 'computer_subgoal',
    arguments: {
      goal: 'Import the synthetic report.',
      app: String(fixture.pid),
      inputs: { 'Report path': reportPath },
      verify: [{ type: 'text_visible', text: 'Import complete' }],
    },
    callId: ToolCallId('multiwindow-ambiguous'),
    signal: new AbortController().signal,
  })
  expect(ambiguous.isError).toBe(false)
  const value = JSON.parse((ambiguous.content[0] as { text: string }).text) as Record<string, unknown>
  expect(value).toMatchObject({ status: 'escalated', reason: 'window_selection_required', decisionRequests: 0, actionsExecuted: 0 })

  const state = JSON.parse(await readFile(join(tempRoot, 'state.json'), 'utf8'))
  const selected = await executeToolFixture(ctx, {
    agent,
    name: 'computer_subgoal',
    arguments: {
      goal: 'Import the synthetic report.',
      app: String(fixture.pid), windowId: state.windowId,
      inputs: { 'Report path': reportPath },
      verify: [{ type: 'text_visible', text: 'Import complete' }, { type: 'text_visible', text: 'Rows: 2 · Total: 300' }],
    },
    callId: ToolCallId('multiwindow-selected'),
    signal: new AbortController().signal,
  })
  expect(selected.isError).toBe(false)
  const selectedValue = JSON.parse((selected.content[0] as { text: string }).text)
  expect(selectedValue).toMatchObject({ status: 'success' })

  const questions = {
    calls: [] as any[],
    async ask(input: any) {
      this.calls.push(input)
      const labels = input.questions[0].options.map((option: { label: string }) => option.label) as string[]
      const match = labels.find(label => label.includes(`(${state.windowId})`)) ?? labels[0]
      return { answers: input.questions.map((question: { id: string }) => ({ id: question.id, selected: [match] })) }
    },
  }
  ctx.provide('userQuestions', questions)
  const picked = await executeToolFixture(ctx, {
    agent,
    name: 'computer_subgoal',
    arguments: {
      goal: 'Import the synthetic report.',
      app: String(fixture.pid),
      inputs: { 'Report path': reportPath },
      verify: [{ type: 'text_visible', text: 'Import complete' }],
    },
    callId: ToolCallId('multiwindow-picked'),
    signal: new AbortController().signal,
  })
  expect(picked.isError).toBe(false)
  const pickedValue = JSON.parse((picked.content[0] as { text: string }).text) as Record<string, unknown>
  expect(pickedValue).toMatchObject({ status: 'success' })
  expect(questions.calls).toHaveLength(1)
  await writeFile(join(ROOT, 'results/P5_MULTIWINDOW.json'), JSON.stringify({ ambiguous: value, selected: selectedValue, picked: pickedValue }, null, 2) + '\n')
})
