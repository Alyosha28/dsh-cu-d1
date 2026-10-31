/**
 * DSH plugin acceptance: loads the built D1 Browser Use provider through the
 * cordis loader (the same mechanism a DSH profile uses), mounts the real DSH
 * services it declares, and executes tools against a loopback fixture.
 *
 * This is the plugin-level check that unit tests do not cover: the packaged
 * entry (dist), the config schema, the `inject` contract, tool registration,
 * and a real headless Chromium page. No window is created and no user
 * application or existing browser is touched.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Llm, { ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Projections from '@deepseek-ai/dsh-session-projection'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { executeToolFixture } from '@albaincompleta/dsh-cu-testkit'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { close, fixtureServer, listen } from '../packages/dsh-browser-use-d1/tests/fixtures.ts'

const ROOT = resolve(import.meta.dirname, '..')
const ENTRY = join(ROOT, 'packages/dsh-browser-use-d1/dist/index.js')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

interface Check {
  name: string
  ok: boolean
  detail: string
}

const checks: Check[] = []
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}\n`)
}

async function main(): Promise<void> {
  const fixtures = fixtureServer()
  const fixtureUrl = await listen(fixtures)
  const root = await mkdtemp(join(tmpdir(), 'dsh-cu-plugin-'))
  const ctx = new Context()
  const cleanup = async (): Promise<void> => {
    await ctx.fiber.dispose().catch(() => undefined)
    await close(fixtures).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }

  try {
    const modules = new Map<string, unknown>([
      ['browserUse', BrowserUse], ['prompt', SystemPrompt], ['tools', Tools],
      ['llm', Llm], ['sessions', Sessions],
      ['agents', Agents], ['loop', AgentLoop], ['projections', Projections],
      ['fs', LocalFileSystem], ['workingDirectory', WorkingDirectory],
    ])
    const configPath = join(root, 'cordis.yml')
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier === 'browser') return await import(pathToFileURL(ENTRY).href) as unknown as Plugin.Object<any>
        if (!modules.has(specifier)) throw new Error(`Unexpected plugin module ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>

    const providerConfig = {
      mode: 'launch',
      executablePath: CHROME,
      headless: true,
      decisionEndpoint: 'http://127.0.0.1:9',
      decisionToken: 'plugin-test-token',
      controlToken: 'plugin-test-control',
      locale: 'zh',
      auditDir: join(root, 'audit'),
    }
    // A profile entry carries the config; here the loader entry is created with
    // the real provider config, as a profile's cordis.patch.yml would.
    await writeFile(configPath, JSON.stringify([
      ...[...modules.keys()].map(name => ({
        id: name,
        name,
        config: name === 'loop' ? { agents: [] } : {},
      })),
      { id: 'browser', name: 'browser', config: providerConfig },
    ]))
    process.stdout.write('step: loader create\n')
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    process.stdout.write('step: loader ready\n')

    check('plugin entry imports', true, ENTRY)
    check('browser-use provider registered', ctx.browserUse.providerName === 'd1-system-one', String(ctx.browserUse.providerName))
    const names = ctx.tools.schemas().map(tool => tool.name)
    const expected = ['d1_browser_subgoal', 'browser_observe', 'browser_extract', 'browser_navigate', 'browser_tabs', 'browser_upload', 'browser_downloads', 'browser_control', 'browser_skill_publish']
    check('tools registered', expected.every(name => names.includes(name)), names.join(', '))

    process.stdout.write('step: create agent\n')
    const owner = await ctx.agents.create({ sessionId: SessionId(`plugin-${Math.random()}`), meta: { cwd: root } })
    await owner.agent.whenIdle()

    const execute = async (name: string, args: unknown) => executeToolFixture(ctx, {
      agent: owner.agent,
      name,
      arguments: args,
      callId: ToolCallId(`plugin-${name}`),
      signal: new AbortController().signal,
    })
    const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
      result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')

    process.stdout.write('step: extract\n')
    const extract = await execute('browser_extract', {
      url: `${fixtureUrl}/flights.html`,
      fields: [
        { name: 'heading', locator: { kind: 'role', role: 'heading', name: 'Book a flight' } },
        { name: 'search', locator: { kind: 'role', role: 'button', name: 'Search flights' } },
        { name: 'from', locator: { kind: 'label', text: 'From' } },
      ],
    })
    const extractPayload = JSON.parse(text(extract)) as {
      status?: string
      reason?: string
      data?: Record<string, unknown>
      empty?: string[]
      evidence?: { trusted?: boolean }
    }
    check(
      'browser_extract reads a real page',
      extract.isError === false && extractPayload.status === 'success'
        && extractPayload.evidence?.trusted === false
        && extractPayload.data?.heading === 'Book a flight'
        && extractPayload.data?.search === 'Search flights',
      JSON.stringify({ data: extractPayload.data, empty: extractPayload.empty, reason: extractPayload.reason }),
    )
    check(
      'blank field reported as empty, not missing',
      extractPayload.empty?.includes('from') === true && extractPayload.data?.from === '',
      JSON.stringify({ from: extractPayload.data?.from, empty: extractPayload.empty }),
    )

    const observe = await execute('browser_observe', {})
    const observePayload = JSON.parse(text(observe)) as {
      status?: string
      trusted?: boolean
      observation?: { elements?: unknown[]; url?: string }
    }
    check(
      'browser_observe reads the owned page',
      observe.isError === false && observePayload.status === 'success'
        && observePayload.trusted === false
        && (observePayload.observation?.elements?.length ?? 0) > 0,
      `${observePayload.observation?.elements?.length ?? 0} elements at ${observePayload.observation?.url ?? '?'}`,
    )

    const control = await execute('browser_control', { action: 'status' })
    const controlPayload = JSON.parse(text(control)) as { controlUrl?: string }
    check(
      'browser_control returns a page token URL',
      control.isError === false && /#token=/.test(controlPayload.controlUrl ?? ''),
      controlPayload.controlUrl?.replace(/#.*/u, '#token=<page-token>') ?? 'missing',
    )

    const { Config, validateConfig } = await import(pathToFileURL(join(ROOT, 'packages/dsh-browser-use-d1/dist/config.js')).href) as {
      Config: (input: Record<string, unknown>) => Record<string, unknown>
      validateConfig: (config: Record<string, unknown>) => void
    }
    let rejected = false
    try {
      validateConfig(Config({ ...providerConfig, captureSkills: true }))
    } catch {
      rejected = true
    }
    check('invalid config fails closed', rejected, 'captureSkills without skillStorePath')

    const failed = checks.filter(entry => !entry.ok)
    const report = { generatedAt: new Date().toISOString(), entry: ENTRY, checks }
    await writeFile(join(ROOT, 'results', 'PLUGIN_DSH_TEST.json'), `${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(`\n${checks.length - failed.length}/${checks.length} plugin checks passed\n`)
    if (failed.length > 0) process.exitCode = 1
  } finally {
    // The loader may leave a browser or a keep-alive socket referenced; the
    // checks are already decided, so the process exits instead of hanging.
    await Promise.race([cleanup(), new Promise(resolve => setTimeout(resolve, 5000))])
  }
}

await main()
process.exit(process.exitCode ?? 0)
