import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const paths = process.argv.slice(2)
if (paths.length === 0) throw new Error('Usage: ocr-screens <image...>')
const results: Array<{ path: string; text: string }> = []
for (const path of paths) {
  const { stdout } = await execFileAsync('/tmp/dsh-cu-ocr-zh', [path], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
  results.push({ path, text: stdout })
}
console.log(JSON.stringify(results))
