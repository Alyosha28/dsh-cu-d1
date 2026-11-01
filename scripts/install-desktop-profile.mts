/**
 * Installs the DSH-CU packages into the Electron-owned `desktop` profile.
 *
 * The `dsh` CLI refuses that profile by name, so this script does what the
 * in-app plugin manager does: pnpm-add the local packages and mount the bundle.
 * It refuses to run while DeepSeek Harness is running, because the application
 * owns the manifest and would overwrite it on exit.
 */
import { execFile } from 'node:child_process'
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(HOME, 'profiles', 'desktop')
const ROOT = join(import.meta.dirname, '..')
const PACKAGES = ['dsh-cu-core', 'dsh-browser-use-d1', 'dsh-computer-use-d1', 'dsh-cu-client', 'dsh-cu-bundle']
  .map(name => `link:${join(ROOT, 'packages', name)}`)

async function appRunning(): Promise<boolean> {
  try {
    // A pattern without spaces: macOS pgrep -f does not match this app's
    // full path when the pattern itself contains spaces.
    const { stdout } = await run('pgrep', ['-f', 'MacOS/DeepSeek'])
    return stdout.trim() !== ''
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const command = ['add', ...PACKAGES]
  if (dryRun) {
    // Preview before touching anything: a running app does not block a plan, and
    // a profile that does not exist yet still prints what would be done.
    process.stdout.write(`profile: ${PROFILE}\n`)
    process.stdout.write(`would run: pnpm ${command.join(' ')}\n`)
    process.stdout.write('would add @albaincompleta/dsh-cu-bundle to dsh.profile.bundles\n')
    if (await appRunning()) {
      process.stdout.write('note: DeepSeek Harness is running; quit it before the real install (the app rewrites this profile on exit).\n')
    }
    process.stdout.write('dry run: nothing changed\n')
    return
  }
  if (await appRunning()) {
    process.stderr.write('DeepSeek Harness is running. Quit the app first: the application owns this profile and rewrites it on exit.\n')
    process.exitCode = 2
    return
  }

  const manifestPath = join(PROFILE, 'package.json')
  let manifest: { dsh?: { profile?: { bundles?: string[] } } }
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    process.stderr.write(`missing profile manifest: ${manifestPath}\n`)
    process.exitCode = 2
    return
  }

  const backup = `${manifestPath}.bak`
  // One backup, not one per run, and it is restored if pnpm or the manifest
  // patch fails: a half-installed desktop profile breaks the app on next start.
  await copyFile(manifestPath, backup)
  process.stdout.write(`manifest backup: ${backup}\n`)

  const restore = async (): Promise<void> => {
    await copyFile(backup, manifestPath).catch(() => undefined)
    process.stderr.write(`manifest restored from ${backup}\n`)
  }

  try {
    await run('pnpm', command, { cwd: PROFILE, maxBuffer: 32 * 1024 * 1024 })
  } catch (error) {
    await restore()
    process.stderr.write(`pnpm add failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}\n`)
    process.exitCode = 1
    return
  }

  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    if (!bundles.includes('@albaincompleta/dsh-cu-bundle')) {
      manifest.dsh = manifest.dsh ?? {}
      manifest.dsh.profile = manifest.dsh.profile ?? {}
      manifest.dsh.profile.bundles = [...bundles, '@albaincompleta/dsh-cu-bundle']
      // Temporary file + rename: no truncated package.json if this is interrupted.
      const temporary = `${manifestPath}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, manifestPath)
    }
    process.stdout.write(`bundles: ${(manifest.dsh.profile.bundles ?? []).join(', ')}\n`)
  } catch (error) {
    await restore()
    process.stderr.write(`manifest patch failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}\n`)
    process.exitCode = 1
    return
  }

  await rm(backup, { force: true }).catch(() => undefined)
  process.stdout.write('Restart DeepSeek Harness, then check 插件 for dsh-cu-client / dsh-cu-browser entries.\n')
}

await main()
