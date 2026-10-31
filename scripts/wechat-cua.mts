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
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { NativeControlIndicator } from '../packages/dsh-computer-use-d1/src/indicator.ts'
import { HELPER, pathGrant } from '../packages/dsh-computer-use-d1/tests/fixtures.ts'

class ReadOnlySessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('WeChat reader called the Session model') }
  async resolveModel() {
    return { provider: 'fixture', id: 'structured', name: 'Structured', inputModalities: ['text', 'image'] } as any
  }
}

const [pid, windowIdText, command = 'inspect', ...args] = process.argv.slice(2)
if (pid === undefined || !/^\d+$/u.test(pid) || windowIdText === undefined || (windowIdText !== 'all' && !/^\d+$/u.test(windowIdText))) {
  throw new Error('Usage: wechat-cua <pid> <windowId|all> [inspect|click|type|key|scroll] [arguments]')
}
const windowId = Number(windowIdText)
const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-wechat-action-'), { mode: 0o700 })
const ctx = new Context()
let sequence = 0
let indicator: NativeControlIndicator | undefined
let controlReason: string | undefined
try {
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(AttachmentLocal, { dshHome: tempRoot })
  ctx.llm.registerAdapter(['fixture'], new ReadOnlySessionModel())
  ctx.provide('userQuestions', { async ask(input: any) {
    return { answers: input.questions.map((question: any) => ({ id: question.id, selected: [question.options[0].label] })) }
  } })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('read-wechat'), { provider: 'fixture', model: 'structured' })
  await ctx.plugin(CuaMacosProvider, {
    agentPreset: false,
    helperPath: HELPER,
    allowedApps: [
      pathGrant('/Applications/WeChat.app/Contents/MacOS/WeChat'),
      pathGrant('/Applications/WeChat.app/Contents/MacOS/WeChatAppEx.app/Contents/MacOS/WeChatAppEx'),
    ],
    timeoutMs: 15000,
  })
  const cua = createCuaApi(async operation => {
    const result = await executeToolFixture(ctx, {
      agent, name: 'cua', arguments: operation, callId: ToolCallId(`read-wechat-${++sequence}`),
      signal: new AbortController().signal,
    })
    if (result.isError) throw new Error(JSON.stringify(result.content))
    return z.json().parse(result.value)
  })
  const app = await cua.getApp(pid)
  const windows = await app.getWindows()
  const selected = windows.filter((window: any) => window.windowId === windowId)
  if (windowIdText !== 'all' && selected.length !== 1) throw new Error('The authorized WeChat window is no longer available')
  const target = selected[0]
  const window = target === undefined ? undefined : await app.getWindow(windowId)
  if (command !== 'inspect') {
    if (target === undefined || window === undefined) throw new Error('WeChat actions require one explicit windowId')
    indicator = await NativeControlIndicator.create(undefined, action => { controlReason = action }, () => {
      controlReason = 'indicator_unavailable'
    })
    await indicator.start(randomUUID(), {
      pid: Number(pid), windowId, title: target.title, bounds: target.bounds,
    })
    await delay(120)
    const checkControl = () => {
      if (controlReason !== undefined) throw new Error(`WeChat run stopped: ${controlReason}`)
    }
    const point = (x: number, y: number) => ({
      x: target.bounds.x + x * target.bounds.width / 999,
      y: target.bounds.y + y * target.bounds.height / 999,
    })
    const coordinates = (x: number, y: number) => {
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 999 || y > 999) {
        throw new Error('WeChat action coordinates must be integer window thousandths from 0 to 999')
      }
    }
    checkControl()
    if (command === 'show') {
      await indicator.activity({ phase: 'waiting' })
      await window.show()
    } else if (command === 'activate') {
      await indicator.activity({ phase: 'waiting' })
      await app.activate()
    } else if (command === 'click') {
      const [x, y] = args.slice(0, 2).map(Number)
      const clickCount = args[2] === '2' ? 2 : 1
      const mouseButton = args[2] === 'right' ? 'right' : 'left'
      coordinates(x, y)
      await indicator.activity({ phase: 'acting', operation: 'CLICK', point: point(x, y) })
      await window.click([x, y], { relative: true, clickCount, mouseButton })
    } else if (command === 'type') {
      const text = args.join(' ')
      if (text.length === 0) throw new Error('WeChat type command requires text')
      await indicator.activity({ phase: 'acting', operation: 'TYPE_TEXT' })
      await app.typeText(text)
    } else if (command === 'key') {
      if (args[0] === undefined) throw new Error('WeChat key command requires a chord')
      await indicator.activity({ phase: 'acting', operation: 'TYPE_TEXT' })
      await app.pressKey(args[0])
    } else if (command === 'scroll') {
      const [x, y, delta] = args.slice(0, 3).map(Number)
      coordinates(x, y)
      if (!Number.isInteger(delta) || delta < -10 || delta > 10 || delta === 0) throw new Error('Invalid scroll delta')
      await indicator.activity({ phase: 'acting', operation: delta < 0 ? 'SCROLL_DOWN' : 'SCROLL_UP', point: point(x, y) })
      await window.scroll({ x, y, deltaLinesX: 0, deltaLinesY: delta, relative: true })
    } else {
      throw new Error(`Unsupported WeChat command: ${command}`)
    }
    await delay(700)
    checkControl()
    await indicator.activity({ phase: 'verifying' })
  }
  const visible = windowIdText === 'all'
    ? windows
    : command === 'inspect'
      ? [target]
      : await app.getWindows()
  const observations = []
  for (const [index, record] of visible.entries()) {
    const observedWindow = await app.getWindow(record.windowId)
    const tree = await observedWindow.getAXState({ emit: false, details: true })
    const screenshot = await observedWindow.getScreenshot({ emit: false })
    const axPath = join(tempRoot, `window-${index}.ax.txt`)
    const imagePath = join(tempRoot, `window-${index}.png`)
    await Promise.all([
      writeFile(axPath, tree, { mode: 0o600 }),
      writeFile(imagePath, Buffer.from(screenshot.bytes), { mode: 0o600 }),
    ])
    observations.push({
      windowId: record.windowId, title: record.title, bounds: record.bounds,
      isOnScreen: record.isOnScreen, onCurrentSpace: record.onCurrentSpace, axPath, imagePath,
    })
  }
  console.log(JSON.stringify({ command, observations }))
} finally {
  await indicator?.close()
  await ctx.fiber.dispose()
}
