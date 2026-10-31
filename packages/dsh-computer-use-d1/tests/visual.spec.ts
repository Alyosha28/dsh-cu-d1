import { executeToolFixture } from '@alyosha28/dsh-cu-testkit'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import * as Provider from '../src/index.ts'
import { registerNativeVerification } from '../src/verification.ts'
import { close, HELPER, listen, pathGrant, ROOT, visualDecisionServer } from './fixtures.ts'

class ImageSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('visual test called the Session model') }
  async resolveModel() {
    return { provider: 'fixture', id: 'structured', name: 'Structured', inputModalities: ['text', 'image'] } as any
  }
}

let ctx: Context
let agent: Agent
let fixture: ChildProcess
let fixturePath: string
let decisions: ReturnType<typeof visualDecisionServer>
let decisionUrl: string
let tempRoot: string
let reportPath: string
const token = 'visual-fixture-token'

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-visual-provider-'))
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
  decisions = visualDecisionServer(token)
  decisionUrl = await listen(decisions)
  registerNativeVerification('workflow_state', async ({ statePath }) => {
    const state = JSON.parse(await readFile(String(statePath), 'utf8'))
    if (process.env.DEBUG_CUA === '1') console.error('VERIFY_STATE', state)
    return state.status === 'Import complete' && state.rows === 2 && state.total === 300
  })
  fixture.kill('SIGUSR1')

  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(AttachmentLocal, { dshHome: tempRoot })
  ctx.llm.registerAdapter(['fixture'], new ImageSessionModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  agent = await harness.create(SessionId('d1-native-visual'), { provider: 'fixture', model: 'structured' })
})

afterEach(async () => {
  fixture.kill('SIGTERM')
  await ctx.fiber.dispose()
  await close(decisions)
  await rm(tempRoot, { recursive: true, force: true })
  await rm(reportPath, { force: true })
})

it('uses a screenshot box for native input when AX is unavailable', async () => {
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
      inputs: { 'Report path': reportPath },
      verify: [
        { type: 'custom', name: 'workflow_state', args: { statePath: join(tempRoot, 'state.json') } },
      ],
    },
    callId: ToolCallId('native-visual-import'),
    signal: new AbortController().signal,
  })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const value = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
  expect(value).toMatchObject({ status: 'success', decisionRequests: 2, actionsExecuted: 2 })
})
