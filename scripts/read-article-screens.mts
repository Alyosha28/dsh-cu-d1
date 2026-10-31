import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

interface Screen {
  index: number
  path: string
  pixelWidth: number
  pixelHeight: number
  captureMs: number
}

const [pid, windowIdText, tokenPath, screensText = '8', deltaText = '-8'] = process.argv.slice(2)
if (pid === undefined || windowIdText === undefined || tokenPath === undefined) {
  throw new Error('Usage: read-article-screens <pid> <windowId> <token-path> [screens] [delta]')
}
const windowId = Number(windowIdText)
const screens = Number(screensText)
const delta = Number(deltaText)

const child = spawn('npx', ['tsx', 'scripts/cua-session.mts', tokenPath], {
  cwd: '/Users/albaincompleta/DSH_CU',
  stdio: ['pipe', 'pipe', 'inherit'],
})
const lines = createInterface({ input: child.stdout })
const pending: Array<(value: Record<string, unknown>) => void> = []
const failures: Array<(error: Error) => void> = []

function send(command: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    pending.push(resolve)
    failures.push(reject)
    child.stdin.write(`${JSON.stringify(command)}\n`)
  })
}

let readyResolve: (() => void) | undefined
const ready = new Promise<void>(resolve => { readyResolve = resolve })
lines.on('line', line => {
  const value = JSON.parse(line) as Record<string, unknown>
  if (value.ready === true) {
    readyResolve?.()
    return
  }
  const resolve = pending.shift()
  failures.shift()
  if (value.ok !== true) {
    resolve?.({ ...value, failed: true })
    return
  }
  resolve?.(value)
})

const started = performance.now()
await ready
const attach = await send({ op: 'attach', pid, windowId })
if (attach.ok !== true) throw new Error(`attach failed: ${JSON.stringify(attach)}`)
const captured: Screen[] = []
let previousBytes: Buffer | undefined
let stopped = 'screen_limit'
for (let index = 1; index <= screens; index += 1) {
  const shot = await send({ op: 'capture' })
  if (shot.ok !== true) throw new Error(`capture ${index} failed: ${JSON.stringify(shot)}`)
  const bytes = await readFile(String(shot.path))
  if (previousBytes !== undefined && previousBytes.equals(bytes)) {
    stopped = 'bottom_reached'
    break
  }
  previousBytes = bytes
  captured.push({
    index,
    path: String(shot.path),
    pixelWidth: Number(shot.pixelWidth),
    pixelHeight: Number(shot.pixelHeight),
    captureMs: Number(shot.captureMs),
  })
  const scrolled = await send({ op: 'scroll', x: 500, y: 500, delta, waitMs: 300 })
  if (scrolled.ok !== true) throw new Error(`scroll ${index} failed: ${JSON.stringify(scrolled)}`)
}
await send({ op: 'exit' })
await new Promise<void>(resolve => child.once('exit', () => resolve()))
console.log(JSON.stringify({ screens: captured, stopped, totalMs: Math.round(performance.now() - started) }))
