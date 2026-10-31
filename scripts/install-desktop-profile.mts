/**
 * Installs the DSH-CU packages into the Electron-owned `desktop` profile.
 *
 * The `dsh` CLI refuses that profile by name, so this script does what the
 * in-app plugin manager does: pnpm-add the local packages and mount the bundle.
 * It refuses to run while DeepSeek Harness is running, because the application
 * owns the manifest and would overwrite it on exit.
 */
import { execFile } from 'node:child_process'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
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
    const { stdout } = await run('pgrep', ['-f', 'DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'])
    return stdout.trim() !== ''
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
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

  const command = ['add', ...PACKAGES]
  if (dryRun) {
    process.stdout.write(`would run: pnpm ${command.join(' ')}\n`)
    process.stdout.write('would add @dsh-cu/bundle to dsh.profile.bundles\n')
    return
  }

  const backup = `${manifestPath}.bak-${new Date().toISOString().replace(/[:.]/gu, '-')}`
  await copyFile(manifestPath, backup)
  process.stdout.write(`manifest backup: ${backup}\n`)
  await run('pnpm', command, { cwd: PROFILE, maxBuffer: 32 * 1024 * 1024 })

  manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes('@dsh-cu/bundle')) {
    manifest.dsh = manifest.dsh ?? {}
    manifest.dsh.profile = manifest.dsh.profile ?? {}
    manifest.dsh.profile.bundles = [...bundles, '@dsh-cu/bundle']
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  process.stdout.write(`bundles: ${(manifest.dsh.profile.bundles ?? []).join(', ')}\n`)
  process.stdout.write('Restart DeepSeek Harness, then check 插件 for dsh-cu-client / dsh-cu-browser entries.\n')
}

await main()
