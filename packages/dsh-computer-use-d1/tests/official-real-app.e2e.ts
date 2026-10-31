import { executeToolFixture } from '@albaincompleta/dsh-cu-testkit'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import * as CuaMacosProvider from '@deepseek-ai/dsh-experimental-cua-macos'
import { createCuaApi } from '@deepseek-ai/dsh-cua/api'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { HELPER, ROOT } from './fixtures.ts'

const ENABLED = process.env.DSH_CU_REAL_APPS === '1'
const TEXTEDIT = '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit'

class IndependentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('official real-app e2e called the Session model') }
}

it.skipIf(!ENABLED)('uses official CUA once in a new unsaved TextEdit document', async () => {
  const ctx = new Context()
  let appPid: number | undefined
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SubprocessLocal)
    await ctx.plugin(ComputerUseRegistry)
    ctx.llm.registerAdapter(['fixture'], new IndependentSessionModel())
    ctx.provide('userQuestions', { async ask(input: any) {
      return { answers: input.questions.map((question: any) => ({ id: question.id, selected: [question.options[0].label] })) }
    } })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('official-cua-textedit'), { provider: 'fixture', model: 'structured' })
    await ctx.plugin(CuaMacosProvider, {
      agentPreset: false, helperPath: HELPER,
      allowedApps: [{
        id: createHash('sha256').update(`macos:executable-path:${TEXTEDIT}`).digest('hex'),
        name: 'TextEdit', executablePath: TEXTEDIT,
      }],
      timeoutMs: 15000,
    })
    let objectCall = 0
    let getAppCalls = 0
    const cua = createCuaApi(async operation => {
      if (operation.method === 'getApp') getAppCalls += 1
      const result = await executeToolFixture(ctx, {
        agent, signal: new AbortController().signal, callId: ToolCallId(`official-textedit-${++objectCall}`),
        name: 'cua', arguments: operation,
      })
      if (result.isError) throw new Error(JSON.stringify(result.content))
      return z.json().parse(result.value)
    })

    const running = await cua.listApps()
    expect(running.some(app => /TextEdit/iu.test(app.displayName)), 'refusing to touch an existing TextEdit process').toBe(false)
    // Official getApp owns consent and launch. It is called exactly once, with no polling loop.
    const app = await cua.getApp('com.apple.TextEdit')
    appPid = app.pid
    await app.pressKey('cmd+n')
    await delay(1000)
    const windows = (await app.getWindows()).filter(window => window.isOnScreen)
    const candidates: Array<{ window: any; elementIndex: number }> = []
    for (const candidate of windows) {
      const window = await app.getWindow(candidate.windowId)
      const tree = await window.getAXState({ emit: false, details: true })
      const document = tree.split('\n').find(line =>
        /AX(?:TextArea|TextView)/u.test(line) && /valueWritable=true/u.test(line) && /- \[\d+\]/u.test(line))
      if (document !== undefined) candidates.push({ window, elementIndex: Number(document.match(/- \[(\d+)\]/u)![1]) })
    }
    expect(candidates).toHaveLength(1)
    const target = candidates[0]
    const expected = 'DSH official CUA: 7 + 8 = 15'
    await target.window.setValue(target.elementIndex, expected)
    const after = await target.window.getAXState({ emit: false, details: true })
    expect(after).toContain(expected)
    expect(getAppCalls).toBe(1)
    const evidence = {
      application: 'macOS TextEdit', existingProcessUntouched: true, saved: false,
      api: '@deepseek-ai/dsh-cua/api createCuaApi', getAppCalls,
      inputMethod: 'official AX setValue', independentlyObservedText: expected,
    }
    await writeFile(join(ROOT, 'results/OFFICIAL_TEXTEDIT_SMOKE.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
    console.log('OFFICIAL_TEXTEDIT_EVIDENCE', JSON.stringify(evidence))
  } finally {
    if (appPid !== undefined) {
      try { process.kill(appPid, 'SIGTERM') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    await ctx.fiber.dispose()
  }
})
