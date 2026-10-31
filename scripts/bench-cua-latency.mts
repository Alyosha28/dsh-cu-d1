import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import * as CuaMacosProvider from '@deepseek-ai/dsh-experimental-cua-macos'
import { createCuaApi } from '@deepseek-ai/dsh-cua/api'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { executeToolFixture } from '@alyosha28/dsh-cu-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { HELPER, pathGrant } from '../packages/dsh-computer-use-d1/tests/fixtures.ts'

const execFileAsync = promisify(execFile)

class SilentModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('benchmark called the Session model') }
  async resolveModel() {
    return { provider: 'fixture', id: 'structured', name: 'Structured', inputModalities: ['text', 'image'] } as any
  }
}

const stages: Array<{ stage: string; ms: number }> = []
let last = performance.now()
function mark(stage: string): void {
  const now = performance.now()
  stages.push({ stage, ms: Math.round(now - last) })
  last = now
}

const pid = process.argv[2]
if (pid === undefined) throw new Error('Usage: bench-cua-latency <pid>')
const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-bench-'), { mode: 0o700 })
mark('script_startup')
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx)
mark('mount_test_dependencies')
await ctx.plugin(SubprocessLocal)
await ctx.plugin(ComputerUseRegistry)
await ctx.plugin(AttachmentLocal, { dshHome: tempRoot })
mark('mount_core_plugins')
ctx.llm.registerAdapter(['fixture'], new SilentModel())
ctx.provide('userQuestions', { async ask(input: any) {
  return { answers: input.questions.map((question: any) => ({ id: question.id, selected: [question.options[0].label] })) }
} })
const harness = await mountAgentLoopTestHarness(ctx)
const agent = await harness.create(SessionId('bench'), { provider: 'fixture', model: 'structured' })
mark('mount_harness_and_agent')
await ctx.plugin(CuaMacosProvider, {
  agentPreset: false,
  helperPath: HELPER,
  allowedApps: [pathGrant('/Applications/WeChat.app/Contents/MacOS/WeChat')],
  timeoutMs: 15000,
})
mark('mount_cua_provider')
let sequence = 0
const cua = createCuaApi(async operation => {
  const result = await executeToolFixture(ctx, {
    agent, name: 'cua', arguments: operation, callId: ToolCallId(`bench-${++sequence}`),
    signal: new AbortController().signal,
  })
  if (result.isError) throw new Error(JSON.stringify(result.content))
  return z.json().parse(result.value)
})
mark('create_cua_api')
const app = await cua.getApp(pid)
mark('get_app_cold')
const windows = await app.getWindows()
mark('list_windows')
const target = windows.find((window: any) => window.isOnScreen && window.title.startsWith('微信'))
if (target === undefined) throw new Error('No visible WeChat window')
const window = await app.getWindow(target.windowId)
mark('get_window')
for (let index = 1; index <= 3; index += 1) {
  const screenshot = await window.getScreenshot({ emit: false })
  mark(`screenshot_${index}`)
  const imagePath = join(tempRoot, `shot-${index}.png`)
  await writeFile(imagePath, Buffer.from(screenshot.bytes), { mode: 0o600 })
  await execFileAsync('/tmp/dsh-cu-ocr', [imagePath], { timeout: 10000 })
  mark(`ocr_${index}`)
}
await window.getAXState({ emit: false, details: true })
mark('get_ax_state')
console.log(JSON.stringify(stages, null, 2))
await ctx.fiber.dispose()
