import { spawn } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'


function fnv1a(data: Buffer): string {
  let hash = 0x811c9dc5
  for (const byte of data) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

async function sourceKey(sources: string[], compiler: string): Promise<string> {
  const parts: string[] = [compiler, process.platform, process.arch]
  for (const source of sources) {
    const content = await readFile(source)
    parts.push(`${source}:${content.length}:${fnv1a(content)}`)
  }
  return fnv1a(Buffer.from(parts.join('\n'))).padStart(8, '0')
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Compiles a Swift helper once per source build and reuses the binary across
 * Sessions and Agents. No cryptographic digest is needed for a local cache key.
 */
export async function compileSwiftHelper(
  sources: string[],
  name: string,
  compiler = 'swiftc',
): Promise<string> {
  const key = await sourceKey(sources, compiler)
  const cacheRoot = join(tmpdir(), 'dsh-cu-helper-cache')
  const cacheDirectory = join(cacheRoot, `${name}-${key}`)
  const binary = join(cacheDirectory, name)
  if (await executable(binary)) return binary

  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  const buildDirectory = await mkdtemp(join(cacheRoot, `.build-${name}-`))
  const temporaryBinary = join(buildDirectory, name)
  try {
    const child = spawn(compiler, [...sources, '-o', temporaryBinary], { stdio: 'ignore' })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    if (code !== 0) throw new Error(`${name.replace(/([a-z])([A-Z])/gu, '$1_$2').toLowerCase()}_compilation_failed`)
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 })
    await rename(temporaryBinary, binary).catch(async error => {
      if (!await executable(binary)) throw error
    })
    await chmod(binary, 0o700)
    return binary
  } finally {
    await rm(buildDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}
