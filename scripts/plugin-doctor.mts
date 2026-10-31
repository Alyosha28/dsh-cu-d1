/**
 * Checks that a DSH profile really composes the D1 plugin entries.
 *
 * `dsh --dump-config` renders the profile's patch layers without importing
 * plugin modules, so this runs on any machine and cannot start a browser, a
 * helper, or a model. It catches the failures that unit tests cannot see:
 * a bundle that was not installed, an entry that silently stayed disabled, a
 * second browser provider competing for the single registration slot, and a
 * plugin built against a different DSH package version than the host.
 */
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const REQUIRED = [
  { id: 'browser-use-registry', name: '@deepseek-ai/dsh-browser-use' },
  { id: 'dsh-cu-browser', name: '@albaincompleta/dsh-cu-browser-use-d1' },
]
const OPTIONAL = [
  { id: 'computer-use-registry', name: '@deepseek-ai/dsh-computer-use' },
  { id: 'dsh-cu-computer', name: '@albaincompleta/dsh-cu-computer-use-d1' },
]

interface Check {
  name: string
  level: 'PASS' | 'WARN' | 'FAIL'
  detail: string
}

const checks: Check[] = []
function record(name: string, level: Check['level'], detail: string): void {
  checks.push({ name, level, detail })
  process.stdout.write(`${level}  ${name} — ${detail}\n`)
}

/** One entry block: its id line plus the lines indented under it. */
function entries(dump: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  let current: { id: string; lines: string[] } | undefined
  for (const line of dump.split('\n')) {
    const idMatch = /^- id: (.+)$/u.exec(line)
    if (idMatch !== null) {
      if (current !== undefined) map.set(current.id, current.lines)
      current = { id: idMatch[1]!.trim(), lines: [line] }
      continue
    }
    if (current !== undefined) current.lines.push(line)
  }
  if (current !== undefined) map.set(current.id, current.lines)
  return map
}

function field(block: string[], key: string): string | undefined {
  for (const line of block) {
    const match = new RegExp(`^\\s+${key}:\\s*(.+)$`, 'u').exec(line)
    if (match !== null) return match[1]!.trim().replace(/^['"]|['"]$/gu, '')
  }
  return undefined
}

async function hostVersion(dshBinary: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('readlink', ['-f', dshBinary])
    let dir = dirname(stdout.trim())
    while (dir !== dirname(dir)) {
      try {
        const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }
        if (pkg.name === '@deepseek-ai/dsh' && pkg.version !== undefined) return pkg.version
      } catch {
        // Keep walking up to the install root.
      }
      dir = dirname(dir)
    }
  } catch {
    // dsh not on PATH: version comparison is skipped.
  }
  return undefined
}

/**
 * Resolves a host package from the profile, then from the installed provider.
 * A pnpm `link:` entry keeps the provider in the repository, where its peer
 * packages resolve even though the profile itself never declares them.
 */
async function pluginPeerVersion(profileDir: string, specifier: string): Promise<string | undefined> {
  const roots = [profileDir]
  try {
    const require = createRequire(join(profileDir, 'package.json'))
    roots.push(dirname(require.resolve('@albaincompleta/dsh-cu-browser-use-d1/package.json')))
  } catch {
    // The provider may be installed under another name or not at all.
  }
  for (const root of roots) {
    try {
      const require = createRequire(join(root, 'package.json'))
      const pkg = JSON.parse(await readFile(require.resolve(`${specifier}/package.json`), 'utf8')) as { version?: string }
      return pkg.version
    } catch {
      continue
    }
  }
  return undefined
}

async function main(): Promise<void> {
  const profileArg = process.argv.find(argument => argument.startsWith('--profile='))
  const profile = profileArg?.split('=')[1] ?? 'dsh-cu'
  const profileDir = resolve(DSH_HOME, 'profiles', profile)
  process.stdout.write(`profile: ${profileDir}\n`)

  const dshBinary = process.env.DSH_BIN ?? 'dsh'
  let dump: string
  let skipped = ''
  try {
    const result = await run(dshBinary, ['--profile', profile, '--dump-config'], { maxBuffer: 8 * 1024 * 1024 })
    dump = result.stdout
    skipped = result.stderr
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    record('profile composes', 'FAIL', message.split('\n')[0] ?? message)
    process.exitCode = 1
    return
  }

  const composed = entries(dump)
  record('profile composes', 'PASS', `${composed.size} entries`)
  const skipLine = skipped.split('\n').find(line => line.includes('skipping profile bundle'))
  if (skipLine !== undefined) {
    record('bundle accepted', 'FAIL', skipLine.replace(/^dsh: /u, '').slice(0, 300))
  }

  for (const required of REQUIRED) {
    const block = composed.get(required.id)
    if (block === undefined) {
      record(`entry ${required.id}`, 'FAIL', 'missing: install @albaincompleta/dsh-cu-bundle into this profile')
      continue
    }
    const name = field(block, 'name')
    const disabled = field(block, 'disabled')
    if (name !== required.name) {
      record(`entry ${required.id}`, 'FAIL', `name is ${name ?? 'missing'}, expected ${required.name}`)
    } else if (disabled === 'true') {
      record(`entry ${required.id}`, 'FAIL', 'disabled: the provider will not mount')
    } else {
      record(`entry ${required.id}`, 'PASS', name)
    }
  }

  for (const optional of OPTIONAL) {
    const block = composed.get(optional.id)
    if (block === undefined) {
      record(`entry ${optional.id}`, 'WARN', 'not composed: native provider stays off')
      continue
    }
    record(`entry ${optional.id}`, field(block, 'disabled') === 'true' ? 'WARN' : 'PASS',
      field(block, 'disabled') === 'true' ? 'disabled by the bundle' : 'enabled')
  }

  const competing = [...composed.entries()].filter(([id, block]) =>
    !REQUIRED.some(required => required.id === id)
    && !OPTIONAL.some(optional => optional.id === id)
    && field(block, 'disabled') !== 'true'
    && /browser-use|computer-use/u.test(field(block, 'name') ?? ''))
  record('single browser provider slot', competing.length === 0 ? 'PASS' : 'FAIL',
    competing.length === 0 ? 'no competing provider entry' : competing.map(([id]) => id).join(', '))

  if (process.platform === 'darwin') {
    // Native runs need two macOS grants; report them here so a person can grant
    // them before the first failing run instead of discovering it mid-task.
    try {
      const { readPermissions, permissionSettingsUrl } = await import(
        new URL('../packages/dsh-computer-use-d1/dist/permissions.js', import.meta.url).href
      ) as {
        readPermissions: () => Promise<{ accessibility: boolean; screenRecording: boolean }>
        permissionSettingsUrl: (kind: 'accessibility' | 'screenRecording') => string
      }
      const state = await readPermissions()
      record('macOS accessibility', state.accessibility ? 'PASS' : 'WARN',
        state.accessibility ? 'granted' : `not granted for this process: ${permissionSettingsUrl('accessibility')}`)
      record('macOS screen recording', state.screenRecording ? 'PASS' : 'WARN',
        state.screenRecording ? 'granted' : `not granted for this process: ${permissionSettingsUrl('screenRecording')}`)
    } catch (error) {
      record('macOS permissions', 'WARN', `could not read privacy state: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }

  const pluginAgent = await pluginPeerVersion(profileDir, '@deepseek-ai/dsh-agent')
  const host = await hostVersion(dshBinary)
  if (pluginAgent === undefined || host === undefined) {
    record('version alignment', 'WARN', `plugin dsh-agent ${pluginAgent ?? 'unresolved'}, host ${host ?? 'unknown'}`)
  } else if (pluginAgent === host) {
    record('version alignment', 'PASS', `dsh-agent ${pluginAgent}`)
  } else {
    record('version alignment', 'WARN', `plugin resolved dsh-agent ${pluginAgent} but host is ${host}; a mixed runtime can fail during startup`)
  }

  const failed = checks.filter(check => check.level === 'FAIL')
  process.stdout.write(`\n${failed.length === 0 ? 'doctor: ok' : `doctor: ${failed.length} failed`}\n`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
