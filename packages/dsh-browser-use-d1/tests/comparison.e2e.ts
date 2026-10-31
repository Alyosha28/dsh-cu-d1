import { executeToolFixture } from '@alyosha28/dsh-cu-testkit'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Llm from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Projections from '@deepseek-ai/dsh-session-projection'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as OfficialProvider from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
import { afterEach, expect, it } from 'vitest'
import * as D1Provider from '../src/index.ts'
import { CHROME, close, fixtureServer, listen, ROOT } from './fixtures.ts'


const token = process.env.D1_DECISION_TOKEN
const decisionEndpoint = process.env.D1_DECISION_ENDPOINT ?? 'http://127.0.0.1:8765'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup())) })

async function mount(provider: Pick<Plugin.Object<any>, 'apply'>, browserConfig: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-provider-comparison-'))
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const modules = new Map<string, unknown>([
    ['browserUse', BrowserUse], ['prompt', SystemPrompt], ['tools', Tools], ['llm', Llm],
    ['sessions', Sessions], ['agents', Agents], ['loop', AgentLoop], ['projections', Projections], ['browser', provider],
    ['fs', LocalFileSystem], ['workingDirectory', WorkingDirectory],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({
    id: name, name, config: name === 'loop' ? { agents: [] } : name === 'browser' ? browserConfig : {},
  }))))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected comparison module ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const owner = await ctx.agents.create({ sessionId: SessionId(`comparison-${Math.random()}`), meta: { cwd: root } })
  await owner.agent.whenIdle()
  return { ctx, agent: owner.agent }
}

async function execute(ctx: Context, agent: Agent, name: string, args: unknown, id: string) {
  const result = await executeToolFixture(ctx, {
    agent, name, arguments: args, callId: ToolCallId(id), signal: new AbortController().signal,
  })
  expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).toBe(false)
  return result
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n')
}

function ref(snapshot: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = snapshot.match(new RegExp(`"${escaped}"[^\\n]*\\[ref=([^\\]]+)\\]`))
  if (match === null) throw new Error(`Missing ${name} ref in ${snapshot}`)
  return match[1]!
}

async function officialFlights(ctx: Context, agent: Agent, url: string) {
  let calls = 0
  const call = async (name: string, args: unknown) => {
    calls += 1
    return execute(ctx, agent, `mcp__playwright-mcp__${name}`, args, `official-${calls}`)
  }
  await call('browser_navigate', { url })
  const type = async (name: string, value: string) => {
    const snapshot = text(await call('browser_snapshot', {}))
    await call('browser_type', { element: name, target: ref(snapshot, name), text: value })
  }
  await type('From', 'Zürich')
  await type('To', 'London')
  await type('Departure date', '2026-11-01')
  const snapshot = text(await call('browser_snapshot', {}))
  await call('browser_click', { element: 'Search flights', target: ref(snapshot, 'Search flights') })
  await call('browser_wait_for', { text: 'Zürich to London · 2026-11-01' })
  expect(text(await call('browser_snapshot', {}))).toContain('Zürich to London · 2026-11-01')
  return { toolCalls: calls }
}

it.skipIf(!token)('compares scripted official Playwright MCP with the D1 provider on the same local task', async () => {
  const fixtures = fixtureServer()
  const fixtureUrl = await listen(fixtures)
  cleanups.push(() => close(fixtures))
  const url = `${fixtureUrl}/flights.html`

  const official = await mount(OfficialProvider, { mode: 'launch', headless: true, executablePath: CHROME })
  const officialStarted = performance.now()
  const officialResult = await officialFlights(official.ctx, official.agent, url)
  const officialMs = performance.now() - officialStarted

  const warmup = await fetch(`${decisionEndpoint}/decide`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      goal: 'Click Search',
      observation: { elements: [{ id: 'e1', role: 'button', name: 'Search', actions: ['click'] }] },
      textStrategy: 'speculative',
    }),
  })
  expect(warmup.ok).toBe(true)

  const d1 = await mount(D1Provider, {
    mode: 'launch', headless: true, executablePath: CHROME,
    decisionEndpoint, decisionToken: token, textStrategy: 'speculative',
  })
  const d1Started = performance.now()
  const result = await execute(d1.ctx, d1.agent, 'd1_browser_subgoal', {
    goal: 'Find one-way flights from Zürich to London on 2026-11-01.',
    url,
    verify: [{ type: 'text_visible', text: 'Zürich to London · 2026-11-01' }],
  }, 'd1-comparison')
  const d1Ms = performance.now() - d1Started
  const d1Result = JSON.parse(text(result)) as Record<string, unknown>
  expect(d1Result.status).toBe('success')

  const skill = await mount(D1Provider, {
    mode: 'launch', headless: true, executablePath: CHROME,
    decisionEndpoint, decisionToken: token, textStrategy: 'speculative',
  })
  const skillStarted = performance.now()
  const skillResultRaw = await execute(skill.ctx, skill.agent, 'd1_browser_subgoal', {
    goal: 'Find one-way flights from Zürich to London on 2026-11-01.',
    url,
    inputs: { From: 'Zürich', To: 'London', 'Departure date': '2026-11-01' },
    verify: [{ type: 'text_visible', text: 'Zürich to London · 2026-11-01' }],
  }, 'skill-comparison')
  const skillMs = performance.now() - skillStarted
  const skillResult = JSON.parse(text(skillResultRaw)) as Record<string, unknown>
  expect(skillResult).toMatchObject({ status: 'success', route: 'skill', decisionRequests: 0 })

  const report = {
    scope: 'Same local flight task; warm decision service; no DeepSeek planner in either arm',
    official: { integration: 'scripted-official-playwright-mcp', elapsedMs: officialMs, ...officialResult },
    d1: { integration: 'd1-enhanced-provider', elapsedMs: d1Ms, result: d1Result },
    verifiedSkill: { integration: 'verified-skill-provider', elapsedMs: skillMs, result: skillResult },
  }
  await writeFile(resolve(ROOT, 'results/dsh-provider-comparison.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
})
