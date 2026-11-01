/**
 * NR-06 — the Swift helper cache is a predictable path that is trusted without
 * ownership, signature or content verification.
 *
 * helper-cache.ts:44-48 derives the directory from an 8-hex-digit FNV-1a key over
 * the source text and returns `binary` whenever that path is executable. Anyone who
 * can write to this user's temp directory (any tool call, any npm postinstall, any
 * same-user process) decides what DSH executes next — including PermissionPrompt
 * and ControlIndicator, which run outside the approval gate.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { compileSwiftHelper } from '@albaincompleta/dsh-cu-core/helper-cache'

const execFileAsync = promisify(execFile)
const cacheRoot = join(tmpdir(), 'dsh-cu-helper-cache')
const probeName = 'RedTeamProbeNr06'
const planted: string[] = []

function fnv1a(data: Buffer | string): string {
  let hash = 0x811c9dc5
  for (const byte of typeof data === 'string' ? Buffer.from(data) : data) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Exact replica of helper-cache.ts sourceKey, so the PoC can pre-compute the path. */
async function cacheKey(sourcePath: string): Promise<string> {
  const content = await readFile(sourcePath)
  const parts = ['swiftc', process.platform, process.arch, `${sourcePath}:${content.length}:${fnv1a(content)}`]
  return fnv1a(Buffer.from(parts.join('\n'))).padStart(8, '0')
}

afterEach(async () => {
  for (const path of planted.splice(0)) await rm(path, { recursive: true, force: true })
  // Parallel test files can race the mkdtemp sandbox removal; sweep by prefix too.
  for (const entry of await readdir(cacheRoot).catch(() => [] as string[])) {
    if (entry.startsWith(probeName)) await rm(join(cacheRoot, entry), { recursive: true, force: true })
  }
})

describe('NR-06 helper cache trust boundary', () => {
  it('executes a planted binary instead of compiling the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nr06-'))
    const source = join(root, `${probeName}.swift`)
    await writeFile(source, 'print("real helper")\n')
    const directory = join(cacheRoot, `${probeName}-${await cacheKey(source)}`)
    const binary = join(directory, probeName)
    planted.push(root, directory)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(binary, '#!/bin/sh\necho PLANTED-HELPER\n')
    await chmod(binary, 0o700)

    const resolved = await compileSwiftHelper([source], probeName)
    expect(resolved).toBe(binary)
    const { stdout } = await execFileAsync(resolved, [])
    // The authored Swift source never ran; the planted shell script did.
    expect(stdout.trim()).toBe('PLANTED-HELPER')
  })

  it('does not fix the permissions of a cache root that already exists', async () => {
    // Redirect TMPDIR so the product's cache root starts from a known state, then let an
    // "attacker" create the world-writable root before the product ever runs.
    const sandbox = await mkdtemp(join(tmpdir(), 'nr06b-'))
    const fakeTmp = join(sandbox, 'tmp')
    await mkdir(fakeTmp, { recursive: true })
    const hostileRoot = join(fakeTmp, 'dsh-cu-helper-cache')
    await mkdir(hostileRoot, { recursive: true, mode: 0o777 })
    await chmod(hostileRoot, 0o777)
    const previous = process.env.TMPDIR
    process.env.TMPDIR = fakeTmp
    try {
      const source = join(sandbox, `${probeName}B.swift`)
      await writeFile(source, 'print("real helper")\n')
      planted.push(sandbox)
      await compileSwiftHelper([source], probeName)
      // mkdir({recursive:true, mode:0o700}) is a no-op on an existing directory: the
      // product happily published a helper into a root anyone can write.
      expect((await stat(hostileRoot)).mode & 0o777).toBe(0o777)
      planted.push(join(hostileRoot, `${probeName}-${await cacheKey(source)}`))
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
    }
  })

  it('keys the cache on compiler name and source length, never on compiler identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nr06c-'))
    const source = join(root, `${probeName}C.swift`)
    await writeFile(source, 'print("real helper")\n')
    planted.push(root)
    const resolved = await compileSwiftHelper([source], probeName)
    planted.push(dirname(resolved))
    // The directory name is exactly fnv1a(compiler + platform + arch + path + length + fnv1a(source)):
    // no compiler version, no compiler binary hash, no owner or signature participates.
    expect(resolved).toBe(join(cacheRoot, `${probeName}-${await cacheKey(source)}`, probeName))
    expect((await cacheKey(source))).toMatch(/^[0-9a-f]{8}$/u)
  })
})
