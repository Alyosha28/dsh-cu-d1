import { executeToolFixture } from '@alyosha28/dsh-cu-testkit'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import * as CuaMacosProvider from '@deepseek-ai/dsh-experimental-cua-macos'
import { createCuaApi } from '@deepseek-ai/dsh-cua/api'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { NativeControlIndicator } from '../packages/dsh-computer-use-d1/src/indicator.ts'
import { HELPER, pathGrant } from '../packages/dsh-computer-use-d1/tests/fixtures.ts'

const execFileAsync = promisify(execFile)

class IndependentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('WeChat article reader called the Session model') }
  async resolveModel() {
    return { provider: 'fixture', id: 'structured', name: 'Structured', inputModalities: ['text', 'image'] } as any
  }
}

const [pid, windowIdText, label = 'article'] = process.argv.slice(2)
if (pid === undefined || !/^\d+$/u.test(pid) || windowIdText === undefined || !/^\d+$/u.test(windowIdText)
  || !/^[a-z0-9-]+$/u.test(label)) {
  throw new Error('Usage: read-wechat-article <pid> <windowId> [label]')
}
const tempRoot = await mkdtemp(join(tmpdir(), `dsh-cu-wechat-article-${label}-`), { mode: 0o700 })
const ctx = new Context()
let sequence = 0
let indicator: NativeControlIndicator | undefined
let controlReason: string | undefined
try {
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(AttachmentLocal, { dshHome: tempRoot })
  ctx.llm.registerAdapter(['fixture'], new IndependentSessionModel())
  ctx.provide('userQuestions', { async ask(input: any) {
    return { answers: input.questions.map((question: any) => ({ id: question.id, selected: [question.options[0].label] })) }
  } })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(`read-wechat-${label}`), { provider: 'fixture', model: 'structured' })
  await ctx.plugin(CuaMacosProvider, {
    agentPreset: false,
    helperPath: HELPER,
    allowedApps: [pathGrant('/Applications/WeChat.app/Contents/MacOS/WeChat')],
    timeoutMs: 15000,
  })
  const cua = createCuaApi(async operation => {
    const result = await executeToolFixture(ctx, {
      agent, name: 'cua', arguments: operation, callId: ToolCallId(`read-wechat-article-${++sequence}`),
      signal: new AbortController().signal,
    })
    if (result.isError) throw new Error(JSON.stringify(result.content))
    return z.json().parse(result.value)
  })
  const app = await cua.getApp(pid)
  const target = (await app.getWindows()).find((window: any) => window.windowId === Number(windowIdText))
  if (target === undefined) throw new Error('The article window is unavailable')
  const window = await app.getWindow(target.windowId)
  indicator = await NativeControlIndicator.create(undefined, action => { controlReason = action }, () => {
    controlReason = 'indicator_unavailable'
  })
  await indicator.start(randomUUID(), { pid: Number(pid), windowId: target.windowId, title: target.title, bounds: target.bounds })
  const pages: Array<{ screen: number; text: string; imagePath: string }> = []
  let previousBytes: Uint8Array | undefined
  let stopped = 'screen_limit'
  for (let screen = 1; screen <= 12; screen += 1) {
    if (controlReason !== undefined) {
      stopped = controlReason
      break
    }
    const screenshot = await window.getScreenshot({ emit: false })
    const imagePath = join(tempRoot, `screen-${screen}.png`)
    await writeFile(imagePath, Buffer.from(screenshot.bytes), { mode: 0o600 })
    const { stdout } = await execFileAsync('/tmp/dsh-cu-ocr', [imagePath], { timeout: 10000 })
    pages.push({ screen, text: stdout, imagePath })
    if (previousBytes !== undefined && Buffer.from(previousBytes).equals(Buffer.from(screenshot.bytes))) {
      stopped = 'bottom_reached'
      break
    }
    previousBytes = screenshot.bytes
    await indicator.activity({
      phase: 'acting', operation: 'SCROLL_DOWN',
      point: { x: target.bounds.x + target.bounds.width / 2, y: target.bounds.y + target.bounds.height * 0.6 },
    })
    await window.scroll({ x: 500, y: 600, deltaLinesX: 0, deltaLinesY: -8, relative: true })
    await delay(600)
  }
  await indicator.activity({ phase: 'verifying' })
  const textPath = join(tempRoot, 'article.json')
  await writeFile(textPath, JSON.stringify({ stopped, pages }, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ stopped, screens: pages.length, textPath, directory: tempRoot }))
} finally {
  await indicator?.close()
  await ctx.fiber.dispose()
}
