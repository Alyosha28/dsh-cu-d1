import { executeToolFixture } from '@dsh-cu/testkit'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import * as Provider from '../packages/dsh-computer-use-d1/src/index.ts'
import { registerNativeVerification } from '../packages/dsh-computer-use-d1/src/verification.ts'
import { HELPER, pathGrant } from '../packages/dsh-computer-use-d1/tests/fixtures.ts'

const execFileAsync = promisify(execFile)

class IndependentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('D1 WeChat run called the Session model') }
  async resolveModel() {
    return { provider: 'fixture', id: 'structured', name: 'Structured', inputModalities: ['text', 'image'] } as any
  }
}

const [pid, windowIdText, tokenPath, article] = process.argv.slice(2)
if (pid === undefined || !/^\d+$/u.test(pid) || windowIdText === undefined || !/^\d+$/u.test(windowIdText)
  || tokenPath === undefined || (article !== 'latest' && article !== 'second')) {
  throw new Error('Usage: d1-wechat <pid> <windowId> <private-token-path> <latest|second>')
}
const target = article === 'latest'
  ? {
      title: '专业级量化研究手册',
      forbidden: ['别迷信预测', 'PaperGraph', '视频号'],
      goal: 'Click the large article card in the center of the window, between the PaperGraph card above and the glowing QuantML logo card below.',
    }
  : {
      title: '别迷信预测：高频自营靠什么赚钱？',
      forbidden: ['专业级量化研究手册', 'PaperGraph', '视频号'],
      goal: 'Read only. In the QuantML article list, click the card titled "别迷信预测：高频自营靠什么赚钱？" to open it.',
    }
const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-d1-wechat-run-'), { mode: 0o700 })
const screenshotPath = join(tempRoot, 'verification.png')
const textPath = join(tempRoot, 'verification.txt')
const ctx = new Context()
try {
  registerNativeVerification('wechat_article_open', async (_args, { caller, params, signal }) => {
    const screenshot = await caller.call('screenshot', {
      appHandle: params.appHandle, windowId: params.windowId,
    }, signal) as { data: string }
    await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'), { mode: 0o600 })
    const { stdout } = await execFileAsync('/tmp/dsh-cu-ocr', [screenshotPath], { timeout: 10000 })
    await writeFile(textPath, stdout, { mode: 0o600 })
    return stdout.includes(target.title) && target.forbidden.every(text => !stdout.includes(text))
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(AttachmentLocal, { dshHome: tempRoot })
  ctx.llm.registerAdapter(['fixture'], new IndependentSessionModel())
  ctx.provide('userQuestions', { async ask(input: any) {
    return { answers: input.questions.map((question: any) => ({ id: question.id, selected: [question.options[0].label] })) }
  } })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(`d1-wechat-${article}`), { provider: 'fixture', model: 'structured' })
  await ctx.plugin(Provider, {
    helperPath: HELPER,
    allowedApps: [pathGrant('/Applications/WeChat.app/Contents/MacOS/WeChat')],
    decisionEndpoint: 'http://127.0.0.1:8765',
    decisionToken: (await readFile(tokenPath, 'utf8')).trim(),
    decisionTimeoutMs: 120000,
    maxSteps: 4,
    maxWallClockMs: 90000,
    operationTimeoutMs: 15000,
    auditDir: tempRoot,
  })
  const result = await executeToolFixture(ctx, {
    agent,
    name: 'computer_subgoal',
    arguments: {
      goal: target.goal,
      app: pid,
      windowId: Number(windowIdText),
      verify: [{ type: 'custom', name: 'wechat_article_open' }],
    },
    callId: ToolCallId(`d1-wechat-${article}`),
    signal: new AbortController().signal,
  })
  if (result.isError) throw new Error(JSON.stringify(result.content))
  const value = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
  console.log(JSON.stringify({
    status: value.status,
    reason: value.reason,
    route: value.route,
    decisionRequests: value.decisionRequests,
    actionsExecuted: value.actionsExecuted,
    trace: value.trace,
    screenshotPath,
    textPath,
  }))
} finally {
  await ctx.fiber.dispose()
}
