/**
 * Publishes the DSH-CU packages in dependency order.
 *
 * Dry run by default: prints what would be published, after checking that npm
 * auth exists and that each internal dependency is already on the registry at
 * the same version. `--publish` performs the real publish.
 */
import { execFile } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const TOKEN = process.env.NPM_TOKEN
let userconfig: string | undefined

/** npm does not read NPM_TOKEN by itself: hand it a private userconfig. */
async function npmConfig(): Promise<string | undefined> {
  if (TOKEN === undefined || TOKEN === '') return undefined
  userconfig ??= join(tmpdir(), `dsh-cu-npmrc-${process.pid}`)
  await writeFile(userconfig, `//registry.npmjs.org/:_authToken=${TOKEN}\n`, { mode: 0o600 })
  return userconfig
}

async function npm(args: string[], options: Record<string, unknown> = {}) {
  const config = await npmConfig()
  return run('npm', config === undefined ? args : [...args, '--userconfig', config], options)
}
const ROOT = join(import.meta.dirname, '..')
const ORDER = ['dsh-cu-core', 'dsh-browser-use-d1', 'dsh-computer-use-d1', 'dsh-cu-client', 'dsh-cu-bundle']
const publish = process.argv.includes('--publish')

function fail(message: string): never {
  process.stderr.write(`publish: ${message}\n`)
  process.exit(1)
}

async function manifest(name: string): Promise<{ name: string; version: string; dependencies?: Record<string, string>; private?: boolean }> {
  return JSON.parse(await readFile(join(ROOT, 'packages', name, 'package.json'), 'utf8'))
}

async function onRegistry(name: string, version: string): Promise<boolean> {
  try {
    await npm(['view', `${name}@${version}`, 'version'], { timeout: 30000 })
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  try {
    const { stdout } = await npm(['whoami'])
    process.stdout.write(`npm user: ${stdout.trim()}\n`)
  } catch {
    fail('not logged in to npm; run `npm login` or set NPM_TOKEN before publishing')
  }

  for (const name of ORDER) {
    const pkg = await manifest(name)
    if (pkg.private === true) fail(`${pkg.name} is private`)
    const missing = []
    for (const [dependency, version] of Object.entries(pkg.dependencies ?? {})) {
      if (!dependency.startsWith('@dsh-cu/')) continue
      if (!await onRegistry(dependency, version)) missing.push(`${dependency}@${version}`)
    }
    let published = await onRegistry(pkg.name, pkg.version)
    const state = published ? 'already published' : 'to publish'
    process.stdout.write(`${pkg.name}@${pkg.version} — ${state}${missing.length === 0 ? '' : `; missing deps: ${missing.join(', ')}`}\n`)
    if (!publish) continue

    if (published) continue
    if (missing.length > 0 && name !== 'dsh-cu-core') {
      fail(`${pkg.name}@${pkg.version} needs ${missing.join(', ')} on the registry first`)
    }
    const args = ['publish', '--workspace', pkg.name, '--access', 'public']
    if (process.env.NPM_OTP !== undefined) args.push('--otp', process.env.NPM_OTP)
    process.stdout.write(`running: npm ${args.join(' ')}\n`)
    await npm(args, { cwd: ROOT, timeout: 180000, maxBuffer: 16 * 1024 * 1024 })
    process.stdout.write(`published ${pkg.name}@${pkg.version}\n`)
  }

  if (!publish) process.stdout.write('\ndry run: nothing published. Re-run with --publish to publish.\n')
}

try {
  await main()
} finally {
  if (userconfig !== undefined) await rm(userconfig, { force: true })
}
