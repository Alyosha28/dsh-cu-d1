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
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { HELPER, pathGrant } from '../packages/dsh-computer-use-d1/tests/fixtures.ts'

class ReadOnlySessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('WeChat inspection called the Session model') }
  async resolveModel() {
    return { provider: 'fixture', id: 'structured', name: 'Structured', inputModalities: ['text', 'image'] } as any
  }
}

const pid = process.argv[2]
if (pid === undefined || !/^\d+$/u.test(pid)) throw new Error('Usage: inspect-wechat <pid>')
const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-wechat-inspect-'), { mode: 0o700 })
const ctx = new Context()
let sequence = 0
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
  const agent = await harness.create(SessionId('inspect-wechat'), { provider: 'fixture', model: 'structured' })
  await ctx.plugin(CuaMacosProvider, {
    agentPreset: false,
    helperPath: HELPER,
    allowedApps: [pathGrant('/Applications/WeChat.app/Contents/MacOS/WeChat')],
    timeoutMs: 15000,
  })
  const cua = createCuaApi(async operation => {
    const result = await executeToolFixture(ctx, {
      agent, name: 'cua', arguments: operation, callId: ToolCallId(`inspect-wechat-${++sequence}`),
      signal: new AbortController().signal,
    })
    if (result.isError) throw new Error(JSON.stringify(result.content))
    return z.json().parse(result.value)
  })
  const app = await cua.getApp(pid)
  const windows = await app.getWindows()
  const candidates = windows.filter((window: any) => window.isOnScreen && /^(?:微信|WeChat)$/u.test(window.title))
  if (candidates.length === 0) throw new Error('No visible main WeChat window was found')
  const observations = []
  for (const [index, selected] of candidates.entries()) {
    const window = await app.getWindow(selected.windowId)
    const tree = await window.getAXState({ emit: false, details: true })
    const screenshot = await window.getScreenshot({ emit: false })
    const axPath = join(tempRoot, `window-${index}.ax.txt`)
    const imagePath = join(tempRoot, `window-${index}.png`)
    await Promise.all([
      writeFile(axPath, tree, { mode: 0o600 }),
      writeFile(imagePath, Buffer.from(screenshot.bytes), { mode: 0o600 }),
    ])
    observations.push({ windowId: selected.windowId, bounds: selected.bounds, axPath, imagePath })
  }
  console.log(JSON.stringify({ observations }))
} finally {
  await ctx.fiber.dispose()
}
