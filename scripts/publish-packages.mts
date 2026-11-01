/**
 * Publishes the DSH-CU packages in dependency order.
 *
 * Dry run by default: prints what would be published, after checking that npm
 * auth exists, that the workspace builds are present, and that every internal
 * dependency is already on the registry at the same version. `--publish`
 * performs the real publish.
 *
 * Fail-closed properties:
 *   - A package whose tarball lacks its `main`/`types`/`exports` targets is
 *     never published (`verify-dist.mts` is the same gate `prepublishOnly` runs).
 *   - A downstream package is never published before its internal dependencies
 *     exist on the registry: a half-published release burns a version number.
 *   - The temporary npmrc that carries NPM_TOKEN is removed on every exit path,
 *     including `process.exit()` and SIGINT (SR-11).
 */
import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { verifyPackage, workspacePackages } from './verify-dist.mts'

const run = promisify(execFile)
const TOKEN = process.env.NPM_TOKEN
const ROOT = join(import.meta.dirname, '..')
const ORDER = ['dsh-cu-core', 'dsh-browser-use-d1', 'dsh-computer-use-d1', 'dsh-cu-client', 'dsh-cu-bundle']
const publish = process.argv.includes('--publish')
const REGISTRY_PROBE = '--internal-registry-check-only'

let userconfigDirectory: string | undefined

interface Manifest {
  name: string
  version: string
  dependencies?: Record<string, string>
  private?: boolean
}

/** npm does not read NPM_TOKEN by itself: hand it a private userconfig directory. */
async function npmConfig(): Promise<string | undefined> {
  if (TOKEN === undefined || TOKEN === '') return undefined
  if (userconfigDirectory === undefined) {
    userconfigDirectory = await mkdtemp(join(tmpdir(), 'dsh-cu-npmrc-'))
    await writeFile(join(userconfigDirectory, 'npmrc'), `//registry.npmjs.org/:_authToken=${TOKEN}\n`, { mode: 0o600 })
  }
  return join(userconfigDirectory, 'npmrc')
}

/** Removes the token directory. Synchronous by design: usable from exit hooks. */
function removeConfigSync(): void {
  const directory = userconfigDirectory
  userconfigDirectory = undefined
  if (directory === undefined) return
  try {
    rmSync(directory, { recursive: true, force: true })
  } catch {
    // A private mkdtemp directory; a failed unlink must not mask the real error.
  }
}

async function cleanupConfig(): Promise<void> {
  removeConfigSync()
}

function installExitCleanup(): void {
  process.once('exit', removeConfigSync)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      removeConfigSync()
      process.exit(130)
    })
  }
}

async function npm(args: string[], options: Record<string, unknown> = {}) {
  const config = await npmConfig()
  return run('npm', config === undefined ? args : [...args, '--userconfig', config], options)
}

async function manifest(name: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(ROOT, 'packages', name, 'package.json'), 'utf8')) as Manifest
}

async function onRegistry(name: string, version: string): Promise<boolean> {
  try {
    await npm(['view', `${name}@${version}`, 'version'], { timeout: 30000 })
    return true
  } catch {
    return false
  }
}

/**
 * Internal dependencies of one package: every dependency whose name is a
 * workspace package of this repository.
 *
 * The previous version filtered on a hard-coded `@dsh-cu/` prefix, which stopped
 * matching when the packages were renamed to `@albaincompleta/dsh-cu-*`: the
 * list came back empty and the registry gate could never fire (SR-02). Matching
 * against the workspace itself cannot rot on a rename.
 */
export function internalDependencies(
  pkg: Pick<Manifest, 'dependencies'>,
  workspaceNames: ReadonlySet<string>,
): Array<[string, string]> {
  return Object.entries(pkg.dependencies ?? {}).filter(([dependency]) => workspaceNames.has(dependency))
}

/** `name@version` list of internal dependencies that are not on the registry yet. */
export function missingDependencies(
  required: ReadonlyArray<[string, string]>,
  resolved: ReadonlySet<string>,
): string[] {
  return required.map(([name, version]) => `${name}@${version}`).filter(specifier => !resolved.has(specifier))
}

/**
 * Refuses to publish `pkgName` while one of its internal dependencies is absent
 * from the registry. Returns normally when the package may go out.
 */
export function gate(
  required: ReadonlyArray<[string, string]>,
  resolved: ReadonlySet<string>,
  state: 'to publish' | 'already published',
): void {
  if (state === 'already published') return
  const missing = missingDependencies(required, resolved)
  if (missing.length > 0) {
    throw new Error(`needs ${missing.join(', ')} on the registry first`)
  }
}

async function workspaceNames(): Promise<Set<string>> {
  const names = new Set<string>()
  for (const directory of await workspacePackages()) {
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Manifest
    names.add(pkg.name)
  }
  return names
}

async function main(): Promise<void> {
  const internal = await workspaceNames()

  if (process.argv.includes(REGISTRY_PROBE)) {
    // Test seam: print what the gate treats as internal, then stop.
    for (const name of ORDER) {
      const pkg = await manifest(name)
      for (const [dependency, version] of internalDependencies(pkg, internal)) {
        process.stdout.write(`internal  ${pkg.name} -> ${dependency}@${version}\n`)
      }
    }
    return
  }

  try {
    const { stdout } = await npm(['whoami'])
    process.stdout.write(`npm user: ${stdout.trim()}\n`)
  } catch {
    await fail('not logged in to npm; run `npm login` or set NPM_TOKEN before publishing')
  }

  for (const name of ORDER) {
    const pkg = await manifest(name)
    if (pkg.private === true) await fail(`${pkg.name} is private`)

    const required = internalDependencies(pkg, internal)
    const resolved = new Set<string>()
    for (const [dependency, version] of required) {
      if (await onRegistry(dependency, version)) resolved.add(`${dependency}@${version}`)
    }
    const missing = missingDependencies(required, resolved)
    const published = await onRegistry(pkg.name, pkg.version)
    const state = published ? 'already published' : 'to publish'
    process.stdout.write(
      `${pkg.name}@${pkg.version} — ${state}`
      + `${missing.length === 0 ? '' : `; missing deps: ${missing.join(', ')}`}\n`,
    )
    if (!publish) continue

    if (published) continue
    // A package that loses on ETARGET cannot be republished under the same
    // version, so refuse before the first byte reaches the registry.
    try {
      gate(required, resolved, 'to publish')
    } catch (error) {
      await fail(`${pkg.name}@${pkg.version} ${error instanceof Error ? error.message : String(error)}`)
    }

    const verified = await verifyPackage(join(ROOT, 'packages', name))
    if (!verified.ok) {
      await fail(`${pkg.name}@${pkg.version} has no publishable build:\n  ${verified.problems.join('\n  ')}`)
    }
    process.stdout.write(`  verified: ${verified.files} files in tarball\n`)

    const args = ['publish', '--workspace', pkg.name, '--access', 'public']
    if (process.env.NPM_OTP !== undefined) args.push('--otp', process.env.NPM_OTP)
    process.stdout.write(`running: npm ${args.join(' ')}\n`)
    try {
      await npm(args, { cwd: ROOT, timeout: 180000, maxBuffer: 16 * 1024 * 1024 })
    } catch (error) {
      const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
      await fail(`npm publish failed for ${pkg.name}@${pkg.version}: ${detail}`)
    }
    process.stdout.write(`published ${pkg.name}@${pkg.version}\n`)
  }

  if (!publish) process.stdout.write('\ndry run: nothing published. Re-run with --publish to publish.\n')
}

/** Prints the reason, removes the token file, then exits non-zero. */
async function fail(message: string): Promise<never> {
  process.stderr.write(`publish: ${message}\n`)
  await cleanupConfig()
  process.exit(1)
}

/** Test seam: importing this module must not touch npm or the temp directory. */
async function invokedDirectly(): Promise<boolean> {
  const entry = process.argv[1]
  if (entry === undefined) return false
  const [self, target] = await Promise.all([
    realpath(new URL(import.meta.url).pathname),
    realpath(entry).catch(() => entry),
  ])
  return self === target
}

if (await invokedDirectly()) {
  installExitCleanup()
  try {
    await main()
  } finally {
    await cleanupConfig()
  }
}
