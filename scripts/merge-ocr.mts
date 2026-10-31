import { readFile, writeFile } from 'node:fs/promises'

const [input, output] = process.argv.slice(2)
if (input === undefined || output === undefined) throw new Error('Usage: merge-ocr <input-json> <output-txt>')
const rows = JSON.parse(await readFile(input, 'utf8')) as Array<{ path: string; text: string }>
const chrome = /^(?:QuantML|专业级量化研究手册|别迷信预测.*|•+.*|Q|•••|问\s*AI.*|.*问AI.*)$/u
const seen = new Set<string>()
const lines: string[] = []
for (const row of rows) {
  for (const raw of row.text.split('\n')) {
    const line = raw.trim()
    if (line === '' || chrome.test(line)) continue
    if (seen.has(line)) continue
    seen.add(line)
    lines.push(line)
  }
}
await writeFile(output, lines.join('\n'), { mode: 0o600 })
console.log(JSON.stringify({ screens: rows.length, lines: lines.length, output }))
