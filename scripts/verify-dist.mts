/**
 * Publish gate: refuses to pack or publish a package whose built artifacts are
 * missing (SR-01) or whose tarball would not contain them.
 *
 * Checks, for one package directory:
 *   1. `main`, `types`, and every `exports` target normalize to a path inside
 *      the package and exist on disk. Packages without `main`/`types` (the
 *      bundle and the client are plain JS packages) still have their exports
 *      checked.
 *   2. `dist/index.js` exists when the package declares a `build` script —
 *      `dist/` is gitignored, so a publish from a clean checkout would
 *      otherwise ship a two-file package.
 *   3. `npm pack --dry-run --json` reports more than DEFAULT_MIN_FILES files and
 *      the tarball includes every `main`/`types`/`exports` target.
 *
 * Usage:
 *   node scripts/verify-dist.mts [package-dir]     # default: cwd
 *   node scripts/verify-dist.mts --all             # every packages/*, private skipped
 *
 * Exit code 0 when every check passes, 1 otherwise. It never runs `npm publish`
 * and never writes outside the system temporary directory.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { join, normalize, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = resolve(import.meta.dirname, '..')
/** A package with one file has lost its build; two is the empty-package floor. */
const DEFAULT_MIN_FILES = 2

interface Manifest {
  name?: string
  version?: string
  private?: boolean
  main?: string
  types?: string
  typings?: string
  exports?: unknown
  files?: string[]
  scripts?: Record<string, string>
  publishConfig?: { access?: string }
}

export interface PackFile {
  path: string
}

export interface VerifyResult {
  name: string
  directory: string
  ok: boolean
  files: number
  problems: string[]
}

/** Every relative file path an `exports` tree points at. */
export function exportTargets(exportsField: unknown): string[] {
  const targets: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith('./')) targets.push(value.slice(2))
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) walk(item)
    }
  }
  walk(exportsField)
  return targets
}

/** Relative paths a tarball must contain for the manifest to be loadable. */
export function requiredFiles(manifest: Manifest): string[] {
  const required = new Set<string>()
  for (const field of [manifest.main, manifest.types, manifest.typings]) {
    if (typeof field === 'string' && field !== '') required.add(normalize(field))
  }
  for (const target of exportTargets(manifest.exports)) required.add(normalize(target))
  required.delete('package.json')
  return [...required]
}

function escapes(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${sep}`)
}

/**
 * Pure part of the gate: decides from the manifest and the pack listing alone,
 * so a test can feed it synthetic input without touching the filesystem.
 */
export function evaluatePack(
  manifest: Manifest,
  tarballFiles: PackFile[],
  onDisk: (relativePath: string) => boolean,
  minFiles: number = DEFAULT_MIN_FILES,
): string[] {
  const problems: string[] = []
  if (manifest.name === undefined) problems.push('manifest has no name')

  const required = requiredFiles(manifest)
  if (required.length === 0) {
    problems.push('manifest declares no main/types/exports target, so nothing verifies a build')
  }
  for (const file of required) {
    if (escapes(file)) problems.push(`manifest target ${file} escapes the package directory`)
    else if (!onDisk(file)) problems.push(`manifest target ${file} is missing on disk`)
  }

  if (manifest.scripts?.build !== undefined && !onDisk(join('dist', 'index.js'))) {
    problems.push('build script is declared but dist/index.js does not exist (run npm run build)')
  }

  const packed = new Set(tarballFiles.map(file => normalize(file.path)))
  for (const file of required) {
    if (!escapes(file) && !packed.has(file)) problems.push(`npm pack would not include ${file}`)
  }

  if (tarballFiles.length <= minFiles) {
    problems.push(`npm pack lists ${tarballFiles.length} files (need more than ${minFiles})`)
  }
  return problems
}

/** Packs for real (`--dry-run --json`) and lists what npm would ship. */
async function packListing(directory: string): Promise<PackFile[]> {
  const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: directory,
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  })
  const parsed = JSON.parse(stdout) as Array<{ files?: PackFile[] }>
  const first = parsed[0]
  if (first === undefined) throw new Error('npm pack --json returned no entry')
  return first.files ?? []
}

export async function verifyPackage(directory: string): Promise<VerifyResult> {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Manifest
  const name = manifest.name ?? relative(ROOT, directory)
  const problems: string[] = []
  let files = 0
  try {
    const listing = await packListing(directory)
    files = listing.length
    problems.push(...evaluatePack(manifest, listing, path => existsSync(join(directory, path))))
  } catch (error) {
    problems.push(`npm pack failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
  return { name, directory, ok: problems.length === 0, files, problems }
}

/** Every non-private package in the workspace, in `ORDER`-free directory order. */
export async function workspacePackages(): Promise<string[]> {
  const { glob } = await import('node:fs/promises')
  const directories: string[] = []
  for await (const entry of glob('packages/*/package.json')) {
    const directory = resolve(ROOT, entry, '..')
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Manifest
    if (manifest.private === true) continue
    directories.push(directory)
  }
  return directories.sort()
}

export async function verifyAll(): Promise<VerifyResult[]> {
  const results: VerifyResult[] = []
  for (const directory of await workspacePackages()) results.push(await verifyPackage(directory))
  return results
}

function report(result: VerifyResult): void {
  const status = result.ok ? 'PASS' : 'FAIL'
  process.stdout.write(`${status}  ${result.name} — ${result.files} files in tarball\n`)
  for (const problem of result.problems) process.stdout.write(`      ${problem}\n`)
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2)
  const results = arguments_.includes('--all')
    ? await verifyAll()
    : [await verifyPackage(resolve(arguments_.find(argument => !argument.startsWith('--')) ?? process.cwd()))]
  for (const result of results) report(result)
  const failed = results.filter(result => !result.ok)
  if (failed.length > 0) {
    process.stderr.write(`verify-dist: ${failed.length} package(s) cannot be published\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write('verify-dist: ok\n')
}

/** True when this module is the script node was asked to run, not an import. */
async function invokedDirectly(): Promise<boolean> {
  const entry = process.argv[1]
  if (entry === undefined) return false
  const [self, target] = await Promise.all([
    realpath(new URL(import.meta.url).pathname),
    realpath(entry).catch(() => entry),
  ])
  return self === target
}

// Importable by tests: only run when executed as a script.
if (await invokedDirectly()) await main()
