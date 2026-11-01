/**
 * Checks that a DSH profile really composes the D1 plugin entries — and that the
 * packages those entries name can actually be loaded.
 *
 * Two sources of truth:
 *   1. `dsh --dump-config` renders the profile's patch layers. This catches a
 *      bundle that was not installed, an entry that silently stayed disabled, a
 *      competing provider, and a duplicate entry id.
 *   2. The dump does NOT import any plugin module, so this script also resolves
 *      and imports each required package from the profile. A profile that
 *      composes the right rows but cannot import the provider used to report
 *      `doctor: ok` (SR-03); a version mismatch used to be a WARN that still
 *      exited 0 (SR-12 #3).
 *
 * It never starts a browser, a helper, or a model.
 *
 * Levels: PASS / WARN / FAIL. WARN is reserved for things that cannot make the
 * profile fail to boot the D1 plugin (the optional native pair, macOS grants).
 * Anything that decides mounting — a missing package, a duplicate id, a version
 * mismatch, a published default token — is a FAIL and exits non-zero.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
/** Packages the mount chain needs whether or not they own an entry. */
const CHAIN = [
  { name: '@albaincompleta/dsh-cu-bundle', level: 'FAIL' as const },
  { name: '@albaincompleta/dsh-cu-core', level: 'FAIL' as const },
  { name: '@albaincompleta/dsh-cu-client', level: 'WARN' as const },
]
/** Tokens published verbatim in the bundle patch; anyone can read them. */
const PUBLISHED_DEFAULT_TOKENS = ['dsh-cu-local', 'dsh-cu-control']

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

interface Entry {
  id: string
  lines: string[]
}

/**
 * Every entry block in the dump, in order, duplicates included.
 *
 * The previous version stored blocks in a `Map<string, string[]>`, so a second
 * `- id: dsh-cu-browser` silently replaced the first and the duplicate was
 * never checked (SR-04). A list keeps both.
 */
export function entries(dump: string): Entry[] {
  const list: Entry[] = []
  let current: Entry | undefined
  for (const line of dump.split('\n')) {
    // Tolerate indentation: a nested `insert:` list indents its rows, and a
    // duplicate there is exactly the row the old parser never saw (SR-04).
    const idMatch = /^\s*- id: (.+)$/u.exec(line)
    if (idMatch !== null) {
      current = { id: idMatch[1]!.trim(), lines: [] }
      list.push(current)
    }
    if (current !== undefined) current.lines.push(line)
  }
  return list
}

/** `- id:` rows: the real entry count, not a de-duplicated map size. */
export function entryCount(dump: string): number {
  return dump.split('\n').filter(line => /^\s*- id: /u.test(line)).length
}

export function field(block: string[], key: string): string | undefined {
  for (const line of block) {
    // Any indentation: a real dump indents by two, a nested list by four.
    const match = new RegExp(`^\\s+${key}:\\s*(.+)$`, 'u').exec(line)
    if (match !== null) return match[1]!.trim().replace(/^['"]|['"]$/gu, '')
  }
  return undefined
}

/** Ids that appear more than once, with the package each copy names. */
export function duplicateIds(list: Entry[]): Array<{ id: string; count: number; names: string[] }> {
  const ids = list.map(entry => entry.id)
  return [...new Set(ids)]
    .map(id => ({ id, count: ids.filter(other => other === id).length }))
    .filter(entry => entry.count > 1)
    .map(entry => ({
      ...entry,
      names: list.filter(other => other.id === entry.id).map(other => field(other.lines, 'name') ?? 'unnamed'),
    }))
}

/** Environment variable that overrides a token field, by field name. */
const TOKEN_ENVIRONMENT: Record<string, string> = {
  decisionToken: 'DSH_CU_DECISION_TOKEN',
  controlToken: 'DSH_CU_CONTROL_TOKEN',
}

/**
 * Token settings that would ship a published default.
 *
 * The dump shows the patch expression (`process.env.X || 'dsh-cu-local'`), not
 * its runtime value, so the default is only in effect when the overriding
 * variable is unset. Reporting a FAIL while the variable is set was wrong: the
 * composed config no longer resolves to the default.
 */
export function defaultTokenLines(entry: Entry, environment: NodeJS.ProcessEnv = process.env): string[] {
  const found: string[] = []
  for (const line of entry.lines) {
    const match = /^\s+(decisionToken|controlToken):\s*(.+)$/u.exec(line)
    if (match === null) continue
    const field = match[1]!
    const value = match[2]!
    const override = TOKEN_ENVIRONMENT[field]
    const overridden = override !== undefined && (environment[override] ?? '') !== ''
    for (const token of PUBLISHED_DEFAULT_TOKENS) {
      const literal = value === `'${token}'` || value === `"${token}"`
      const fallback = value.includes(`|| '${token}'`) || value.includes(`|| "${token}"`)
      if (literal) found.push(`${field} = ${token}`)
      else if (fallback && !overridden) found.push(`${field} falls back to ${token} (${override} is unset)`)
      else if (fallback) found.push(`${field} is overridden by ${override}`)
    }
  }
  return found
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
 * Resolution roots: the profile first, then the provider's own directory. A pnpm
 * `link:` entry keeps the provider in the repository, where its peer packages
 * resolve even though the profile never declares them.
 */
async function resolutionRoots(profileDir: string): Promise<string[]> {
  const roots = [profileDir]
  try {
    const require = createRequire(join(profileDir, 'package.json'))
    roots.push(dirname(require.resolve('@albaincompleta/dsh-cu-browser-use-d1/package.json')))
  } catch {
    // The provider may be installed under another name or not at all.
  }
  return roots
}

async function resolveFrom(roots: string[], specifier: string): Promise<string | undefined> {
  for (const root of roots) {
    try {
      const require = createRequire(join(root, 'package.json'))
      return require.resolve(specifier)
    } catch {
      continue
    }
  }
  return undefined
}

async function packageVersion(roots: string[], specifier: string): Promise<string | undefined> {
  const manifestPath = await resolveFrom(roots, `${specifier}/package.json`)
  if (manifestPath === undefined) return undefined
  try {
    const pkg = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: string }
    return pkg.version
  } catch {
    return undefined
  }
}

/** A package that does not resolve from the profile cannot be imported at boot. */
async function checkResolvable(roots: string[], name: string, level: 'FAIL' | 'WARN'): Promise<boolean> {
  const resolved = await resolveFrom(roots, `${name}/package.json`)
  if (resolved === undefined) {
    record(`resolve ${name}`, level, 'not installed in this profile: it cannot be imported at boot')
    return false
  }
  record(`resolve ${name}`, 'PASS', resolved)
  return true
}

/**
 * Imports the entry point for real, then explains the failure. Node itself strips
 * TypeScript-only syntax from `.js` files, so a packaged file that only fails on
 * a strict parser (a `: void` return annotation, a missing extension) is
 * re-checked here and reported as a packaging defect rather than a hard FAIL of
 * the whole profile — the cordis loader may still accept it.
 */
function explainImportFailure(mainPath: string, detail: string): string {
  try {
    const source = readFileSync(mainPath, 'utf8')
    if (stripTypeScriptTypes(source) !== source || /\b(interface|type|enum)\s+[A-Z]/u.test(source)) {
      return `${detail} (the packaged file contains TypeScript syntax; ship plain JavaScript)`
    }
  } catch {
    // Unreadable entry: keep the original message.
  }
  return detail
}

/** Imports the package entry point without mounting it, so a broken build fails here. */
async function checkImportable(roots: string[], name: string): Promise<void> {
  const mainPath = await resolveFrom(roots, name)
  if (mainPath === undefined) {
    record(`import ${name}`, 'FAIL', 'package entry does not resolve')
    return
  }
  try {
    await import(pathToFileURL(mainPath).href)
    record(`import ${name}`, 'PASS', mainPath)
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
    record(`import ${name}`, 'FAIL', explainImportFailure(mainPath, detail === '' ? 'import failed' : detail))
  }
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
  record('profile composes', 'PASS', `${entryCount(dump)} entries`)

  const skipLine = skipped.split('\n').find(line => line.includes('skipping profile bundle'))
  if (skipLine !== undefined) {
    record('bundle accepted', 'FAIL', skipLine.replace(/^dsh: /u, '').slice(0, 300))
  }

  for (const duplicate of duplicateIds(composed)) {
    record(`duplicate entry id ${duplicate.id}`, 'FAIL',
      `${duplicate.count} entries share it: ${duplicate.names.join(', ')}`)
  }

  for (const required of REQUIRED) {
    const matching = composed.filter(entry => entry.id === required.id)
    if (matching.length === 0) {
      record(`entry ${required.id}`, 'FAIL', 'missing: install @albaincompleta/dsh-cu-bundle into this profile')
      continue
    }
    for (const block of matching) {
      const name = field(block.lines, 'name')
      if (name !== required.name) {
        record(`entry ${required.id}`, 'FAIL', `name is ${name ?? 'missing'}, expected ${required.name}`)
      } else if (field(block.lines, 'disabled') === 'true') {
        record(`entry ${required.id}`, 'FAIL', 'disabled: the provider will not mount')
      } else {
        record(`entry ${required.id}`, 'PASS', name)
      }
    }
  }

  for (const optional of OPTIONAL) {
    const matching = composed.filter(entry => entry.id === optional.id)
    if (matching.length === 0) {
      record(`entry ${optional.id}`, 'WARN', 'not composed: native provider stays off')
      continue
    }
    for (const block of matching) {
      const disabled = field(block.lines, 'disabled') === 'true'
      record(`entry ${optional.id}`, disabled ? 'WARN' : 'PASS', disabled ? 'disabled by the bundle' : 'enabled')
    }
  }

  const competing = composed.filter(entry =>
    !REQUIRED.some(required => required.id === entry.id)
    && !OPTIONAL.some(optional => optional.id === entry.id)
    && field(entry.lines, 'disabled') !== 'true'
    && /browser-use|computer-use/u.test(field(entry.lines, 'name') ?? ''))
  record('single browser provider slot', competing.length === 0 ? 'PASS' : 'FAIL',
    competing.length === 0 ? 'no competing provider entry' : competing.map(entry => entry.id).join(', '))

  // The mount chain: resolving and importing is what the dump cannot tell us.
  const roots = await resolutionRoots(profileDir)
  for (const link of CHAIN) await checkResolvable(roots, link.name, link.level)
  for (const required of REQUIRED) await checkResolvable(roots, required.name, 'FAIL')
  for (const optional of OPTIONAL) await checkResolvable(roots, optional.name, 'WARN')
  for (const name of ['@albaincompleta/dsh-cu-bundle', ...REQUIRED.map(required => required.name)]) {
    await checkImportable(roots, name)
  }

  const tokens = composed
    .filter(entry => entry.id.startsWith('dsh-cu'))
    .flatMap(entry => defaultTokenLines(entry))
  const exposed = [...new Set(tokens.filter(token => !token.includes('is overridden by')))]
  record('control token', exposed.length === 0 ? 'PASS' : 'FAIL',
    exposed.length === 0
      ? (tokens.length === 0
        ? 'no published default token in the patch'
        : `published defaults are overridden (${[...new Set(tokens)].join('; ')})`)
      : `${exposed.join('; ')} — export DSH_CU_DECISION_TOKEN and DSH_CU_CONTROL_TOKEN with your own values before starting DSH`)

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

  const pluginAgent = await packageVersion(roots, '@deepseek-ai/dsh-agent')
  const host = await hostVersion(dshBinary)
  if (pluginAgent === undefined || host === undefined) {
    record('version alignment', 'FAIL',
      `plugin dsh-agent ${pluginAgent ?? 'unresolved'}, host ${host ?? 'unknown'}: the plugin's peer packages must resolve from the profile`)
  } else if (pluginAgent === host) {
    record('version alignment', 'PASS', `dsh-agent ${pluginAgent}`)
  } else {
    record('version alignment', 'FAIL',
      `plugin resolved dsh-agent ${pluginAgent} but host is ${host}; a mixed runtime fails during startup`)
  }

  const failed = checks.filter(check => check.level === 'FAIL')
  process.stdout.write(`\n${failed.length === 0 ? 'doctor: ok' : `doctor: ${failed.length} failed`}\n`)
  if (failed.length > 0) process.exitCode = 1
}

/** Test seam: importing this module must not run a check or call `dsh`. */
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
