/**
 * Installs @albaincompleta/dsh-cu-bundle into a DSH profile and verifies the result.
 *
 * It only touches the profile's package manifest through the same `dsh plugin`
 * command a person would run, backs the manifest up first, restores it if the
 * install or the doctor fails, and ends with the doctor. Nothing starts a
 * browser, a helper, or a model.
 *
 * Safety properties (SR-05 / SR-06):
 *   - `--profile` must match `^[a-z0-9][a-z0-9._-]{0,63}$`; a value with a `/`,
 *     an absolute path, an empty string, or a `..` segment is rejected before
 *     the filesystem is touched.
 *   - The resolved profile directory must still be under `DSH_HOME/profiles/`,
 *     checked again after `realpath` so a symlinked `profiles/<name>` cannot
 *     escape either.
 *   - The manifest is written to a temporary file in the same directory and
 *     renamed into place: no truncated `package.json` on a crash.
 *   - Exactly one backup (`package.json.bak`) is kept; a second run overwrites it
 *     instead of piling up timestamped copies.
 *   - A failed install or a failing doctor restores the backup and exits non-zero.
 *   - `--dry-run` prints the plan before any file is read, and exits 0.
 */
import { execFile } from 'node:child_process'
import { copyFile, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const ROOT = resolve(import.meta.dirname, '..')
const DSH_BIN = process.env.DSH_BIN ?? join(ROOT, 'node_modules/.bin/dsh')
const PACKAGES = [
  'dsh-cu-bundle',
  'dsh-cu-core',
  'dsh-browser-use-d1',
  'dsh-computer-use-d1',
  'dsh-cu-client',
].map(name => `link:${join(ROOT, 'packages', name)}`)
const BUNDLE = '@albaincompleta/dsh-cu-bundle'
const BACKUP = 'package.json.bak'

/** A profile name is one directory name under DSH_HOME/profiles, nothing else. */
export const PROFILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u

interface Manifest {
  name?: string
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

/** True when `target` is strictly inside `root` after resolution. */
export function isInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep)
}

/** Throws unless `profile` is a plain directory name. */
export function checkProfileName(profile: string): void {
  if (!PROFILE_PATTERN.test(profile)) {
    throw new Error(
      `--profile must match ${PROFILE_PATTERN.source} because it names a directory under DSH_HOME/profiles; got ${JSON.stringify(profile)}`,
    )
  }
}

function usage(): never {
  process.stderr.write('install: usage: node scripts/install-plugin.mts --profile <name> [--dry-run]\n')
  process.exit(1)
}

function fail(message: string): never {
  process.stderr.write(`install: ${message}\n`)
  process.exit(1)
}

/** resolve() + realpath containment: blocks `..`, absolute paths, and symlinks out. */
async function profileDirectory(profile: string): Promise<string> {
  const profilesRoot = resolve(DSH_HOME, 'profiles')
  const target = resolve(profilesRoot, profile)
  if (!isInside(profilesRoot, target)) {
    fail(`profile ${JSON.stringify(profile)} resolves outside ${profilesRoot}`)
  }
  // Only a target that exists can be a symlink; a profile directory created by
  // `dsh plugin install` does not exist yet and is used as resolved.
  const realRoot = await realpath(profilesRoot).catch(() => profilesRoot)
  const realTarget = await realpath(target).catch(() => undefined)
  if (realTarget !== undefined && !isInside(realRoot, realTarget)) {
    fail(`profile ${JSON.stringify(profile)} escapes ${profilesRoot} through a symlink (${realTarget})`)
  }
  return target
}

async function readManifest(path: string): Promise<Manifest> {
  return JSON.parse(await readFile(path, 'utf8')) as Manifest
}

/** Writes through a temporary file in the same directory, then renames. */
async function writeManifest(path: string, manifest: Manifest): Promise<void> {
  const temporary = join(dirname(path), `.${process.pid}.package.json.tmp`)
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

async function main(): Promise<void> {
  const profileArg = process.argv.find(argument => argument.startsWith('--profile='))
  const positional = process.argv.indexOf('--profile')
  const profile = profileArg?.split('=')[1] ?? (positional === -1 ? undefined : process.argv[positional + 1])
  const dryRun = process.argv.includes('--dry-run')

  if (profile === undefined || profile.startsWith('--')) usage()
  try {
    checkProfileName(profile)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  if (profile === 'desktop') {
    process.stdout.write('note: the desktop profile is optional and owned by the Electron application; quit DSH before installing it, then restart afterwards.\n')
  }

  const profileDir = await profileDirectory(profile)
  const manifestPath = join(profileDir, 'package.json')
  const addCommand = [DSH_BIN, ['plugin', '--profile', profile, 'add', ...PACKAGES]]

  if (dryRun) {
    // Planned before anything is read: a profile that does not exist yet still
    // prints its plan instead of failing on a missing manifest.
    process.stdout.write(`would use profile directory: ${profileDir}\n`)
    process.stdout.write(`would run: ${addCommand[0]} ${addCommand[1].join(' ')}\n`)
    process.stdout.write(`would add ${BUNDLE} to dsh.profile.bundles\n`)
    process.stdout.write('dry run: nothing changed\n')
    return
  }

  try {
    await readManifest(manifestPath)
  } catch {
    fail(`profile ${profile} has no package.json at ${manifestPath}; create it with: dsh plugin --profile ${profile} install`)
  }

  const backup = join(profileDir, BACKUP)
  // One backup, not one per run: `copyFile` overwrites the previous copy.
  await copyFile(manifestPath, backup)
  process.stdout.write(`manifest backup: ${backup}\n`)

  let changed = false
  const restore = async (): Promise<void> => {
    if (!changed) return
    await copyFile(backup, manifestPath).catch(() => undefined)
    process.stderr.write(`install: manifest restored from ${backup}\n`)
  }

  try {
    await run(addCommand[0]!, addCommand[1]!, { cwd: profileDir, maxBuffer: 16 * 1024 * 1024 })
    changed = true

    const manifest = await readManifest(manifestPath)
    const bundles = manifest.dsh?.profile?.bundles ?? []
    if (!bundles.includes(BUNDLE)) {
      manifest.dsh = manifest.dsh ?? {}
      manifest.dsh.profile = manifest.dsh.profile ?? {}
      manifest.dsh.profile.bundles = [...bundles, BUNDLE]
      await writeManifest(manifestPath, manifest)
      process.stdout.write(`bundles: ${manifest.dsh.profile.bundles.join(', ')}\n`)
    } else {
      process.stdout.write(`bundles: ${BUNDLE} already mounted\n`)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
    await restore()
    fail(`dsh plugin add failed: ${detail}`)
  }

  const appBundles = (await readManifest(manifestPath)).dsh?.profile?.bundles
    ?.filter(bundle => /dsh-(web-app|headless|sdk-app|tui-app|acp-app)$/u.test(bundle)) ?? []
  if (appBundles.length === 0) {
    process.stdout.write('note: this profile lists no app bundle (web/headless/sdk/tui); add one before booting it as an app.\n')
  }

  let doctorFailed = false
  const doctor = await run(process.execPath, [join(ROOT, 'scripts/plugin-doctor.mts'), `--profile=${profile}`], {
    env: { ...process.env, DSH_BIN },
    maxBuffer: 16 * 1024 * 1024,
  }).catch(error => {
    doctorFailed = true
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? error.message }
  })
  process.stdout.write(doctor.stdout)
  if (doctor.stderr) process.stderr.write(doctor.stderr)

  if (doctorFailed) {
    await restore()
    fail('the profile does not pass the doctor; the manifest was restored')
  }

  // Success: the previous run's backup is no longer needed.
  await rm(backup, { force: true }).catch(() => undefined)

  process.stdout.write(`
Installed into profile "${profile}".
Next:
  1. Restart DSH so the profile reloads its bundles.
  2. Start the local decision service:
       D1_DECISION_TOKEN=<token> uv run python -m dsh_cu_decision.server --port 8765 --token <token> --local-files-only
  3. Export the same value as DSH_CU_DECISION_TOKEN for the DSH process, and set
     DSH_CU_CONTROL_TOKEN to a value of your own: the bundle's built-in defaults
     are published, so anyone on this machine knows them.
`)
}

/** Test seam: importing this module must not parse argv or exit. */
async function invokedDirectly(): Promise<boolean> {
  const entry = process.argv[1]
  if (entry === undefined) return false
  const [self, target] = await Promise.all([
    realpath(new URL(import.meta.url).pathname),
    realpath(entry).catch(() => entry),
  ])
  return self === target
}

if (await invokedDirectly()) await main()
