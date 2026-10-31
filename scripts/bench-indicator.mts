import { NativeControlIndicator } from '../packages/dsh-computer-use-d1/src/indicator.ts'
import { randomUUID } from 'node:crypto'

const pid = Number(process.argv[2] ?? '0')
if (!Number.isInteger(pid) || pid <= 0) throw new Error('Usage: bench-indicator <pid> <windowId>')
const windowId = Number(process.argv[3])

const stages: Array<{ stage: string; ms: number }> = []
let last = performance.now()
function mark(stage: string): void {
  const now = performance.now()
  stages.push({ stage, ms: Math.round(now - last) })
  last = now
}

const first = await NativeControlIndicator.create(undefined, () => undefined, () => undefined)
mark('create_compiles_swift')
await first.start(randomUUID(), { pid, windowId, title: 'bench', bounds: { x: 0, y: 0, width: 100, height: 100 } })
mark('start_helper_process')
await first.activity({ phase: 'acting', operation: 'CLICK', point: { x: 10, y: 10 } })
mark('activity_event')
for (let index = 1; index <= 3; index += 1) {
  await first.activity({ phase: 'acting', operation: 'CLICK', point: { x: 10 + index, y: 10 } })
  mark(`activity_${index}`)
}
await first.finish()
mark('finish')
await first.close()
mark('close_removes_temp_dir')
console.log(JSON.stringify(stages, null, 2))
