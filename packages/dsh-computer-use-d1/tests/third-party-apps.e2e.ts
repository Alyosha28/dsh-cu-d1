import { executeToolFixture } from '@albaincompleta/dsh-cu-testkit'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import { createCuaApi } from '@deepseek-ai/dsh-cua/api'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { z } from 'zod'
import * as Provider from '../src/index.ts'
import { close, HELPER, listen, pathGrant, ROOT } from './fixtures.ts'

const ENABLED = process.env.DSH_CU_THIRD_PARTY_APPS === '1'
const ROUND = Number(process.env.DSH_CU_THIRD_PARTY_ROUND ?? '1')
const RUN_ID = process.env.DSH_CU_THIRD_PARTY_RUN_ID ?? `${ROUND}-${Date.now()}`
const LIBREOFFICE = '/Applications/LibreOffice.app/Contents/MacOS/soffice'
const WPS = '/Applications/wpsoffice.app/Contents/MacOS/wpsoffice'
const VSCODE = '/Applications/Visual Studio Code.app/Contents/MacOS/Code'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const token = `third-party-token-${RUN_ID}`

class IndependentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('third-party matrix called the Session model') }
  async resolveModel() {
    return { provider: 'fixture', id: 'structured', name: 'Structured', inputModalities: ['text', 'image'] } as any
  }
}

class EnvironmentBlocked extends Error {}
class CaseTimeout extends Error {}
class OperationalError extends Error {}

function operationalError(error: unknown): string {
  if (error instanceof OperationalError && /^[a-z][a-z0-9_:-]{0,99}$/u.test(error.message)) return error.message
  const message = error instanceof Error ? error.message : String(error)
  const timeout = message.match(/case_timeout:[a-z0-9_.-]+/u)?.[0]
  if (timeout !== undefined) return timeout
  const codes = [...message.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/gu)].map(match => match[0])
  return codes.at(-1) ?? 'tool_execution_failed'
}

function matchesApplication(app: any, bundleId: string, displayName: string): boolean {
  return app.id === bundleId || app.displayName === displayName
}

async function compileSwift(source: string, destination: string): Promise<void> {
  const compile = spawn('swiftc', [join(ROOT, 'fixtures/native', source), '-o', destination], { stdio: 'inherit' })
  await new Promise<void>((resolve, reject) => {
    compile.once('exit', code => code === 0 ? resolve() : reject(new Error(`swiftc exited ${code}`)))
    compile.once('error', reject)
  })
}

async function recognizeText(executable: string, imagePath: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, [imagePath], { encoding: 'utf8', timeout: 10000, signal }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout)
    })
  })
}

async function foregroundControl(executable: string, operation: 'frontmost' | 'activate', pid?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, [operation, ...pid === undefined ? [] : [String(pid)]], { encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout.trim())
    })
  })
}

interface CaseResult {
  id: string
  application: string
  status: 'passed' | 'failed' | 'blocked'
  elapsedMs: number
  detail?: Record<string, unknown>
  error?: string
}

function decisionServer() {
  return createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}` || request.method !== 'POST' || request.url !== '/decide') {
      response.writeHead(401).end()
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body) as {
      goal: string
      inputs?: Record<string, string>
      observation: { elements: Array<{ id: string; role: string; name: string; value: string | null; actions: string[] }> }
      screenshot?: { data: string; mimeType: string }
    }
    const expected = payload.inputs?.Body
    const textOperation = /^(?:Visual Studio Code|Google Chrome)/u.test(payload.goal) ? 'TYPE_TEXT' : 'PASTE_TEXT'
    const document = payload.observation.elements.find(element =>
      /TextArea|TextView|Document/iu.test(element.role) && element.actions.includes(textOperation === 'TYPE_TEXT' ? 'type' : 'paste'))
    const decision = document !== undefined && expected !== undefined && document.value !== expected
      ? { operation: textOperation, target: document.id, text: expected, confidence: 0.99 }
      : payload.screenshot !== undefined && expected !== undefined
        ? {
            operation: textOperation, target: null, text: expected, confidence: 0.99,
            box: { left: 0.15, top: 0.35, right: 0.85, bottom: 0.75 }, found: 1,
          }
        : { operation: 'DONE', target: null, confidence: 0.99 }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      decision, usage: { input_tokens: 10, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
    }))
  })
}

it.skipIf(!ENABLED)('accepts third-party downloaded applications', { timeout: 240000 }, async () => {
  if (!Number.isInteger(ROUND) || ROUND < 1 || !/^[a-zA-Z0-9._-]+$/u.test(RUN_ID)) {
    throw new Error('Invalid third-party round or run ID')
  }
  const ctx = new Context()
  const decisions = decisionServer()
  const decisionUrl = await listen(decisions)
  const cases: CaseResult[] = []
  const processIds: number[] = []
  const marker = `DSH-CU-third-party-private-${RUN_ID}`
  const auditDir = join(ROOT, 'results/third-party', `audit-${RUN_ID}`)
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-third-party-'))
  const ocrPath = join(tempRoot, 'RecognizeText')
  const screenshotPath = join(tempRoot, 'window-image')
  const wpsDocumentPath = join(tempRoot, 'blank.docx')
  const wpsHome = join(tempRoot, 'wps-home')
  const vscodeDocumentPath = join(tempRoot, 'editor.txt')
  const chromeDocumentPath = join(tempRoot, 'editor.html')
  const foregroundPath = join(tempRoot, 'ForegroundControl')
  const anchorPath = join(tempRoot, 'ForegroundAnchor')
  let anchor: any
  let callSequence = 0
  let agent: any
  let cua: any
  // Injected at construction time: there is no process-global handler map.
  const verificationHandlers = {
    acceptance_screenshot_text: async (args: Record<string, unknown>, context: {
      caller?: { call(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> }
      params: Readonly<Record<string, unknown>>
      signal: AbortSignal
    }) => {
      const expected = typeof args.text === 'string' ? args.text : ''
      if (expected === '') return false
      const { caller, params, signal } = context
      if (caller === undefined) return false
      const screenshot = await caller.call('screenshot', {
        appHandle: params.appHandle, windowId: params.windowId,
      }, signal) as { data: string }
      await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'), { mode: 0o600 })
      return (await recognizeText(ocrPath, screenshotPath, signal)).includes(expected)
    },
  }
  const config = {
    helperPath: HELPER,
    verificationHandlers,
    allowedApps: [pathGrant(LIBREOFFICE), pathGrant(WPS), pathGrant(VSCODE), pathGrant(CHROME)],
    decisionEndpoint: decisionUrl,
    decisionToken: token,
    auditDir,
    auditRetentionDays: 7,
    controlToken: `third-party-control-${RUN_ID}`,
    operationTimeoutMs: 15000,
  }

  async function execute(name: string, args: unknown) {
    return executeToolFixture(ctx, {
      agent, name, arguments: args, callId: ToolCallId(`third-party-${ROUND}-${++callSequence}`),
      signal: new AbortController().signal,
    })
  }

  async function screenshotTextFromWindow(window: any): Promise<string> {
    const screenshot = await window.getScreenshot({ emit: false })
    await writeFile(screenshotPath, Buffer.from(screenshot.bytes), { mode: 0o600 })
    return recognizeText(ocrPath, screenshotPath)
  }

  async function activateAnchor(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      anchor.kill('SIGUSR2')
      await delay(100)
      if (await foregroundControl(foregroundPath, 'frontmost') === String(anchor.pid)) return
    }
    throw new Error('Controlled foreground anchor did not become frontmost')
  }

  function monitorForeground(): () => Promise<number[]> {
    const monitor = spawn(foregroundPath, ['monitor'], { stdio: ['ignore', 'pipe', 'inherit'] })
    let output = ''
    monitor.stdout.on('data', chunk => { output += chunk.toString() })
    return async () => {
      await new Promise<void>(resolve => {
        monitor.once('exit', () => resolve())
        monitor.kill('SIGTERM')
      })
      const samples = output.trim().split(/\s+/u).filter(Boolean).map(Number)
      expect(samples.length).toBeGreaterThan(0)
      return samples
    }
  }

  async function launch(definition: any): Promise<any> {
    async function attach(pid: number): Promise<any> {
      let app: any
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          app = await cua.getApp(String(pid))
          break
        } catch (error) {
          if (!(error instanceof Error && /AXChildren|APP_UNAVAILABLE|NATIVE_ERROR/u.test(error.message)) || attempt === 29) throw error
          await delay(100)
        }
      }
      app.bundleId = definition.bundle
      return app
    }
    if (definition.openWithLaunchServices) {
      const launcher = spawn('open', ['-na', definition.name, ...definition.args], { stdio: 'ignore', env: { ...process.env, HOME: wpsHome } })
      await new Promise<void>((resolve, reject) => {
        launcher.once('exit', code => code === 0 ? resolve() : reject(new Error(`open exited ${code}`)))
        launcher.once('error', reject)
      })
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const running = await cua.listApps()
        const pid = running.find((app: any) => matchesApplication(app, definition.bundle, definition.name))?.pid
        if (pid !== undefined) return attach(pid)
        await delay(100)
      }
      throw new Error(`${definition.name} did not launch through LaunchServices`)
    }
    const child = spawn(definition.executable, definition.args, {
      stdio: 'ignore',
      env: definition.bundle.includes('kingsoft') ? { ...process.env, HOME: wpsHome } : process.env,
    })
    return attach(child.pid)
  }

  async function existingDocumentWindow(app: any, definition: any): Promise<any> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const windows = (await app.getWindows()).filter((window: any) => window.isOnScreen)
        .sort((first: any, second: any) => second.bounds.width * second.bounds.height - first.bounds.width * first.bounds.height)
      const suitable = definition.bundle.includes('kingsoft')
        ? windows.filter((window: any) => window.title && !/^(?:首页|新建文档|Home)$/u.test(window.title))
        : windows
      if (suitable.length > 0) return app.getWindow(suitable[0].windowId)
      await delay(100)
    }
    throw new EnvironmentBlocked('writer_document_window_unavailable')
  }

  async function runCase(id: string, application: string, operation: () => Promise<Record<string, unknown> | void>) {
    const started = Date.now()
    console.error('THIRD_PARTY_CASE_START', ROUND, id)
    let timer: NodeJS.Timeout | undefined
    try {
      const detail = await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new CaseTimeout(`case_timeout:${id}`)), 45000)
        }),
      ])
      cases.push({ id, application, status: 'passed', elapsedMs: Date.now() - started, ...detail === undefined ? {} : { detail } })
    } catch (error) {
      if (error instanceof EnvironmentBlocked) {
        cases.push({ id, application, status: 'blocked', elapsedMs: Date.now() - started, detail: { reason: error.message } })
        return
      }
      cases.push({
        id, application, status: 'failed', elapsedMs: Date.now() - started,
        error: operationalError(error),
      })
      if (error instanceof CaseTimeout) throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      console.error('THIRD_PARTY_CASE_END', ROUND, id, cases.at(-1)?.status)
    }
  }

  try {
    await mkdir(wpsHome, { recursive: true, mode: 0o700 })
    const blankTextPath = join(tempRoot, 'blank.txt')
    await writeFile(blankTextPath, '', { mode: 0o600 })
    await new Promise<void>((resolve, reject) => {
      execFile('/usr/bin/textutil', ['-convert', 'docx', blankTextPath, '-output', wpsDocumentPath], error => {
        if (error !== null) reject(error)
        else resolve()
      })
    })
    await writeFile(vscodeDocumentPath, '', { mode: 0o600 })
    await writeFile(chromeDocumentPath, '<!doctype html><meta charset="utf-8"><title>DSH Editor</title><label for="body">Body</label><textarea id="body" placeholder="Body" autofocus style="width:800px;height:400px;font-size:20px"></textarea>', { mode: 0o600 })
    await compileSwift('RecognizeText.swift', ocrPath)
    await compileSwift('ForegroundControl.swift', foregroundPath)
    await compileSwift('WorkflowFixture.swift', anchorPath)
    anchor = spawn(anchorPath, [join(tempRoot, 'anchor-state.json')], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise<void>((resolve, reject) => {
      anchor.stdout.once('data', () => resolve())
      anchor.once('error', reject)
      anchor.once('exit', (code: number) => reject(new Error(`Foreground anchor exited ${code}`)))
    })
    processIds.push(anchor.pid)
      await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SubprocessLocal)
    await ctx.plugin(ComputerUseRegistry)
    await ctx.plugin(AttachmentLocal, { dshHome: tempRoot })
    ctx.llm.registerAdapter(['fixture'], new IndependentSessionModel())
    ctx.provide('userQuestions', { async ask(input: any) {
      return { answers: input.questions.map((question: any) => ({ id: question.id, selected: [question.options[0].label] })) }
    } })
    const harness = await mountAgentLoopTestHarness(ctx)
    agent = await harness.create(SessionId(`third-party-${RUN_ID}`), { provider: 'fixture', model: 'structured' })
    await ctx.plugin(Provider, config)
    cua = createCuaApi(async operation => {
      const result = await execute('cua', operation)
      if (result.isError) throw new Error(JSON.stringify(result.content))
      return z.json().parse(result.value)
    })
    const definitions = [
      {
        id: 'libreoffice.writer_ax', name: 'LibreOffice', bundle: 'org.libreoffice.script', readback: 'ax', allowExisting: false,
        executable: LIBREOFFICE,
        args: ['--writer', '--norestore', `-env:UserInstallation=${pathToFileURL(join(tempRoot, 'libreoffice-profile')).href}`],
      },
      {
        id: 'wps.writer_visual', name: 'wpsoffice', bundle: 'com.kingsoft.wpsoffice.mac.global', readback: 'screenshot', allowExisting: false,
        executable: WPS, openWithLaunchServices: true, args: [wpsDocumentPath], launchSettleMs: 2000,
      },
      {
        id: 'vscode.editor_visual', name: 'Visual Studio Code', bundle: 'com.microsoft.VSCode', readback: 'screenshot', allowExisting: true,
        executable: VSCODE, launchSettleMs: 1500,
        args: [
          '--new-window', '--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${join(tempRoot, 'vscode-profile')}`,
          `--extensions-dir=${join(tempRoot, 'vscode-extensions')}`, vscodeDocumentPath,
        ],
      },
      {
        id: 'chrome.editor_ax', name: 'Google Chrome', bundle: 'com.google.Chrome', readback: 'ax', allowExisting: true,
        executable: CHROME, launchSettleMs: 5000,
        args: [
          '--new-window', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
          '--disable-background-networking', '--disable-sync', `--user-data-dir=${join(tempRoot, 'chrome-profile')}`,
          pathToFileURL(chromeDocumentPath).href,
        ],
      },
    ]
    const running = await cua.listApps()
    for (const definition of definitions) {
      if (definition.allowExisting !== true && running.some((app: any) => matchesApplication(app, definition.bundle, definition.name))) {
        throw new Error(`Refusing to touch an existing ${definition.name} process`)
      }
    }

    for (const definition of definitions) {
      let app: any
      await runCase(definition.id, definition.name, async () => {
        app = await launch(definition)
        processIds.push(app.pid)
        await delay(definition.launchSettleMs ?? 100)
        const window = await existingDocumentWindow(app, definition)
        await activateAnchor()
        const stopMonitoring = monitorForeground()
        try {
          if (definition.bundle === 'com.microsoft.VSCode') {
            const firstRunText = await screenshotTextFromWindow(window)
            if (firstRunText.includes('Continue without Signing In')) {
              await window.getScreenshot({ emit: false })
              await window.click([795, 815], { relative: true })
              await delay(500)
              if ((await screenshotTextFromWindow(window)).includes('Continue without Signing In')) {
                throw new Error('VSCode first-run dialog remained after one input')
              }
            }
            const onboardingText = await screenshotTextFromWindow(window)
            if (onboardingText.includes('Make It Yours') && onboardingText.includes('Get Started')) {
              await window.getScreenshot({ emit: false })
              await window.click([835, 815], { relative: true })
              await delay(500)
              if ((await screenshotTextFromWindow(window)).includes('Make It Yours')) {
                throw new Error('VSCode onboarding remained after one input')
              }
            }
          }
          const result = await execute('computer_subgoal', {
            goal: `${definition.name}: enter the supplied body text.`, app: String(app.pid), windowId: window.windowId,
            inputs: { Body: marker },
            verify: [definition.readback === 'screenshot'
              ? { type: 'custom', name: 'acceptance_screenshot_text', args: { text: marker } }
              : { type: 'text_visible', text: marker }],
          })
          if (result.isError) throw new Error(JSON.stringify(result.content))
          const value = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
          if (value.status !== 'success') throw new OperationalError(String(value.reason))
          expect(value, JSON.stringify(value)).toMatchObject({ status: 'success', route: 'd1', actionsExecuted: 1 })
          if (definition.readback === 'screenshot') {
            expect(await screenshotTextFromWindow(window)).toContain(marker)
          } else {
            expect(await window.getAXState({ emit: false, details: true })).toContain(marker)
          }
          return {
            independentlyReadBack: true, readback: definition.readback,
            explicitActivationCalls: 0,
            showCalls: 0, foregroundPreserved: true,
          }
        } finally {
          const foregroundSamples = await stopMonitoring()
          expect(foregroundSamples.every(pid => pid === anchor.pid)).toBe(true)
        }
      })
    }

    await runCase('privacy.persisted_stores', 'Shared', async () => {
      const status = await execute('computer_control', { action: 'status' })
      expect(status.isError).toBe(false)
      const control = JSON.parse((status.content[0] as { text: string }).text) as { controlUrl: string }
      const response = await fetch(`${control.controlUrl}/api/audit`, { headers: { authorization: `Bearer ${config.controlToken}` } })
      const audit = await response.text()
      expect(audit).not.toContain(marker)
      expect(audit).not.toContain(token)
      expect(audit).not.toContain('screenshot')
      return { allowlistedAudit: true, retentionDays: 7 }
    })
  } finally {
    await mkdir(join(ROOT, 'results/third-party'), { recursive: true, mode: 0o700 })
    const summary = {
      round: ROUND, runId: RUN_ID,
      decisionSource: 'deterministic decision fixture through the D1 provider contract',
      total: cases.length,
      passed: cases.filter(item => item.status === 'passed').length,
      failed: cases.filter(item => item.status === 'failed').length,
      blocked: cases.filter(item => item.status === 'blocked').length,
    }
    await writeFile(join(ROOT, 'results/third-party', `round-${ROUND}.json`), JSON.stringify({ summary, cases }, null, 2) + '\n', { mode: 0o600 })
    for (const pid of processIds.reverse()) {
      try { process.kill(pid, 'SIGTERM') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    await delay(250)
    await ctx.fiber.dispose()
    await close(decisions)
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
  expect(cases.filter(item => item.status !== 'passed'), JSON.stringify(cases, null, 2)).toEqual([])
  expect(cases).toHaveLength(5)
})
