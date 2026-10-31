import { executeToolFixture } from '@dsh-cu/testkit'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import * as Provider from '../src/index.ts'
import { HELPER, pathGrant, ROOT } from './fixtures.ts'

class IndependentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('D1 CU e2e called the Session model') }
}

const token = process.env.D1_DECISION_TOKEN
const endpoint = process.env.D1_DECISION_ENDPOINT ?? 'http://127.0.0.1:8765'
let ctx: Context
let agent: Agent
let fixture: ChildProcess
let fixturePath: string
let tempRoot: string
let reportPath: string

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-real-provider-'))
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
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(ComputerUseRegistry)
  ctx.llm.registerAdapter(['fixture'], new IndependentSessionModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  agent = await harness.create(SessionId('d1-native-real'), { provider: 'fixture', model: 'structured' })
})

afterEach(async () => {
  fixture.kill('SIGTERM')
  await ctx.fiber.dispose()
  await rm(tempRoot, { recursive: true, force: true })
  await rm(reportPath, { force: true })
})

it.skipIf(!token)('completes native CSV import with real D1 and official CUA', async () => {
  await ctx.plugin(Provider, {
    helperPath: HELPER,
    allowedApps: [pathGrant(fixturePath)],
    decisionEndpoint: endpoint,
    decisionToken: token!,
  })
  const result = await executeToolFixture(ctx, {
    agent,
    name: 'computer_subgoal',
    arguments: {
      goal: 'Import the synthetic report and verify its path before importing.',
      inputs: { 'Report path': reportPath },
      app: String(fixture.pid),
      verify: [
        { type: 'input_value', label: 'Report path', value: reportPath },
        { type: 'text_visible', text: 'Import complete' },
        { type: 'text_visible', text: 'Rows: 2 · Total: 300' },
      ],
    },
    callId: ToolCallId('real-native-import'),
    signal: new AbortController().signal,
  })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const value = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
  expect(value.status).toBe('success')
})
