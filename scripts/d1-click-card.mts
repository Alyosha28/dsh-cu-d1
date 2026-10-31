import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

interface Reply {
  ok?: boolean
  path?: string
  decision?: { operation: string; box?: { left: number; right: number; top: number; bottom: number }; confidence?: number }
  windowPoint?: { x: number; y: number }
  error?: string
}

const [pid, windowIdText, tokenPath, goal, topText, bottomText, leftText = '0.27', rightText = '0.53'] = process.argv.slice(2)
if (pid === undefined || windowIdText === undefined || tokenPath === undefined || goal === undefined
  || topText === undefined) {
  throw new Error('Usage: d1-click-card <pid> <windowId> <token-path> <goal> <cropTop|full> [cropBottom] [cropLeft] [cropRight]')
}
const crop = topText === 'full'
  ? undefined
  : { left: Number(leftText), top: Number(topText), right: Number(rightText), bottom: Number(bottomText) }

const child = spawn('npx', ['tsx', 'scripts/cua-session.mts', tokenPath], {
  cwd: '/Users/albaincompleta/DSH_CU',
  stdio: ['pipe', 'pipe', 'inherit'],
})
const lines = createInterface({ input: child.stdout })
const pending: Array<(value: Reply) => void> = []
function send(command: Record<string, unknown>): Promise<Reply> {
  return new Promise(resolve => {
    pending.push(resolve)
    child.stdin.write(`${JSON.stringify(command)}\n`)
  })
}
let readyResolve: (() => void) | undefined
const ready = new Promise<void>(resolve => { readyResolve = resolve })
lines.on('line', line => {
  const value = JSON.parse(line) as Reply & { ready?: boolean }
  if (value.ready === true) {
    readyResolve?.()
    return
  }
  pending.shift()?.(value)
})

const started = performance.now()
await ready
const attached = await send({ op: 'attach', pid, windowId: Number(windowIdText) })
if (attached.ok !== true) throw new Error(`attach failed: ${attached.error}`)
const shot = await send({ op: 'capture', crop })
if (shot.ok !== true || shot.path === undefined) throw new Error(`capture failed: ${shot.error}`)
const decided = await send({ op: 'decide', goal, image: shot.path, crop })
if (decided.ok !== true || decided.windowPoint === undefined) {
  await send({ op: 'exit' })
  console.log(JSON.stringify({ status: 'not_clicked', decision: decided.decision, error: decided.error, cropPath: shot.path }))
  process.exit(0)
}
const clicked = await send({ op: 'click', x: decided.windowPoint.x, y: decided.windowPoint.y })
if (clicked.ok !== true) {
  await send({ op: 'exit' })
  throw new Error(`click failed: ${clicked.error}`)
}
const after = await send({ op: 'capture' })
await send({ op: 'exit' })
await new Promise<void>(resolve => child.once('exit', () => resolve()))
console.log(JSON.stringify({
  status: 'clicked',
  decision: decided.decision,
  windowPoint: decided.windowPoint,
  cropPath: shot.path,
  afterPath: after.path,
  totalMs: Math.round(performance.now() - started),
}))
