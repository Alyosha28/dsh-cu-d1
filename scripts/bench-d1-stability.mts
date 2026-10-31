import { D1DecisionClient } from '@alyosha28/dsh-cu-core/decision'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const [tokenPath, imagePath] = process.argv.slice(2)
if (tokenPath === undefined || imagePath === undefined) throw new Error('Usage: bench-d1-stability <token-path> <image>')
const root = await mkdtemp(join(tmpdir(), 'dsh-cu-d1-stable-'), { mode: 0o700 })
const token = (await readFile(tokenPath, 'utf8')).trim()

const ocrRows: Array<{ width: number; runs: number[] }> = []
for (const width of [2508, 1280, 800]) {
  const target = join(root, `ocr-${width}.png`)
  await execFileAsync('magick', [imagePath, '-resize', `${width}x`, target])
  const runs: number[] = []
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now()
    await execFileAsync('/tmp/dsh-cu-ocr-zh', [target], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
    runs.push(Math.round(performance.now() - started))
  }
  ocrRows.push({ width, runs })
}

const client = new D1DecisionClient({
  decisionEndpoint: 'http://127.0.0.1:8765',
  decisionToken: token,
  decisionTimeoutMs: 120000,
  textStrategy: 'speculative',
})
const goal = 'Click the large article card in the center of the article list.'
const goalRows: Array<{ width: number; operations: string[]; mediansMs: number[] }> = []
for (const width of [1280, 800]) {
  const target = join(root, `d1-${width}.png`)
  await execFileAsync('magick', [imagePath, '-resize', `${width}x`, target])
  const bytes = await readFile(target)
  const operations: string[] = []
  const timings: number[] = []
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const started = performance.now()
    const response = await client.decide(goal, {
      snapshot_id: 'bench', version: 0, url: 'app://0/0', title: 'list',
      truncated: false, can_scroll_up: true, can_scroll_down: true, elements: [],
    }, new AbortController().signal, undefined, { data: bytes.toString('base64'), mimeType: 'image/png' })
    operations.push(response.decision.operation)
    timings.push(Math.round(performance.now() - started))
  }
  goalRows.push({ width, operations, mediansMs: timings })
}
console.log(JSON.stringify({ ocrRows, goalRows }, null, 2))
