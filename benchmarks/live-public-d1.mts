import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import * as Provider from '../packages/dsh-browser-use-d1/src/index.ts'

const token = process.env.D1_DECISION_TOKEN
if (token === undefined || token.trim() === '') {
  throw new Error('Set D1_DECISION_TOKEN explicitly to run live public-browser tests')
}
const endpoint = process.env.D1_DECISION_ENDPOINT ?? 'http://127.0.0.1:8765'
const iterations = Number(process.env.DSH_CU_LIVE_ITERATIONS ?? '3')
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 20) {
  throw new Error('DSH_CU_LIVE_ITERATIONS must be an integer from 1 to 20')
}
const output = resolve(process.env.DSH_CU_LIVE_OUTPUT ?? 'results/LIVE_BROWSER_RELIABILITY.json')
const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

class IndependentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk> {
    throw new Error('live public-browser test called the Session model')
  }
}

const cases = [
  {
    id: 'example-domain-link',
    goal: 'Open the Learn more link on this Example Domain page.',
    url: 'https://example.com/',
    verify: [{ type: 'url_contains', value: 'iana.org' }],
    maxSteps: 4,
  },
  {
    id: 'wikipedia-search',
    goal: "Search Wikipedia for 'Alan Turing' and open the Alan Turing article.",
    url: 'https://www.wikipedia.org/',
    verify: [{ type: 'url_contains', value: '/wiki/Alan_Turing' }],
    maxSteps: 8,
  },
] as const

const outcomes: Array<Record<string, any>> = []
const ctx = new Context()
try {
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(BrowserUseRegistry)
  ctx.llm.registerAdapter(['fixture'], new IndependentSessionModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(`d1-live-public-${randomUUID()}`), { provider: 'fixture', model: 'structured' })
  await ctx.plugin(Provider, {
    mode: 'launch', executablePath, headless: process.env.DSH_CU_LIVE_HEADLESS !== 'false',
    decisionEndpoint: endpoint, decisionToken: token, textStrategy: 'speculative',
    operationTimeoutMs: 15000, verificationTimeoutMs: 10000, maxSteps: 8,
  })
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    for (const testCase of cases) {
      const startedAt = new Date().toISOString()
      const args = { goal: testCase.goal, url: testCase.url, verify: [...testCase.verify], maxSteps: testCase.maxSteps }
      let outcome: Record<string, any>
      try {
        const result = await executeToolFixture(ctx, {
          agent, name: 'd1_browser_subgoal', arguments: args,
          callId: ToolCallId(`${testCase.id}-${iteration}`), signal: AbortSignal.timeout(90000),
        })
        const text = (result.content[0] as { text?: string } | undefined)?.text
        let value: unknown = text
        try { value = JSON.parse(text!) } catch {}
        outcome = { iteration, id: testCase.id, startedAt, isError: result.isError, result: value }
      } catch (error) {
        outcome = { iteration, id: testCase.id, startedAt, isError: true, error: error instanceof Error ? error.message : String(error) }
      }
      outcomes.push(outcome)
      console.log('PUBLIC_RUN', JSON.stringify(outcome))
    }
  }
} finally {
  await ctx.fiber.dispose()
}

const summary = cases.map(testCase => {
  const runs = outcomes.filter(outcome => outcome.id === testCase.id)
  const passed = runs.filter(outcome => !outcome.isError && outcome.result?.status === 'success'
    && outcome.result?.actionsExecuted >= 1 && outcome.result?.decisionRequests >= 1)
  return {
    id: testCase.id, passed: passed.length, total: runs.length,
    actions: runs.map(run => run.result?.actionsExecuted),
    stale: runs.map(run => run.result?.staleDecisions),
    decisionLatencyMs: runs.map(run => run.result?.decisionLatencyMs),
  }
})
const evidence = {
  finishedAt: new Date().toISOString(), browser: 'Google Chrome', model: 'LiquidAI/d1-2B local',
  scriptedDecision: false, network: 'live public sites', summary, outcomes,
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
console.log('PUBLIC_SUMMARY', JSON.stringify(summary))
if (summary.some(item => item.passed !== item.total)) process.exitCode = 1
