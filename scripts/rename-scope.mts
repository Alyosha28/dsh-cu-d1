/**
 * Rewrites the package scope across the repository.
 *
 * Usage:
 *   node scripts/rename-scope.mts --to=@alyosha28 --dry-run
 *   node scripts/rename-scope.mts --to=@alyosha28 --apply
 *
 * Every package named `@dsh-cu/<name>` becomes `@<to>/dsh-cu-<name>`, and every
 * reference in source, manifests, the bundle patch, tests and docs follows. The
 * replacements are computed from the current manifests, so the script can run
 * twice without doubling the prefix.
 */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const args = new Map(process.argv.slice(2).map(arg => {
  const [key, value = ''] = arg.replace(/^--/u, '').split('=')
  return [key, value]
}))
const to = args.get('to')
const from = args.get('from') ?? '@dsh-cu'
const apply = args.has('apply')

if (to === undefined || !/^@[a-z\d][a-z\d._-]*$/u.test(to) || !/^@[a-z\d][a-z\d._-]*$/u.test(from)) {
  process.stderr.write('usage: node scripts/rename-scope.mts --to=@scope [--from=@old-scope] (--apply)\n')
  process.exit(2)
}
const prefix = 'dsh-cu-'

const TEXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|json|md|ya?ml)$/u
const SKIP = new Set(['node_modules', 'dist', '.git', '.venv', '__pycache__'])

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path, out)
    else if (TEXT.test(entry.name)) out.push(path)
  }
  return out
}

const packagesDir = join(ROOT, 'packages')
const renames: Array<[string, string]> = []
for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const manifestPath = join(packagesDir, entry.name, 'package.json')
  try {
    await stat(manifestPath)
  } catch {
    continue
  }
  const name = JSON.parse(await readFile(manifestPath, 'utf8')).name as string
  if (!name.startsWith(`${from}/`)) continue
  const local = name.slice(from.length + 1)
  renames.push([name, `${to}/${local.startsWith(prefix) ? local : prefix + local}`])
}

if (renames.length === 0) {
  process.stderr.write(`nothing to rename: no ${from}/* packages found\n`)
  process.exit(1)
}

for (const [from, into] of renames) process.stdout.write(`${from} -> ${into}\n`)

const files = await walk(ROOT)
let changed = 0
for (const file of files) {
  let text = await readFile(file, 'utf8')
  const before = text
  // Longest names first so `@dsh-cu/core` never shadows `@dsh-cu/core-extra`.
  for (const [from, into] of [...renames].sort((left, right) => right[0].length - left[0].length)) {
    text = text.split(from).join(into)
  }
  if (text !== before) {
    changed += 1
    process.stdout.write(`  ${relative(ROOT, file)}\n`)
    if (apply) await writeFile(file, text)
  }
}
process.stdout.write(`${changed} files ${apply ? 'rewritten' : 'would change'}\n`)
if (!apply) process.stdout.write('dry run: pass --apply to rewrite\n')
