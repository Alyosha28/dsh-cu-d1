import { executeToolFixture } from '@alyosha28/dsh-cu-testkit'
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
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { z } from 'zod'
import * as Provider from '../src/index.ts'
import { NativeCaller, parseAxElements } from '../src/controller.ts'
import { runNativeSkill } from '../src/skill-runner.ts'
import { evidenceFromRun } from '@alyosha28/dsh-cu-core/skill-builder'
import { SkillStore } from '@alyosha28/dsh-cu-core/skill-store'
import { close, HELPER, listen, pathGrant, ROOT } from './fixtures.ts'

const ENABLED = process.env.DSH_CU_REAL_APPS === '1'
const ROUND = Number(process.env.DSH_CU_REAL_APP_ROUND ?? '1')
const RUN_ID = process.env.DSH_CU_REAL_APP_RUN_ID ?? `${ROUND}-${Date.now()}`
const TEXTEDIT = '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit'
const CALCULATOR = '/System/Applications/Calculator.app/Contents/MacOS/Calculator'
const token = `real-app-matrix-token-${ROUND}`

class IndependentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('real-app matrix called the Session model') }
  async resolveModel() {
    return { provider: 'fixture', id: 'structured', name: 'Structured', inputModalities: ['text', 'image'] } as any
  }
}

interface MatrixCase {
  id: string
  application: string
  category: string
  status: 'passed' | 'failed' | 'blocked'
  elapsedMs: number
  detail?: Record<string, unknown>
  error?: string
}

class EnvironmentBlocked extends Error {}
class CaseTimeout extends Error {}

function operationalError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const timeout = message.match(/case_timeout:[a-z0-9_.-]+/u)?.[0]
  if (timeout !== undefined) return timeout
  const codes = [...message.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/gu)].map(match => match[0])
  return codes.at(-1) ?? 'tool_execution_failed'
}

function matchesApplication(app: any, bundleId: string, displayName: string): boolean {
  const aliases = displayName === 'TextEdit' ? ['TextEdit', '文本编辑']
    : displayName === 'Calculator' ? ['Calculator', '计算器'] : [displayName]
  return app.id === bundleId || aliases.includes(app.displayName)
}

function realAppDecisionServer() {
  const calculatorSteps = new Map<string, number>()
  let delayedRequest = 0
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}` || request.method !== 'POST' || request.url !== '/decide') {
      response.writeHead(401).end()
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body) as {
      goal: string
      observation: { elements: Array<{ id: string; role: string; name: string; identifier?: string; value: string | null; actions: string[] }> }
      inputs?: Record<string, string>
    }
    if (payload.goal.startsWith('Delayed TextEdit')) {
      delayedRequest += 1
      server.emit('delayed-request')
      await delay(5000)
    }
    let decision: Record<string, unknown>
    if (payload.goal.startsWith('Calculator')) {
      const steps = [['Seven'], ['Add'], ['Eight'], ['Equals']]
      const step = calculatorSteps.get(payload.goal) ?? 0
      calculatorSteps.set(payload.goal, step + 1)
      const aliases = steps[step]
      const element = aliases === undefined ? undefined : payload.observation.elements.find(candidate =>
        aliases.includes(candidate.name) || (candidate.identifier !== undefined && aliases.includes(candidate.identifier)))
      decision = element === undefined
        ? { operation: 'BLOCKED', target: null, confidence: 0.99 }
        : { operation: 'CLICK', target: element.id, confidence: 0.99 }
    } else {
      const expected = payload.inputs?.['First Text View']
      const document = payload.observation.elements.find(element =>
        /AX(?:TextArea|TextView)/u.test(element.role) && element.actions.includes('type'))
      decision = document !== undefined && expected !== undefined && document.value !== expected
        ? { operation: 'TYPE_TEXT', target: document.id, text: expected, confidence: 0.99 }
        : { operation: 'DONE', target: null, confidence: 0.99 }
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      decision, usage: { input_tokens: 10, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
    }))
  })
  return { server, delayedRequests: () => delayedRequest }
}

function overlapArea(first: any, second: any): number {
  const a = first.bounds
  const b = second.bounds
  if (a === undefined || b === undefined) return 0
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return width * height
}

it.skipIf(!ENABLED)('accepts the real ordinary application scenario matrix', { timeout: 300000 }, async () => {
  if (!Number.isInteger(ROUND) || ROUND < 1) throw new Error('DSH_CU_REAL_APP_ROUND must be a positive integer')
  if (!/^[a-zA-Z0-9._-]+$/u.test(RUN_ID)) throw new Error('DSH_CU_REAL_APP_RUN_ID contains unsupported characters')
  const ctx = new Context()
  const decisions = realAppDecisionServer()
  const decisionUrl = await listen(decisions.server)
  const cases: MatrixCase[] = []
  const processIds: number[] = []
  let launchRecoveries = 0
  let callSequence = 0
  const storePath = join(ROOT, 'results/real-apps', `skills-${RUN_ID}.json`)
  const auditDir = join(ROOT, 'results/real-apps', `audit-${RUN_ID}`)
  const reportPath = join(ROOT, 'results/real-apps', `round-${ROUND}.json`)
  const sensitiveText = `DSH-CU-private-marker-${RUN_ID}`
  const attachmentRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-real-apps-'))
  const config = {
    helperPath: HELPER,
    allowedApps: [pathGrant(TEXTEDIT), pathGrant(CALCULATOR)],
    decisionEndpoint: decisionUrl,
    decisionToken: token,
    skillStorePath: storePath,
    captureSkills: true,
    auditDir,
    auditRetentionDays: 7,
    controlToken: `real-app-control-${ROUND}`,
    operationTimeoutMs: 15000,
  }
  let agent: any
  let cua: any
  let textEdit: any
  let calculator: any

  async function execute(name: string, args: unknown) {
    return executeToolFixture(ctx, {
      agent, name, arguments: args, callId: ToolCallId(`real-app-${ROUND}-${++callSequence}`),
      signal: new AbortController().signal,
    })
  }

  async function subgoal(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await execute('computer_subgoal', args)
    if (result.isError) throw new Error(JSON.stringify(result.content))
    return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
  }

  async function runCase(id: string, application: string, category: string, operation: () => Promise<Record<string, unknown> | void>) {
    const started = Date.now()
    console.error('MATRIX_CASE_START', ROUND, id)
    let timer: NodeJS.Timeout | undefined
    try {
      const detail = await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new CaseTimeout(`case_timeout:${id}`)), 45000)
        }),
      ])
      cases.push({ id, application, category, status: 'passed', elapsedMs: Date.now() - started, ...detail === undefined ? {} : { detail } })
      console.error('MATRIX_CASE_END', ROUND, id, 'passed')
    } catch (error) {
      if (error instanceof EnvironmentBlocked) {
        cases.push({ id, application, category, status: 'blocked', elapsedMs: Date.now() - started, detail: { reason: error.message } })
        console.error('MATRIX_CASE_END', ROUND, id, 'blocked')
        return
      }
      cases.push({
        id, application, category, status: 'failed', elapsedMs: Date.now() - started,
        error: operationalError(error),
      })
      console.error('MATRIX_CASE_END', ROUND, id, 'failed')
      if (error instanceof CaseTimeout) throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async function launchApplication(bundleId: string, displayName: string): Promise<any> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (bundleId === 'com.apple.TextEdit') {
        const isolatedHome = join(attachmentRoot, `textedit-home-${attempt}`)
        await mkdir(isolatedHome, { recursive: true, mode: 0o700 })
        const initialDocument = join(isolatedHome, 'initial.txt')
        await writeFile(initialDocument, '', { mode: 0o600 })
        const launcher = spawn(TEXTEDIT, [
          initialDocument,
          '-NSQuitAlwaysKeepsWindows', 'false',
          '-AppleWindowTabbingMode', 'never',
        ], {
          env: { ...process.env, HOME: isolatedHome },
          stdio: 'ignore',
        })
        if (launcher.pid !== undefined) processIds.push(launcher.pid)
        launcher.unref()
      }
      try {
        const app = await cua.getApp(bundleId)
        app.bundleId = bundleId
        return app
      } catch (error) {
        if (!(error instanceof Error && /AXChildren|APP_UNAVAILABLE/u.test(error.message))) throw error
        launchRecoveries += 1
        const running = await cua.listApps()
        const leftover = running.find((app: any) => matchesApplication(app, bundleId, displayName))
        if (leftover !== undefined && !processIds.includes(leftover.pid)) process.kill(leftover.pid, 'SIGTERM')
        if (attempt === 3) throw error
        await delay(500)
      }
    }
    throw new Error(`Could not launch ${displayName}`)
  }

  async function newTextDocument(app: any = textEdit): Promise<any> {
    let tree = await app.getAXState({ emit: false, includeMenus: true, details: true })
    let elements = parseAxElements(tree, { title: 'TextEdit' })
    const dismissRecovery = elements.find(element => element.role === 'AXButton'
      && /^(?:不重新打开|Don['’]t Reopen(?: Windows)?)$/u.test(element.name))
    if (dismissRecovery !== undefined) {
      await app.click(Number(dismissRecovery.id))
      await delay(350)
      tree = await app.getAXState({ emit: false, includeMenus: true, details: true })
      elements = parseAxElements(tree, { title: 'TextEdit' })
    }
    const before = new Set((await app.getWindows()).map((window: any) => window.windowId))
    const item = elements.find(element => element.role === 'AXMenuItem'
      && /^(?:New|New Document|新建|新建文稿)$/u.test(element.name))
    if (item === undefined) throw new EnvironmentBlocked('textedit_new_document_unavailable')
    await app.click(Number(item.id))
    await delay(250)
    const windows = await app.getWindows()
    const created = windows.find((window: any) => !before.has(window.windowId)) ?? (windows.length === 1 ? windows[0] : undefined)
    if (created === undefined) throw new Error('TextEdit did not create one identifiable new document')
    const window = await app.getWindow(created.windowId)
    if (!created.isOnScreen) await window.show()
    return window
  }

  async function launchTextEditWithoutTabs(): Promise<any> {
    const isolatedHome = join(attachmentRoot, 'textedit-second-home')
    await mkdir(isolatedHome, { recursive: true, mode: 0o700 })
    const initialDocument = join(isolatedHome, 'initial.txt')
    await writeFile(initialDocument, '', { mode: 0o600 })
    const launcher = spawn('open', [
      '--env', `HOME=${isolatedHome}`,
      '-na', 'TextEdit', initialDocument, '--args',
      '-NSQuitAlwaysKeepsWindows', 'false',
      '-AppleWindowTabbingMode', 'never',
    ], { stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => {
      launcher.once('error', reject)
      launcher.once('exit', code => code === 0 ? resolve() : reject(new Error(`open exited ${code}`)))
    })
    let pid: number | undefined
    let running: any[] = []
    for (let attempt = 0; attempt < 30 && pid === undefined; attempt += 1) {
      running = await cua.listApps()
      pid = running.find((app: any) => matchesApplication(app, 'com.apple.TextEdit', 'TextEdit') && app.pid !== textEdit.pid)?.pid
      if (pid === undefined) await delay(100)
    }
    if (pid === undefined) throw new Error('Separate TextEdit instance did not launch')
    processIds.push(pid)
    let app: any
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        app = await cua.getApp(String(pid))
        break
      } catch (error) {
        if (!(error instanceof Error && /AXChildren|APP_UNAVAILABLE/u.test(error.message)) || attempt === 19) throw error
        await delay(100)
      }
    }
    app.bundleId = 'com.apple.TextEdit'
    return app
  }

  async function calculatorWindow(): Promise<any> {
    const windows = await calculator.getWindows()
    const visible = windows.filter((window: any) => window.isOnScreen)
    if (visible.length > 1) throw new Error(`Expected one Calculator window, received ${visible.length}`)
    const selected = visible[0] ?? (windows.length === 1 ? windows[0] : undefined)
    if (selected === undefined) throw new Error('Calculator window is unavailable')
    const window = await calculator.getWindow(selected.windowId)
    if (!selected.isOnScreen) await window.show()
    await delay(50)
    return window
  }

  async function clearCalculator(window: any): Promise<void> {
    const tree = await window.getAXState({ emit: false, details: true })
    const elements = parseAxElements(tree, { title: 'Calculator' })
    const clear = elements.find(element =>
      ['C', 'AC', 'Clear', 'All Clear', '清除', '全部清除'].includes(element.name)
      || (element.identifier !== undefined && ['Clear', 'AllClear'].includes(element.identifier)))
    if (clear !== undefined) await window.click(Number(clear.id))
    await delay(50)
  }

  async function independentlyRerun(candidate: any, app: any, window: any, args: any): Promise<Record<string, unknown>> {
    const caller = new NativeCaller(ctx, agent)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const visible = app === textEdit
        ? (await textEdit.getWindows()).find((item: any) => item.isOnScreen)
        : undefined
      const windowId = visible?.windowId ?? window.windowId
      const selected = (await caller.call('listWindows', { appHandle: app.appHandle }, new AbortController().signal))
        .find((item: any) => item.windowId === windowId)
      const result = await runNativeSkill(
        caller, candidate, { ...args, windowId }, selected,
        { appHandle: app.appHandle, windowId, details: true },
        Provider.Config(config), new AbortController().signal, app.bundleId,
      )
      if (result !== null) return result as unknown as Record<string, unknown>
    }
    throw new Error('Independent Skill rerun fell back to D1 twice before input')
  }

  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SubprocessLocal)
    await ctx.plugin(ComputerUseRegistry)
    await ctx.plugin(AttachmentLocal, { dshHome: attachmentRoot })
    ctx.llm.registerAdapter(['fixture'], new IndependentSessionModel())
    ctx.provide('userQuestions', { async ask(input: any) {
      return { answers: input.questions.map((question: any) => ({ id: question.id, selected: [question.options[0].label] })) }
    } })
    const harness = await mountAgentLoopTestHarness(ctx)
    agent = await harness.create(SessionId(`real-app-matrix-${ROUND}`), { provider: 'fixture', model: 'structured' })
    await ctx.plugin(Provider, config)
    cua = createCuaApi(async operation => {
      const result = await execute('cua', operation)
      if (result.isError) throw new Error(JSON.stringify(result.content))
      return z.json().parse(result.value)
    })
    const running = await cua.listApps()
    for (const definition of [
      { name: 'TextEdit', bundleId: 'com.apple.TextEdit' },
      { name: 'Calculator', bundleId: 'com.apple.calculator' },
    ]) {
      if (running.some((app: any) => matchesApplication(app, definition.bundleId, definition.name))) {
        throw new Error(`Refusing to touch an existing ${definition.name} process`)
      }
    }
    textEdit = await launchApplication('com.apple.TextEdit', 'TextEdit')
    if (!processIds.includes(textEdit.pid)) processIds.push(textEdit.pid)
    calculator = await launchApplication('com.apple.calculator', 'Calculator')
    processIds.push(calculator.pid)
    const store = new SkillStore(storePath)

    let textCandidateId = ''
    await runCase('textedit.dynamic_ax', 'TextEdit', 'dynamic', async () => {
      await newTextDocument()
      const result = await subgoal({
        goal: 'TextEdit: enter the supplied document text.', app: String(textEdit.pid),
        inputs: { 'First Text View': sensitiveText }, verify: [{ type: 'text_visible', text: sensitiveText }],
      })
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'success', route: 'd1', actionsExecuted: 1 })
      const current = (await textEdit.getWindows()).find((item: any) => item.isOnScreen)
      expect(await (await textEdit.getWindow(current.windowId)).getAXState({ emit: false, details: true })).toContain(sensitiveText)
      expect(result.candidateId).toBeTypeOf('string')
      textCandidateId = result.candidateId as string
      return { independentlyReadBack: true, candidateCaptured: true }
    })

    await runCase('textedit.skill_lifecycle', 'TextEdit', 'skill', async () => {
      const candidate = await store.get(textCandidateId)
      if (candidate === undefined) throw new Error('Missing captured TextEdit candidate')
      const rerunWindow = await newTextDocument()
      const args = {
        goal: 'TextEdit: enter the supplied document text.', app: String(textEdit.pid), windowId: rerunWindow.windowId,
        skillId: candidate.id, inputs: { 'First Text View': sensitiveText }, verify: [{ type: 'text_visible', text: sensitiveText }],
      }
      const verification = await independentlyRerun(candidate, textEdit, rerunWindow, args)
      expect(verification, JSON.stringify(verification)).toMatchObject({ status: 'success', modelForwardCalls: 0 })
      await store.recordVerification(candidate.id, evidenceFromRun(String(verification.status), String(verification.reason), Number(verification.modelForwardCalls), true, Number(verification.actionsExecuted)))
      const published = await execute('computer_skill_publish', { skillId: candidate.id })
      expect(published.isError).toBe(false)
      const replayWindow = await newTextDocument()
      const replay = await subgoal({ ...args, app: String(textEdit.pid), windowId: replayWindow.windowId })
      expect(replay).toMatchObject({ status: 'success', route: 'skill', decisionRequests: 0, modelForwardCalls: 0 })
      expect(await replayWindow.getAXState({ emit: false, details: true })).toContain(sensitiveText)
      return { independentRerun: true, approved: true, zeroModelReplay: true }
    })

    await runCase('textedit.multiwindow_guard', 'TextEdit', 'windowing', async () => {
      const separate = await launchTextEditWithoutTabs()
      await separate.activate()
      await delay(100)
      try {
        const document = await newTextDocument(separate)
        await newTextDocument(separate)
        const onscreen = (await separate.getWindows()).filter((item: any) => item.isOnScreen)
        if (onscreen.length < 2) throw new EnvironmentBlocked('textedit_second_document_window_unavailable')
        const result = await subgoal({
          goal: 'TextEdit: no input may be dispatched while the window is ambiguous.', app: String(separate.pid),
          inputs: { 'First Text View': sensitiveText }, verify: [{ type: 'text_visible', text: sensitiveText }],
        })
        expect(result).toMatchObject({ status: 'escalated', reason: 'window_selection_required', decisionRequests: 0, actionsExecuted: 0 })
        expect(await document.getAXState({ emit: false, details: true })).not.toContain(sensitiveText)
        return { onscreenWindows: onscreen.length, inputWithheld: true, processScopedTabbingPreference: 'never' }
      } finally {
        process.kill(separate.pid, 'SIGTERM')
      }
    })

    await runCase('textedit.occluded_window', 'TextEdit', 'occlusion', async () => {
      await newTextDocument()
      await calculatorWindow()
      await calculator.activate()
      await delay(50)
      const foregroundInfo = (await calculator.getWindows()).find((window: any) => window.isOnScreen)
      if (foregroundInfo === undefined) throw new Error('Calculator has no on-screen window for occlusion')
      const backgroundInfo = (await textEdit.getWindows())
        .filter((window: any) => window.isOnScreen && window.bounds.width >= 200 && window.bounds.height >= 200)
        .sort((first: any, second: any) => second.bounds.width * second.bounds.height - first.bounds.width * first.bounds.height)[0]
      if (backgroundInfo === undefined) throw new EnvironmentBlocked('textedit_background_window_unavailable')
      const background = await textEdit.getWindow(backgroundInfo.windowId)
      const overlap = overlapArea(backgroundInfo, foregroundInfo)
      expect(overlap, JSON.stringify({ background: backgroundInfo.bounds, foreground: foregroundInfo.bounds })).toBeGreaterThan(0)
      const backgroundText = `${sensitiveText}-background`
      const result = await subgoal({
        goal: 'TextEdit: enter text into the explicitly selected background document.',
        app: String(textEdit.pid), windowId: background.windowId,
        inputs: { 'First Text View': backgroundText }, verify: [{ type: 'text_visible', text: backgroundText }],
      })
      expect(result).toMatchObject({ status: 'success', actionsExecuted: 1 })
      expect(await background.getAXState({ emit: false, details: true })).toContain(backgroundText)
      return { overlapPointsSquared: overlap, explicitBackgroundWindow: true }
    })

    await runCase('calculator.stale_recovery', 'Calculator', 'stale', async () => {
      const window = await calculatorWindow()
      await clearCalculator(window)
      const caller = new NativeCaller(ctx, agent)
      const params = { appHandle: calculator.appHandle, windowId: window.windowId, details: true }
      const observed = await caller.call('getState', params, new AbortController().signal)
      const seven = parseAxElements(observed.tree, { title: 'Calculator' }).find(element => element.identifier === 'Seven')
      if (seven === undefined) throw new Error('Calculator Seven button is unavailable')
      const input = { appHandle: calculator.appHandle, snapshotId: observed.snapshotId, elementIndex: Number(seven.id) }
      await caller.call('click', input, new AbortController().signal)
      const fresh = await caller.call('getState', params, new AbortController().signal)
      let staleCode = ''
      try {
        await caller.call('click', input, new AbortController().signal)
      } catch (error) {
        staleCode = error instanceof Error && /STALE_SNAPSHOT|WINDOW_CHANGED/u.test(error.message) ? 'stale_rejected' : ''
        if (staleCode === '') throw error
      }
      expect(staleCode).toBe('stale_rejected')
      expect(await window.getAXState({ emit: false, details: true })).toContain('"7"')
      await clearCalculator(window)
      const recovered = await caller.call('getState', params, new AbortController().signal)
      const eight = parseAxElements(recovered.tree, { title: 'Calculator' }).find(element => element.identifier === 'Eight')
      if (eight === undefined) throw new Error('Calculator Eight button is unavailable')
      await caller.call('click', {
        appHandle: calculator.appHandle, snapshotId: recovered.snapshotId, elementIndex: Number(eight.id),
      }, new AbortController().signal)
      const final = await window.getAXState({ emit: false, details: true })
      expect(final).toContain('"8"')
      return { staleInputRejected: true, freshObservationRecovered: true }
    })

    let calculatorCandidateId = ''
    await runCase('calculator.dynamic_ax', 'Calculator', 'dynamic', async () => {
      const window = await calculatorWindow()
      await clearCalculator(window)
      const result = await subgoal({
        goal: 'Calculator: calculate 7 plus 8 and verify 15.', app: String(calculator.pid), windowId: window.windowId,
        verify: [{ type: 'text_visible', text: '15' }],
      })
      expect(result).toMatchObject({ status: 'success', route: 'd1', actionsExecuted: 4 })
      const tree = await window.getAXState({ emit: false, details: true })
      expect(tree).toMatch(/AXStaticText[^\n]*= "[^"]*15[^"]*"/u)
      expect(result.candidateId).toBeTypeOf('string')
      calculatorCandidateId = result.candidateId as string
      return { independentlyReadBack: true, candidateCaptured: true }
    })

    await runCase('calculator.skill_lifecycle', 'Calculator', 'skill', async () => {
      const candidate = await store.get(calculatorCandidateId)
      if (candidate === undefined) throw new Error('Missing captured Calculator candidate')
      const window = await calculatorWindow()
      const args = {
        goal: 'Calculator: calculate 7 plus 8 and verify 15.', app: String(calculator.pid), windowId: window.windowId,
        skillId: candidate.id, verify: [{ type: 'text_visible', text: '15' }],
      }
      await clearCalculator(window)
      const verification = await independentlyRerun(candidate, calculator, window, args)
      expect(verification, JSON.stringify(verification)).toMatchObject({ status: 'success', modelForwardCalls: 0 })
      await store.recordVerification(candidate.id, evidenceFromRun(String(verification.status), String(verification.reason), Number(verification.modelForwardCalls), true, Number(verification.actionsExecuted)))
      const published = await execute('computer_skill_publish', { skillId: candidate.id })
      expect(published.isError).toBe(false)
      await clearCalculator(window)
      const replay = await subgoal(args)
      expect(replay).toMatchObject({ status: 'success', route: 'skill', decisionRequests: 0, modelForwardCalls: 0 })
      expect(await window.getAXState({ emit: false, details: true })).toMatch(/AXStaticText[^\n]*= "[^"]*15[^"]*"/u)
      return { independentRerun: true, approved: true, zeroModelReplay: true }
    })

    await runCase('privacy.persisted_stores', 'Shared', 'privacy', async () => {
      const status = await execute('computer_control', { action: 'status' })
      expect(status.isError).toBe(false)
      const control = JSON.parse((status.content[0] as { text: string }).text) as { controlUrl: string }
      const auditResponse = await fetch(`${control.controlUrl}/api/audit`, { headers: { authorization: `Bearer ${config.controlToken}` } })
      expect(auditResponse.status).toBe(200)
      const audit = await auditResponse.text()
      const skills = await readFile(storePath, 'utf8')
      for (const persisted of [audit, skills]) {
        expect(persisted).not.toContain(sensitiveText)
        expect(persisted).not.toContain(config.decisionToken)
        expect(persisted).not.toContain('screenshot')
      }
      expect((await stat(storePath)).mode & 0o777).toBe(0o600)
      expect((await stat(join(auditDir, 'audit.jsonl'))).mode & 0o777).toBe(0o600)
      expect(audit).toContain('run_finished')
      return { allowlistedAudit: true, redactedSkills: true, privateFileModes: true, retentionDays: 7 }
    })

    await runCase('textedit.stop_active_run', 'TextEdit', 'control', async () => {
      const window = await newTextDocument()
      const delayed = execute('computer_subgoal', {
        goal: 'Delayed TextEdit: wait before entering text.', app: String(textEdit.pid), windowId: window.windowId,
        inputs: { 'First Text View': sensitiveText }, verify: [{ type: 'text_visible', text: sensitiveText }],
      })
      const requested = decisions.delayedRequests() > 0
        ? Promise.resolve('requested')
        : new Promise<string>(resolve => decisions.server.once('delayed-request', () => resolve('requested')))
      const outcome = await Promise.race([requested, delayed.then(() => 'completed')])
      if (outcome === 'completed') throw new Error('Delayed subgoal completed before the stop request')
      const stopped = await execute('computer_control', { action: 'stop' })
      expect(stopped.isError).toBe(false)
      const finished = await delayed
      expect(finished.isError).toBe(false)
      const stoppedResult = JSON.parse((finished.content[0] as { text: string }).text) as Record<string, unknown>
      expect(stoppedResult).toMatchObject({ status: 'stopped', reason: 'stopped_by_user' })
      expect(await window.getAXState({ emit: false, details: true })).not.toContain(sensitiveText)
      const resumed = await execute('computer_control', { action: 'resume' })
      expect(resumed.isError).toBe(false)
      return { activeRunStopped: true, inputWithheld: true }
    })
  } finally {
    await mkdir(join(ROOT, 'results/real-apps'), { recursive: true, mode: 0o700 })
    const summary = {
      round: ROUND,
      runId: RUN_ID,
      decisionSource: 'deterministic decision fixture through the D1 provider contract',
      applications: ['macOS TextEdit', 'macOS Calculator'],
      total: cases.length,
      passed: cases.filter(item => item.status === 'passed').length,
      failed: cases.filter(item => item.status === 'failed').length,
      blocked: cases.filter(item => item.status === 'blocked').length,
      launchRecoveries,
    }
    await writeFile(reportPath, JSON.stringify({ summary, cases }, null, 2) + '\n', { mode: 0o600 })
    for (const pid of processIds.reverse()) {
      try { process.kill(pid, 'SIGTERM') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    await ctx.fiber.dispose()
    await close(decisions.server)
    await rm(attachmentRoot, { recursive: true, force: true })
  }
  expect(cases.filter(item => item.status !== 'passed'), JSON.stringify(cases, null, 2)).toEqual([])
  expect(cases.length).toBe(9)
})
