import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, copyFile, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { arch, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { readPermissionSelfCheck } from '../src/permissions.ts'

const run = promisify(execFile)

export const ROOT = resolve(import.meta.dirname, '../../..')
export const REPORT_PATH = join(tmpdir(), 'dsh-cu-test-report.csv')

const PACKAGE_ROOT = resolve(import.meta.dirname, '..')
const CACHE_ROOT = join(PACKAGE_ROOT, '.cache', 'native')
const CUA_PACKAGE_ROOT = join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-experimental-cua-macos')
const NATIVE_PACKAGE = join(CUA_PACKAGE_ROOT, 'native')
const ARCH = arch()
const HELPER_NAME = 'dsh-cua-native'

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function describePath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return `${path} (missing)`
  }
}

/** Serialises concurrent first-time builds across vitest worker processes. */
async function withBuildLock<T>(body: () => Promise<T>): Promise<T> {
  const lock = join(CACHE_ROOT, 'build.lock')
  await mkdir(CACHE_ROOT, { recursive: true })
  const deadline = Date.now() + 600_000
  for (;;) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
      if (Date.now() > deadline) throw new Error(`native_helper_build_lock_timeout: ${lock}`)
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
    }
  }
  try {
    return await body()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

interface HelperResolution {
  available: boolean
  path?: string
  source: 'env' | 'cache' | 'shipped' | 'build' | 'unavailable'
  diagnostics: string
}

/**
 * Locates the native CUA helper.
 *
 * Order: `DSH_CUA_HELPER` (authoritative when set) > the package cache > the
 * payload shipped inside the CUA package > a local `swift build` into
 * `packages/dsh-computer-use-d1/.cache/native/`. Nothing is downloaded and no
 * test silently passes without a helper: when every candidate is missing the
 * suite is skipped and the diagnostics below are printed.
 */
async function resolveHelper(): Promise<HelperResolution> {
  const tried: string[] = []
  const env = process.env.DSH_CUA_HELPER
  if (env !== undefined && env !== '') {
    const path = resolve(env)
    if (!await executable(path)) {
      return {
        available: false, source: 'unavailable',
        diagnostics: `native_helper_unavailable: DSH_CUA_HELPER is set but is not an executable file: ${await describePath(path)}`,
      }
    }
    return { available: true, path, source: 'env', diagnostics: 'native_helper_available: DSH_CUA_HELPER' }
  }
  tried.push(`DSH_CUA_HELPER: unset`)

  const cached = join(CACHE_ROOT, `darwin-${ARCH}`, HELPER_NAME)
  if (await executable(cached)) {
    return { available: true, path: cached, source: 'cache', diagnostics: `native_helper_available: ${cached}` }
  }
  tried.push(`cache: ${await describePath(cached)}`)

  const shipped = join(NATIVE_PACKAGE, 'bin', `darwin-${ARCH}`, HELPER_NAME)
  if (await executable(shipped)) {
    return { available: true, path: shipped, source: 'shipped', diagnostics: `native_helper_available: ${shipped}` }
  }
  tried.push(`shipped: ${await describePath(shipped)}`)

  const build = async (): Promise<HelperResolution> => {
    if (await executable(cached)) {
      return { available: true, path: cached, source: 'cache', diagnostics: `native_helper_available: ${cached}` }
    }
    const scratch = join(CACHE_ROOT, `build-${ARCH}`)
    try {
      await run('xcrun', [
        'swift', 'build',
        '--package-path', NATIVE_PACKAGE,
        '--scratch-path', scratch,
        '--configuration', 'release',
        '--product', HELPER_NAME,
        '--arch', ARCH === 'x64' ? 'x86_64' : 'arm64',
      ], { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 })
      await mkdir(dirname(cached), { recursive: true })
      await copyFile(join(scratch, 'release', HELPER_NAME), cached)
      await chmod(cached, 0o755)
      return { available: true, path: cached, source: 'build', diagnostics: `native_helper_available: built ${cached}` }
    } catch (error) {
      const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
      tried.push(`build: xcrun swift build failed (${detail})`)
      return { available: false, source: 'unavailable', diagnostics: await helperDiagnostics(tried) }
    }
  }
  return withBuildLock(build)
}

async function helperDiagnostics(tried: string[]): Promise<string> {
  const lines = ['native_helper_unavailable', 'tried:']
  for (const entry of tried) lines.push(`  - ${entry}`)
  const swift = await run('xcrun', ['--find', 'swift'], { timeout: 5000 })
    .then(result => result.stdout.trim()).catch(error => `unavailable (${String(error).split('\n')[0]})`)
  lines.push(`  - swift: ${swift || 'not found'}`)
  const selfCheck = await readPermissionSelfCheck()
  lines.push(`  - AXIsProcessTrusted (temporary probe identity): ${selfCheck === undefined ? 'probe unavailable' : String(selfCheck.accessibility)}`)
  lines.push(`  - CGPreflightScreenCaptureAccess (temporary probe identity): ${selfCheck === undefined ? 'probe unavailable' : String(selfCheck.screenRecording)}`)
  lines.push(`  - session: ${await sessionDictionary()}`)
  lines.push('recovery: set DSH_CUA_HELPER to an executable dsh-cua-native, or build it with '
    + '"xcrun swift build -c release --package-path node_modules/@deepseek-ai/dsh-experimental-cua-macos/native --product dsh-cua-native"')
  return lines.join('\n')
}

async function sessionDictionary(): Promise<string> {
  try {
    const { stdout } = await run('ioreg', ['-n', 'Root', '-d1'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
    const keys = stdout.split('\n')
      .filter(line => /CGSSession|ScreenIsLocked|IOConsoleUsers|kCGSSessionOnConsoleKey/u.test(line))
      .map(line => line.trim())
      .slice(0, 6)
    return keys.length > 0 ? keys.join(' | ') : 'no CGSSession keys reported by ioreg'
  } catch (error) {
    return `ioreg unavailable (${String(error).split('\n')[0]})`
  }
}

const helper = await resolveHelper()

if (!helper.available) {
  // Printed once per test file so a skip is never silent.
  console.warn(`[native-tests] ${helper.diagnostics}`)
}

/** Absolute path of the helper, or undefined when the environment has none. */
export const HELPER = helper.path
/** True when native-input tests can run on this machine. */
export const NATIVE_HELPER_AVAILABLE = helper.available
/** Human-readable reason; empty when the helper is available. */
export const NATIVE_HELPER_DIAGNOSTICS = helper.diagnostics
export const NATIVE_HELPER_SOURCE = helper.source

let activator: Promise<string> | undefined

const ACTIVATOR_SOURCE = `import AppKit
let pid = Int32(CommandLine.arguments[1]) ?? -1
guard let app = NSRunningApplication(processIdentifier: pid) else { print("not-found"); exit(2) }
if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { print("already-frontmost"); exit(0) }
_ = app.activate(options: [.activateAllWindows])
usleep(300_000)
let front = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
print(front ? "activated" : "refused")
`

async function activatorBinary(): Promise<string> {
  activator ??= (async () => {
    const binary = join(CACHE_ROOT, `darwin-${ARCH}`, 'activate-app')
    if (await executable(binary)) return binary
    const source = join(CACHE_ROOT, 'ActivateApp.swift')
    await mkdir(dirname(source), { recursive: true })
    await writeFile(source, ACTIVATOR_SOURCE)
    await run('swiftc', [source, '-o', binary], { timeout: 120_000 })
    await chmod(binary, 0o755)
    return binary
  })()
  return activator
}

/**
 * Brings a fixture application to the front.
 *
 * Pointer input (CGEvent) and typed text go to the frontmost application, while
 * AX actions reach their element regardless of focus. A headless test process
 * cannot assume the fixture ended up frontmost, so tests that exercise the
 * screenshot/visual path activate it explicitly first.
 */
export async function activateApp(pid: number | undefined): Promise<{ frontmost: boolean; detail: string }> {
  if (pid === undefined) return { frontmost: false, detail: 'no pid' }
  try {
    const { stdout } = await run(await activatorBinary(), [String(pid)], { timeout: 10_000 })
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
    const detail = stdout.trim()
    return { frontmost: detail === 'activated' || detail === 'already-frontmost', detail }
  } catch (error) {
    return { frontmost: false, detail: error instanceof Error ? error.message.split('\n')[0]! : String(error) }
  }
}

export interface HelperSession {
  request(method: string, params: Record<string, unknown>): Promise<any>
  close(): Promise<void>
}

/** Speaks the helper's line-delimited JSON protocol for test probes. */
export async function openHelperSession(): Promise<HelperSession> {
  if (HELPER === undefined) throw new Error('native_helper_unavailable')
  const { spawn } = await import('node:child_process')
  const { createInterface } = await import('node:readline')
  const child = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'ignore'] })
  const lines = createInterface({ input: child.stdout! })
  const pending = new Map<string, (value: any) => void>()
  let counter = 0
  lines.on('line', line => {
    try {
      const message = JSON.parse(line) as { id?: string }
      if (message.id === undefined) return
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    } catch { /* ignore non-JSON debug lines */ }
  })
  return {
    request(method, params) {
      const id = String(++counter)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`helper_${method}_timeout`)) }, 10_000)
        pending.set(id, message => { clearTimeout(timer); resolve(message) })
        child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`)
      })
    },
    async close() {
      child.stdin?.end()
      await new Promise<void>(resolve => { child.once('exit', () => resolve()); setTimeout(resolve, 2000) })
      child.kill('SIGTERM')
    },
  }
}

/**
 * Probes whether this machine can actually deliver pointer input to a fixture.
 *
 * The visual path posts CGEvents, which only reach an application that is
 * frontmost and on screen. A headless CI session can have a working helper,
 * working AX, and still drop every click, so the capability is measured instead
 * of assumed: one click at the fixture's own reported button point, then a
 * reset. Tests that need pointer input skip (with this detail) when it fails.
 */
export async function probePointerInput(options: {
  pid: number
  windowId: number
  point: [number, number]
  statePath: string
}): Promise<{ ok: boolean; detail: string }> {
  let session: HelperSession | undefined
  try {
    session = await openHelperSession()
    const app = await session.request('getApp', { selector: String(options.pid) })
    const handle = app?.result?.appHandle
    if (typeof handle !== 'string') return { ok: false, detail: `pointer_probe_get_app_failed: ${JSON.stringify(app).slice(0, 200)}` }
    const shot = await session.request('screenshot', { appHandle: handle, windowId: options.windowId })
    if (shot?.error !== undefined) return { ok: false, detail: `pointer_probe_screenshot_failed: ${shot.error.code}` }
    const click = await session.request('click', {
      appHandle: handle, windowId: options.windowId, x: options.point[0], y: options.point[1],
    })
    if (click?.error !== undefined) return { ok: false, detail: `pointer_probe_click_failed: ${click.error.code}` }
    await new Promise(resolveWait => setTimeout(resolveWait, 400))
    const { readFile } = await import('node:fs/promises')
    // The click runs the fixture's action with an empty path, so a delivered
    // click necessarily moves the status away from "idle".
    const delivered = (JSON.parse(await readFile(options.statePath, 'utf8')) as { status?: string }).status !== 'idle'
    process.kill(options.pid, 'SIGHUP')
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
    return delivered
      ? { ok: true, detail: 'pointer input delivered (fixture reset after probe)' }
      : { ok: false, detail: 'pointer_probe_not_delivered: the fixture ignored a click at its own button point' }
  } catch (error) {
    return { ok: false, detail: `pointer_probe_failed: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    await session?.close()
  }
}

export function pathGrant(path: string) {
  return {
    id: createHash('sha256').update(`macos:executable-path:${path}`).digest('hex'),
    name: 'WorkflowFixture',
    executablePath: path,
  }
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing server address')
  return `http://127.0.0.1:${address.port}`
}

export async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

export function visualDecisionServer(token: string): Server {
  let calls = 0
  return createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}` || request.method !== 'POST' || request.url !== '/decide') {
      response.writeHead(401).end()
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body) as {
      observation: { elements: Array<{ identifier?: string; value: string | null }> }
      screenshot?: { data: string; mimeType: string }
      inputs?: Record<string, string>
    }
    if (payload.screenshot === undefined) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'screenshot_required' }))
      return
    }
    calls += 1
    const reportPath = payload.inputs?.['Report path'] ?? REPORT_PATH
    const decision = calls === 1
      ? {
          operation: 'TYPE_TEXT', target: null, text: reportPath, confidence: 0.99,
          box: { left: 0.1, top: 0.35, right: 0.9, bottom: 0.55 }, found: 1,
        }
      : {
          operation: 'CLICK', target: null, confidence: 0.99,
          box: { left: 0.1, top: 0.55, right: 0.4, bottom: 0.75 }, found: 1,
        }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      decision,
      usage: { input_tokens: 10, output_tokens: 0 },
      latencyMs: 1,
      textExtractionCalls: 0,
    }))
  })
}
export function decisionServer(token: string): Server {
  return createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}` || request.method !== 'POST' || request.url !== '/decide') {
      response.writeHead(401).end()
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body) as {
      goal: string
      observation: { elements: Array<{ id: string; identifier?: string; value: string | null }> }
      inputs?: Record<string, string>
    }
    const reportPath = payload.inputs?.['Report path'] ?? REPORT_PATH
    const field = payload.observation.elements.find(element => element.identifier === 'dsh-workflow-path')
    const button = payload.observation.elements.find(element => element.identifier === 'dsh-workflow-import')
    const decision = field && field.value !== reportPath
      ? { operation: 'TYPE_TEXT', target: field.id, text: reportPath, confidence: 0.99 }
      : button
        ? { operation: 'CLICK', target: button.id, confidence: 0.99 }
        : { operation: 'BLOCKED', target: null, confidence: 0.99 }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      decision,
      usage: { input_tokens: 10, output_tokens: 0 },
      latencyMs: 1,
      textExtractionCalls: 0,
    }))
  })
}
