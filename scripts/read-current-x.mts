import { executeToolFixture } from '@dsh-cu/testkit'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import { createCuaApi } from '@deepseek-ai/dsh-cua/api'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import * as Provider from '../packages/dsh-computer-use-d1/src/index.ts'
import { HELPER, pathGrant } from '../packages/dsh-computer-use-d1/tests/fixtures.ts'

class ReadOnlySessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('Read-only CUA called the Session model') }
  async resolveModel() {
    return { provider: 'fixture', id: 'structured', name: 'Structured', inputModalities: ['text', 'image'] } as any
  }
}

async function activeTabUrl(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', 'tell application "Google Chrome" to get URL of active tab of front window'], { encoding: 'utf8' }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout.trim())
    })
  })
}

async function recognize(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/tmp/dsh-cu-ocr', [path], { encoding: 'utf8', timeout: 10000 }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout)
    })
  })
}

const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-read-x-'))
const ctx = new Context()
let sequence = 0
try {
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(AttachmentLocal, { dshHome: tempRoot })
  ctx.provide('userQuestions', { async ask(input: any) {
    return { answers: input.questions.map((question: any) => ({ id: question.id, selected: [question.options[0].label] })) }
  } })
  ctx.llm.registerAdapter(['fixture'], new ReadOnlySessionModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('read-current-x'), { provider: 'fixture', model: 'structured' })
  await ctx.plugin(Provider, {
    helperPath: HELPER,
    allowedApps: [pathGrant('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')],
    decisionEndpoint: 'http://127.0.0.1:1',
    decisionToken: 'read-only-unused',
    auditDir: tempRoot,
    controlToken: 'read-current-x-control',
  })
  const cua = createCuaApi(async operation => {
    const result = await executeToolFixture(ctx, {
      agent, name: 'cua', arguments: operation, callId: ToolCallId(`read-x-${++sequence}`),
      signal: new AbortController().signal,
    })
    if (result.isError) throw new Error(JSON.stringify(result.content))
    return z.json().parse(result.value)
  })
  const app = await cua.getApp(process.argv[2] ?? '1428')
  const windows = await app.getWindows()
  const selected = windows.find((window: any) => window.isOnScreen && /(?:主页|Home|X)/u.test(window.title))
  if (selected === undefined) throw new Error('No visible X window was found')
  const window = await app.getWindow(selected.windowId)
  const action = process.argv[3]
  if (action === 'open') {
    console.log(await window.click([610, 425], { relative: true }))
    await delay(700)
    console.log(await activeTabUrl())
  } else if (action === 'collect') {
    const records: Array<{ index: number; url: string; text: string }> = []
    if ((await activeTabUrl()).endsWith('/home') === false) {
      await app.pressKey('command+left')
      await delay(700)
    }
    for (let index = 1; index <= 10; index += 1) {
      await window.click([610, 425], { relative: true })
      await delay(700)
      const url = await activeTabUrl()
      if (url.endsWith('/home') || records.some(record => record.url === url)) {
        console.log(JSON.stringify({ records, stoppedAt: index, reason: 'post_navigation_did_not_advance' }, null, 2))
        break
      }
      const screenshot = await window.getScreenshot({ emit: false })
      const imagePath = join(tempRoot, `post-${index}.png`)
      await writeFile(imagePath, Buffer.from(screenshot.bytes), { mode: 0o600 })
      records.push({ index, url, text: await recognize(imagePath) })
      await app.pressKey('command+left')
      await delay(700)
      await window.scroll({ x: 500, y: 700, deltaLinesX: 0, deltaLinesY: -6, relative: true })
      await delay(500)
      if (index === 10) console.log(JSON.stringify({ records }, null, 2))
    }
  } else {
    const screenshot = await window.getScreenshot({ emit: false })
    const outputPath = action ?? '/tmp/x-home.png'
    await writeFile(outputPath, Buffer.from(screenshot.bytes), { mode: 0o600 })
    console.log(JSON.stringify({ windowId: selected.windowId, outputPath }))
  }
} finally {
  await ctx.fiber.dispose()
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
