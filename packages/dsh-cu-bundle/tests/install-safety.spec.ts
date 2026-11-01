/**
 * SR-05 / SR-06: the installer must refuse a profile name that is a path, must
 * stay under DSH_HOME/profiles (symlinks included), must restore the manifest
 * when the install fails, and must keep at most one backup.
 *
 * Every case runs in its own temporary DSH_HOME; the real `~/.dsh` is never
 * read or written. `DSH_BIN` is a shell script that either does nothing (a
 * successful `dsh plugin add`) or fails, so the agent under test is the
 * installer's own filesystem behaviour.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { PROFILE_PATTERN, checkProfileName, isInside } from '../../../scripts/install-plugin.mts'

const ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/u, '')
const INSTALLER = join(ROOT, 'scripts', 'install-plugin.mts')
const VICTIM = JSON.stringify({ name: 'unrelated-user-project', version: '3.1.4', scripts: { postinstall: 'node build.js' } }, null, 2)

const created: string[] = []
afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function sandbox(): string {
  const base = mkdtempSync(join(tmpdir(), 'dsh-cu-install-test-'))
  created.push(base)
  mkdirSync(join(base, 'dsh', 'profiles'), { recursive: true })
  return base
}

/** A stand-in for the dsh CLI: exits 0 and touches nothing, or exits 1. */
function fakeDsh(base: string, behaviour: 'ok' | 'fail'): string {
  const path = join(base, 'fake-dsh.sh')
  writeFileSync(path, behaviour === 'ok' ? '#!/bin/sh\nexit 0\n' : '#!/bin/sh\necho "plugin add failed: network" >&2\nexit 1\n')
  chmodSync(path, 0o755)
  return path
}

function runInstaller(base: string, args: string[], behaviour: 'ok' | 'fail' = 'ok') {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: join(base, 'dsh'), DSH_BIN: fakeDsh(base, behaviour) },
  })
}

describe('SR-05 profile name validation', () => {
  it('accepts plain profile names', () => {
    for (const name of ['dsh-cu', 'dsh-cu-install', 'a', 'probe.2', 'x_y-z']) {
      expect(PROFILE_PATTERN.test(name), name).toBe(true)
      expect(() => checkProfileName(name)).not.toThrow()
    }
  })

  it('rejects traversal, separators, absolute paths and empty values', () => {
    for (const name of ['..', '../x', '../../victimproj', 'a/b', '/etc', '', '.hidden', 'a b', 'A-B', 'x'.repeat(65), '~/x']) {
      expect(() => checkProfileName(name), name).toThrow(/must match/u)
    }
  })

  it('treats only strict descendants as inside the profiles root', () => {
    expect(isInside('/h/profiles', '/h/profiles/a')).toBe(true)
    expect(isInside('/h/profiles', '/h/profiles')).toBe(false)
    expect(isInside('/h/profiles', '/h/profiles/../victim')).toBe(false)
    expect(isInside('/h/profiles', '/h/profiles-other')).toBe(false)
    expect(isInside('/h/profiles', '/etc')).toBe(false)
  })
})

describe('SR-05 installer containment', () => {
  it('refuses a traversing --profile before touching the victim manifest', () => {
    const base = sandbox()
    const victim = join(base, 'victimproj')
    mkdirSync(victim)
    writeFileSync(join(victim, 'package.json'), VICTIM)

    const result = runInstaller(base, ['--profile=../../victimproj'])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/must match/u)
    expect(readFileSync(join(victim, 'package.json'), 'utf8')).toBe(VICTIM)
    expect(readdirSync(victim)).toEqual(['package.json'])
  })

  it('refuses a symlinked profile directory that points outside DSH_HOME', () => {
    const base = sandbox()
    const victim = join(base, 'victimpkg')
    mkdirSync(victim)
    writeFileSync(join(victim, 'package.json'), VICTIM)
    symlinkSync(victim, join(base, 'dsh', 'profiles', 'escape'))

    const result = runInstaller(base, ['--profile=escape'])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/escapes/u)
    expect(readFileSync(join(victim, 'package.json'), 'utf8')).toBe(VICTIM)
  })

  it('a --dry-run on a fresh profile prints its plan and changes nothing', () => {
    const base = sandbox()
    const result = runInstaller(base, ['--profile=fresh', '--dry-run'])

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/would run: /u)
    expect(existsSync(join(base, 'dsh', 'profiles', 'fresh'))).toBe(false)
  })
})

describe('SR-06 installer rollback', () => {
  function profile(base: string): string {
    const directory = join(base, 'dsh', 'profiles', 'probe')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), VICTIM)
    return directory
  }

  it('restores the manifest byte-for-byte when the install fails', () => {
    const base = sandbox()
    const directory = profile(base)

    const result = runInstaller(base, ['--profile=probe'], 'fail')

    expect(result.status).not.toBe(0)
    expect(readFileSync(join(directory, 'package.json'), 'utf8')).toBe(VICTIM)
    expect(readdirSync(directory).filter(name => name.includes('.tmp'))).toEqual([])
  })

  it('keeps exactly one backup across repeated runs', () => {
    const base = sandbox()
    const directory = profile(base)

    runInstaller(base, ['--profile=probe'], 'fail')
    runInstaller(base, ['--profile=probe'], 'fail')

    const backups = readdirSync(directory).filter(name => name.startsWith('package.json.bak'))
    expect(backups).toEqual(['package.json.bak'])
  })

  it('never writes a temporary manifest file next to the profile', () => {
    const base = sandbox()
    const directory = profile(base)

    runInstaller(base, ['--profile=probe'], 'fail')

    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})
