/**
 * Installs @alyosha28/dsh-cu-bundle into a DSH profile and verifies the result.
 *
 * It only touches the profile's package manifest through the same `dsh plugin`
 * command a person would run, backs the manifest up first, and ends with the
 * doctor. Nothing starts a browser, a helper, or a model.
 */
import { execFile } from 'node:child_process'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
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

interface Manifest {
  name?: string
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

function fail(message: string): never {
  process.stderr.write(`install: ${message}\n`)
  process.exit(1)
}

async function main(): Promise<void> {
  const profileArg = process.argv.find(argument => argument.startsWith('--profile='))
  const profile = profileArg?.split('=')[1]
    ?? process.argv[process.argv.indexOf('--profile') + 1]
  const dryRun = process.argv.includes('--dry-run')
  if (profile === undefined || profile === '--dry-run') {
    fail('usage: node scripts/install-plugin.mts --profile <name> [--dry-run]')
  }
  if (profile === 'desktop') {
    process.stdout.write('note: the desktop profile is optional and owned by the Electron application; quit DSH before installing it, then restart afterwards.\n')
  }

  const profileDir = resolve(DSH_HOME, 'profiles', profile)
  const manifestPath = join(profileDir, 'package.json')
  let manifest: Manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
  } catch {
    fail(`profile ${profile} has no package.json at ${manifestPath}; create it with: dsh plugin --profile ${profile} install`)
  }

  const addCommand = [DSH_BIN, ['plugin', '--profile', profile, 'add', ...PACKAGES]]
  if (dryRun) {
    process.stdout.write(`would run: ${addCommand[0]} ${addCommand[1].join(' ')}\n`)
  } else {
    const backup = `${manifestPath}.bak-${new Date().toISOString().replace(/[:.]/gu, '-')}`
    await copyFile(manifestPath, backup)
    process.stdout.write(`manifest backup: ${backup}\n`)
    try {
      await run(addCommand[0]!, addCommand[1]!, { cwd: profileDir, maxBuffer: 16 * 1024 * 1024 })
    } catch (error) {
      const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
      fail(`dsh plugin add failed: ${detail}`)
    }
  }

  manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes('@alyosha28/dsh-cu-bundle')) {
    if (dryRun) {
      process.stdout.write(`would add @alyosha28/dsh-cu-bundle to dsh.profile.bundles (now: ${bundles.join(', ') || 'empty'})\n`)
    } else {
      manifest.dsh = manifest.dsh ?? {}
      manifest.dsh.profile = manifest.dsh.profile ?? {}
      manifest.dsh.profile.bundles = [...bundles, '@alyosha28/dsh-cu-bundle']
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      process.stdout.write(`bundles: ${manifest.dsh.profile.bundles.join(', ')}\n`)
    }
  } else {
    process.stdout.write('bundles: @alyosha28/dsh-cu-bundle already mounted\n')
  }

  if (dryRun) {
    process.stdout.write('dry run: nothing changed\n')
    return
  }

  const appBundles = bundles.filter(bundle => /dsh-(web-app|headless|sdk-app|tui-app|acp-app)$/u.test(bundle))
  if (appBundles.length === 0) {
    process.stdout.write('note: this profile lists no app bundle (web/headless/sdk/tui); add one before booting it as an app.\n')
  }

  const doctor = await run(process.execPath, [join(ROOT, 'scripts/plugin-doctor.mts'), `--profile=${profile}`], {
    env: { ...process.env, DSH_BIN },
    maxBuffer: 16 * 1024 * 1024,
  }).catch(error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? error.message }))
  process.stdout.write(doctor.stdout)
  if (doctor.stderr) process.stderr.write(doctor.stderr)

  process.stdout.write(`
Installed into profile "${profile}".
Next:
  1. Restart DSH so the profile reloads its bundles.
  2. Start the local decision service:
       D1_DECISION_TOKEN=<token> uv run python -m dsh_cu_decision.server --port 8765 --token <token> --local-files-only
  3. Set DSH_CU_DECISION_TOKEN to the same value for the DSH process.
`)
}

await main()
