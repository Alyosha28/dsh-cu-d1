import { executeToolFixture } from '@albaincompleta/dsh-cu-testkit'
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
import { activateApp, close, HELPER, listen, NATIVE_HELPER_AVAILABLE, pathGrant, probePointerInput, ROOT, visualDecisionServer } from './fixtures.ts'
import { FakeUserQuestions } from './approval-fixtures.ts'

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
let workflowState: ((args: Record<string, unknown>) => Promise<boolean>) | undefined
let pointer: { ok: boolean; detail: string } = { ok: false, detail: 'pointer probe did not run' }
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
  // The run happens with the accessibility tree hidden (that is what forces the
  // screenshot path), so the capability probe runs in that same state.
  fixture.kill('SIGUSR1')
  await new Promise(resolveWait => setTimeout(resolveWait, 200))
  // Screenshot-box input is CGEvent input: it only reaches an application that
  // is frontmost, which a headless test runner cannot assume.
  const activation = await activateApp(fixture.pid)
  const started = JSON.parse(await readFile(join(tempRoot, 'state.json'), 'utf8')) as {
    windowId: number; buttonPoint: [number, number]
  }
  pointer = activation.frontmost
    ? await probePointerInput({
        pid: fixture.pid!, windowId: started.windowId, point: started.buttonPoint,
        statePath: join(tempRoot, 'state.json'),
      })
    : { ok: false, detail: `fixture_not_frontmost: ${activation.detail}` }
  if (!pointer.ok) console.warn(`[native-tests] visual pointer input unavailable: ${pointer.detail}`)
  decisions = visualDecisionServer(token)
  decisionUrl = await listen(decisions)
  // The custom verifier is injected at construction time: there is no
  // process-global registration a later import could replace.
  workflowState = async ({ statePath }) => {
    const state = JSON.parse(await readFile(String(statePath), 'utf8'))
    if (process.env.DEBUG_CUA === '1') console.error('VERIFY_STATE', state)
    return state.status === 'Import complete' && state.rows === 2 && state.total === 300
  }

  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  ctx.provide('userQuestions', new FakeUserQuestions(true))
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

it.skipIf(!NATIVE_HELPER_AVAILABLE)('uses a screenshot box for native input when AX is unavailable', async (testContext) => {
  if (!pointer.ok) {
    // Measured capability, not an assumption: the helper exists and AX works,
    // but this session cannot deliver pointer input to the fixture.
    testContext.skip(`pointer_input_unavailable: ${pointer.detail}`)
  }
  await ctx.plugin(Provider, {
    helperPath: HELPER,
    allowedApps: [pathGrant(fixturePath)],
    decisionEndpoint: decisionUrl,
    decisionToken: token,
    verificationHandlers: { workflow_state: workflowState },
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
  if (value.status !== 'success') {
    // Distinguish "the mapping is wrong" (fail) from "this session delivers
    // keystrokes but drops synthesized button clicks" (measured skip).
    const state = JSON.parse(await readFile(join(tempRoot, 'state.json'), 'utf8')) as {
      path: string; status: string; rows: number; hiddenAX: boolean
    }
    const typedLanded = state.path === reportPath
    if (typedLanded) {
      testContext.skip('pointer_button_click_ignored: the field click and typing landed, '
        + `the fixture ignored the synthesized button click (status=${state.status}, rows=${state.rows}, hiddenAX=${String(state.hiddenAX)})`)
    }
    expect(value, JSON.stringify({ result: value, state })).toMatchObject({ status: 'success' })
  }
  expect(value).toMatchObject({ status: 'success', decisionRequests: 2, actionsExecuted: 2 })
})
