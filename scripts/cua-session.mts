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
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { z } from 'zod'
import { NativeControlIndicator } from '../packages/dsh-computer-use-d1/src/indicator.ts'
import { HELPER, pathGrant } from '../packages/dsh-computer-use-d1/tests/fixtures.ts'

const execFileAsync = promisify(execFile)

class SilentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('cua-session called the Session model') }
  async resolveModel() {
    return { provider: 'fixture', id: 'structured', name: 'Structured', inputModalities: ['text', 'image'] } as any
  }
}

const box = z.object({
  left: z.number().min(0).max(1), top: z.number().min(0).max(1),
  right: z.number().min(0).max(1), bottom: z.number().min(0).max(1),
}).strict()

const command = z.discriminatedUnion('op', [
  z.object({ op: z.literal('attach'), pid: z.string().regex(/^\d+$/u), windowId: z.number().int().positive() }).strict(),
  z.object({ op: z.literal('activate') }).strict(),
  z.object({ op: z.literal('restore') }).strict(),
  z.object({ op: z.literal('capture'), crop: box.optional(), ocr: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('decide'), goal: z.string().min(1), image: z.string().min(1), crop: box.optional() }).strict(),
  z.object({ op: z.literal('click'), x: z.number().int().min(0).max(999), y: z.number().int().min(0).max(999) }).strict(),
  z.object({
    op: z.literal('scroll'), x: z.number().int().min(0).max(999), y: z.number().int().min(0).max(999),
    delta: z.number().int().min(-10).max(10).refine(value => value !== 0),
    waitMs: z.number().int().min(0).max(5000).optional(),
  }).strict(),
  z.object({ op: z.literal('key'), chord: z.string().min(1) }).strict(),
  z.object({ op: z.literal('type'), text: z.string().min(1) }).strict(),
  z.object({ op: z.literal('exit') }).strict(),
])

type Command = z.infer<typeof command>

const tokenPath = process.argv[2]
if (tokenPath === undefined) throw new Error('Usage: cua-session <decision-token-path>')
const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-session-'), { mode: 0o700 })
const token = (await readFile(tokenPath, 'utf8')).trim()
const ctx = new Context()
const startedAt = performance.now()
let sequence = 0

await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(SubprocessLocal)
await ctx.plugin(ComputerUseRegistry)
await ctx.plugin(AttachmentLocal, { dshHome: tempRoot })
ctx.llm.registerAdapter(['fixture'], new SilentSessionModel())
ctx.provide('userQuestions', { async ask(input: any) {
  return { answers: input.questions.map((question: any) => ({ id: question.id, selected: [question.options[0].label] })) }
} })
const harness = await mountAgentLoopTestHarness(ctx)
const agent = await harness.create(SessionId('cua-session'), { provider: 'fixture', model: 'structured' })
await ctx.plugin(CuaMacosProvider, {
  agentPreset: false,
  helperPath: HELPER,
  allowedApps: [pathGrant('/Applications/WeChat.app/Contents/MacOS/WeChat')],
  timeoutMs: 15000,
})
const cua = createCuaApi(async operation => {
  const result = await executeToolFixture(ctx, {
    agent, name: 'cua', arguments: operation, callId: ToolCallId(`cua-session-${++sequence}`),
    signal: new AbortController().signal,
  })
  if (result.isError) throw new Error(JSON.stringify(result.content))
  return z.json().parse(result.value)
})
const decisionClient = new D1DecisionClient({
  decisionEndpoint: 'http://127.0.0.1:8765', decisionToken: token, decisionTimeoutMs: 120000, textStrategy: 'speculative',
})
let helper: NativeControlIndicator | undefined
async function ensureHelper(): Promise<NativeControlIndicator> {
  helper ??= await NativeControlIndicator.create(undefined, () => undefined, () => undefined)
  return helper
}
const bootMs = Math.round(performance.now() - startedAt)

interface Session {
  app: any
  window: any
  target: any
}
let session: Session | undefined
let previousForeground: number | undefined

async function currentForeground(): Promise<number> {
  const { stdout } = await execFileAsync('/usr/bin/osascript', [
    '-e', 'tell application "System Events" to get unix id of first application process whose frontmost is true',
  ])
  return Number(stdout.trim())
}

async function focusApplication(pid: number): Promise<void> {
  await execFileAsync('/usr/bin/osascript', [
    '-e', `tell application "System Events" to set frontmost of (first application process whose unix id is ${pid}) to true`,
  ])
}

async function capture(window: any, crop?: z.infer<typeof box>): Promise<{
  path: string
  pixelWidth: number
  pixelHeight: number
  box?: { x: number; y: number; width: number; height: number }
}> {
  const shot = await window.getScreenshot({ emit: false })
  const stamp = Date.now()
  const fullPath = join(tempRoot, `shot-${stamp}.png`)
  await writeFile(fullPath, Buffer.from(shot.bytes), { mode: 0o600 })
  if (crop === undefined) return { path: fullPath, pixelWidth: shot.pixelWidth, pixelHeight: shot.pixelHeight }
  const x = Math.round(shot.pixelWidth * crop.left)
  const y = Math.round(shot.pixelHeight * crop.top)
  const width = Math.round(shot.pixelWidth * (crop.right - crop.left))
  const height = Math.round(shot.pixelHeight * (crop.bottom - crop.top))
  const croppedPath = join(tempRoot, `crop-${stamp}.png`)
  await execFileAsync('magick', [fullPath, '-crop', `${width}x${height}+${x}+${y}`, '+repage', croppedPath])
  return { path: croppedPath, pixelWidth: width, pixelHeight: height, box: { x, y, width, height } }
}

async function recognize(path: string): Promise<string> {
  const { stdout } = await execFileAsync('/tmp/dsh-cu-ocr-zh', [path], { timeout: 15000 })
  return stdout
}

async function handle(input: Command): Promise<Record<string, unknown>> {
  if (input.op === 'exit') return { ok: true, exited: true }
  if (input.op === 'attach') {
    const app = await cua.getApp(input.pid)
    const target = (await app.getWindows()).find((window: any) => window.windowId === input.windowId)
    if (target === undefined) throw new Error('window_unavailable')
    const window = await app.getWindow(target.windowId)
    session = { app, window, target }
    return { ok: true, pid: app.pid, windowId: target.windowId, title: target.title, bounds: target.bounds }
  }
  if (session === undefined) throw new Error('session_not_attached')
  const { app, window, target } = session
  if (input.op === 'activate') {
    const started = performance.now()
    previousForeground ??= await currentForeground()
    await focusApplication(app.pid)
    await delay(150)
    return { ok: true, previousForeground, frontmost: await currentForeground(), elapsedMs: Math.round(performance.now() - started) }
  }
  if (input.op === 'restore') {
    if (previousForeground === undefined) return { ok: true, restored: false }
    const restore = previousForeground
    previousForeground = undefined
    await focusApplication(restore)
    await delay(150)
    return { ok: true, restored: true, frontmost: await currentForeground() }
  }
  if (input.op === 'capture') {
    const started = performance.now()
    const shot = await capture(window, input.crop)
    const captureMs = Math.round(performance.now() - started)
    if (input.ocr !== true) return { ok: true, ...shot, captureMs, elapsedMs: captureMs }
    const text = await recognize(shot.path)
    return { ok: true, ...shot, text, captureMs, elapsedMs: Math.round(performance.now() - started) }
  }
  if (input.op === 'decide') {
    const started = performance.now()
    const bytes = await readFile(input.image)
    const response = await decisionClient.decide(input.goal, {
      snapshot_id: randomUUID(), version: 0, url: `app://${app.pid}/${target.windowId}`,
      title: target.title ?? '', truncated: false, can_scroll_up: true, can_scroll_down: true, elements: [],
    }, new AbortController().signal, undefined, { data: bytes.toString('base64'), mimeType: 'image/png' })
    const decision = response.decision
    const mapped = input.crop === undefined || decision.box === undefined ? undefined : {
      x: Math.round(input.crop.left * 999 + (decision.box.left + decision.box.right) / 2 * (input.crop.right - input.crop.left) * 999),
      y: Math.round(input.crop.top * 999 + (decision.box.top + decision.box.bottom) / 2 * (input.crop.bottom - input.crop.top) * 999),
    }
    return { ok: true, decision, windowPoint: mapped, latencyMs: response.latencyMs, elapsedMs: Math.round(performance.now() - started) }
  }
  const point = (x: number, y: number) => ({
    x: target.bounds.x + x * target.bounds.width / 999,
    y: target.bounds.y + y * target.bounds.height / 999,
  })
  if (input.op === 'click') {
    const started = performance.now()
    const indicator = await ensureHelper()
    await indicator.start(randomUUID(), { pid: app.pid, windowId: target.windowId, title: target.title, bounds: target.bounds })
    await indicator.activity({ phase: 'acting', operation: 'CLICK', point: point(input.x, input.y) })
    await window.click([input.x, input.y], { relative: true })
    await indicator.activity({ phase: 'verifying' })
    await indicator.finish()
    return { ok: true, elapsedMs: Math.round(performance.now() - started) }
  }
  if (input.op === 'scroll') {
    const started = performance.now()
    const indicator = await ensureHelper()
    await indicator.start(randomUUID(), { pid: app.pid, windowId: target.windowId, title: target.title, bounds: target.bounds })
    await indicator.activity({
      phase: 'acting', operation: input.delta < 0 ? 'SCROLL_DOWN' : 'SCROLL_UP', point: point(input.x, input.y),
    })
    await window.scroll({ x: input.x, y: input.y, deltaLinesX: 0, deltaLinesY: input.delta, relative: true })
    await indicator.finish()
    await delay(input.waitMs ?? 250)
    return { ok: true, elapsedMs: Math.round(performance.now() - started) }
  }
  if (input.op === 'key') {
    await app.pressKey(input.chord)
    return { ok: true }
  }
  await app.typeText(input.text)
  return { ok: true }
}

process.stdout.write(`${JSON.stringify({ ok: true, ready: true, bootMs, directory: tempRoot })}\n`)
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
let closing = false
let queue = Promise.resolve()
lines.on('line', line => {
  queue = queue.then(async () => {
    const sentAt = performance.now()
    let reply: Record<string, unknown>
    try {
      const parsed = command.parse(JSON.parse(line))
      const value = await handle(parsed)
      reply = { ...value, ipcMs: Math.round(performance.now() - sentAt) }
      if (parsed.op === 'exit') {
        closing = true
        process.stdout.write(`${JSON.stringify(reply)}\n`)
        await helper?.close()
        await ctx.fiber.dispose()
        process.exit(0)
      }
    } catch (error) {
      reply = { ok: false, error: error instanceof Error ? error.message.slice(0, 400) : 'unknown_error' }
    }
    if (!closing) process.stdout.write(`${JSON.stringify(reply)}\n`)
  })
})

lines.on('close', () => {
  void queue.then(async () => {
    await helper?.close()
    await ctx.fiber.dispose()
    process.exit(0)
  })
})
