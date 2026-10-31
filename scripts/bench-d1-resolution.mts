import { D1DecisionClient } from '@dsh-cu/core/decision'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const [tokenPath, imagePath] = process.argv.slice(2)
if (tokenPath === undefined || imagePath === undefined) throw new Error('Usage: bench-d1-resolution <token-path> <image>')
const root = await mkdtemp(join(tmpdir(), 'dsh-cu-d1-res-'), { mode: 0o700 })
const client = new D1DecisionClient({
  decisionEndpoint: 'http://127.0.0.1:8765',
  decisionToken: (await readFile(tokenPath, 'utf8')).trim(),
  decisionTimeoutMs: 120000,
  textStrategy: 'speculative',
})
const goal = 'Click the large article card in the center of the article list.'
const widths = [2508, 1600, 1200, 800, 600]
const rows: Array<{ width: number; runs: number[]; median: number; operation: string }> = []
for (const width of widths) {
  const target = join(root, `w-${width}.png`)
  await execFileAsync('magick', [imagePath, '-resize', `${width}x`, target])
  const bytes = await readFile(target)
  const runs: number[] = []
  let operation = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now()
    const response = await client.decide(goal, {
      snapshot_id: 'bench', version: 0, url: 'app://0/0', title: 'list',
      truncated: false, can_scroll_up: true, can_scroll_down: true, elements: [],
    }, new AbortController().signal, undefined, { data: bytes.toString('base64'), mimeType: 'image/png' })
    runs.push(Math.round(performance.now() - started))
    operation = response.decision.operation
  }
  const sorted = [...runs].sort((first, second) => first - second)
  rows.push({ width, runs, median: sorted[1], operation })
}
console.log(JSON.stringify(rows, null, 2))
