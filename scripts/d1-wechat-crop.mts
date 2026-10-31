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
import { D1DecisionClient } from '@alyosha28/dsh-cu-core/decision'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { NativeControlIndicator } from '../packages/dsh-computer-use-d1/src/indicator.ts'
import { HELPER, pathGrant } from '../packages/dsh-computer-use-d1/tests/fixtures.ts'

const execFileAsync = promisify(execFile)

class IndependentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('Cropped D1 WeChat run called the Session model') }
  async resolveModel() {
    return { provider: 'fixture', id: 'structured', name: 'Structured', inputModalities: ['text', 'image'] } as any
  }
}

const [pid, windowIdText, tokenPath, article] = process.argv.slice(2)
if (pid === undefined || !/^\d+$/u.test(pid) || windowIdText === undefined || !/^\d+$/u.test(windowIdText)
  || tokenPath === undefined || (article !== 'latest' && article !== 'second')) {
  throw new Error('Usage: d1-wechat-crop <pid> <windowId> <private-token-path> <latest|second>')
}
const expected = article === 'latest' ? '专业级量化研究手册' : '别迷信预测'
const goal = 'Click the only large article card shown in this image. The card is fully visible; do not scroll.'
const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-d1-wechat-crop-'), { mode: 0o700 })
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
  const agent = await harness.create(SessionId(`d1-wechat-crop-${article}`), { provider: 'fixture', model: 'structured' })
  await ctx.plugin(CuaMacosProvider, {
    agentPreset: false,
    helperPath: HELPER,
    allowedApps: [pathGrant('/Applications/WeChat.app/Contents/MacOS/WeChat')],
    timeoutMs: 15000,
  })
  const cua = createCuaApi(async operation => {
    const result = await executeToolFixture(ctx, {
      agent, name: 'cua', arguments: operation, callId: ToolCallId(`d1-wechat-crop-${++sequence}`),
      signal: new AbortController().signal,
    })
    if (result.isError) throw new Error(JSON.stringify(result.content))
    return z.json().parse(result.value)
  })
  const app = await cua.getApp(pid)
  const target = (await app.getWindows()).find((window: any) => window.windowId === Number(windowIdText))
  if (target === undefined) throw new Error('The authorized WeChat window is unavailable')
  const window = await app.getWindow(target.windowId)
  const fullPath = join(tempRoot, 'full.png')
  const cropPath = join(tempRoot, 'crop.png')
  const screenshot = await window.getScreenshot({ emit: false })
  await writeFile(fullPath, Buffer.from(screenshot.bytes), { mode: 0o600 })
  const crop = {
    x: Math.round(screenshot.pixelWidth * 0.31),
    y: Math.round(screenshot.pixelHeight * (article === 'latest' ? 0.22 : 0.50)),
    width: Math.round(screenshot.pixelWidth * 0.36),
    height: Math.round(screenshot.pixelHeight * 0.43),
  }
  await execFileAsync('magick', [fullPath, '-crop', `${crop.width}x${crop.height}+${crop.x}+${crop.y}`, '+repage', cropPath])
  const cropped = await readFile(cropPath)
  const client = new D1DecisionClient({
    decisionEndpoint: 'http://127.0.0.1:8765',
    decisionToken: (await readFile(tokenPath, 'utf8')).trim(),
    decisionTimeoutMs: 120000,
    textStrategy: 'speculative',
  })
  const response = await client.decide(goal, {
    snapshot_id: randomUUID(), version: 0, url: `app://${pid}/${target.windowId}`, title: 'QuantML',
    truncated: false, can_scroll_up: true, can_scroll_down: true, elements: [],
  }, new AbortController().signal, undefined, { data: cropped.toString('base64'), mimeType: 'image/png' })
  const decision = response.decision
  if (decision.operation !== 'CLICK' || decision.box === undefined) {
    console.log(JSON.stringify({ status: 'blocked', decision, crop, fullPath }))
    throw new Error('D1 did not select a clickable article region')
  }
  const fullX = crop.x + (decision.box.left + decision.box.right) * crop.width / 2
  const fullY = crop.y + (decision.box.top + decision.box.bottom) * crop.height / 2
  indicator = await NativeControlIndicator.create(undefined, action => { controlReason = action }, () => {
    controlReason = 'indicator_unavailable'
  })
  await indicator.start(randomUUID(), { pid: Number(pid), windowId: target.windowId, title: target.title, bounds: target.bounds })
  if (controlReason !== undefined) throw new Error(`WeChat run stopped: ${controlReason}`)
  await window.getScreenshot({ emit: false })
  await indicator.activity({
    phase: 'acting', operation: 'CLICK',
    point: {
      x: target.bounds.x + fullX * target.bounds.width / screenshot.pixelWidth,
      y: target.bounds.y + fullY * target.bounds.height / screenshot.pixelHeight,
    },
  })
  await window.click([fullX, fullY])
  await delay(1000)
  await indicator.activity({ phase: 'verifying' })
  const after = await window.getScreenshot({ emit: false })
  const afterPath = join(tempRoot, 'after.png')
  const textPath = join(tempRoot, 'after.txt')
  await writeFile(afterPath, Buffer.from(after.bytes), { mode: 0o600 })
  const { stdout } = await execFileAsync('/tmp/dsh-cu-ocr', [afterPath], { timeout: 10000 })
  await writeFile(textPath, stdout, { mode: 0o600 })
  console.log(JSON.stringify({
    status: stdout.includes(expected) ? 'opened_pending_visual_review' : 'unverified',
    decision, fullX, fullY, afterPath, textPath,
  }))
} finally {
  await indicator?.close()
  await ctx.fiber.dispose()
}
