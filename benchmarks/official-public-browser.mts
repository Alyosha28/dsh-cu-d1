import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
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
import * as PlaywrightMcpProvider from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'

const root = await mkdtemp(join(tmpdir(), 'dsh-official-public-browser-'))
const ctx = new Context()
const evidence: Record<string, any> = { provider: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp', upstream: '@playwright/mcp 0.0.80' }
try {
  const modules = new Map<string, unknown>([
    ['browserUse', BrowserUse], ['prompt', SystemPrompt], ['tools', Tools], ['toolExecutor', NativeToolExecutor], ['llm', Llm],
    ['sessions', Sessions], ['agents', Agents], ['loop', AgentLoop], ['projections', Projections], ['browser', PlaywrightMcpProvider],
    ['fs', LocalFileSystem], ['workingDirectory', WorkingDirectory],
  ])
  const browserConfig = {
    mode: 'launch', headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  }
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
      if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
      return modules.get(specifier)
    },
  } as any
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const owner = await ctx.agents.create({ sessionId: SessionId('official-public-browser'), meta: { cwd: root } })
  await owner.agent.whenIdle()
  const schemas = ctx.tools.schemas(owner.agent)
  const toolNames = schemas.map(tool => tool.name)
  evidence.toolNames = toolNames
  evidence.hasOfficialTabs = toolNames.includes('mcp__playwright-mcp__browser_tabs')
  evidence.hasOfficialUpload = toolNames.includes('mcp__playwright-mcp__browser_file_upload')
  let call = 0
  const execute = async (name: string, args: Record<string, unknown>) => {
    const result = await executeToolFixture(ctx, {
      agent: owner.agent, name: `mcp__playwright-mcp__${name}`, arguments: args,
      callId: ToolCallId(`official-public-${++call}`), signal: AbortSignal.timeout(30000),
    })
    if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`)
    return result
  }
  await execute('browser_navigate', { url: 'https://example.com/' })
  const before = await execute('browser_snapshot', {})
  const beforeText = JSON.stringify(before.content)
  const match = beforeText.match(/link \\"Learn more\\"[^\n]*?\[ref=([^\]]+)\]/u)
    ?? beforeText.match(/link "Learn more"[^\n]*?\[ref=([^\]]+)\]/u)
  if (match === null) throw new Error(`Learn more ref not found in official snapshot: ${beforeText}`)
  await execute('browser_click', { element: 'Learn more link', target: match[1] })
  const after = await execute('browser_snapshot', {})
  const afterText = JSON.stringify(after.content)
  if (!afterText.includes('iana.org')) throw new Error(`Independent official snapshot did not reach IANA: ${afterText}`)
  evidence.navigation = { source: 'https://example.com/', targetText: 'Learn more', independentlyObservedOrigin: 'iana.org' }
  await writeFile(join(process.cwd(), 'results/OFFICIAL_BROWSER_SMOKE.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  console.log('OFFICIAL_BROWSER_EVIDENCE', JSON.stringify(evidence))
  await owner.dispose()
} finally {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
