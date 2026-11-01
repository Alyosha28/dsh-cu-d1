import { describe, expect, it } from 'vitest'

import {
  evaluatePack,
  exportTargets,
  requiredFiles,
} from '../../../scripts/verify-dist.mts'
import {
  gate,
  internalDependencies,
  missingDependencies,
} from '../../../scripts/publish-packages.mts'

const WORKSPACE = new Set([
  '@albaincompleta/dsh-cu-core',
  '@albaincompleta/dsh-cu-browser-use-d1',
  '@albaincompleta/dsh-cu-computer-use-d1',
  '@albaincompleta/dsh-cu-client',
  '@albaincompleta/dsh-cu-bundle',
])

const CORE_MANIFEST = {
  name: '@albaincompleta/dsh-cu-core',
  version: '0.2.8',
  main: 'dist/index.js',
  types: 'dist/index.d.ts',
  exports: {
    '.': { types: './dist/index.d.ts', default: './dist/index.js' },
    './policy': { types: './dist/policy.d.ts', default: './dist/policy.js' },
    './package.json': './package.json',
  },
  files: ['dist', 'README.md'],
  scripts: { build: 'tsc -p tsconfig.json' },
}

const BUILT = ['dist/index.js', 'dist/index.d.ts', 'dist/policy.js', 'dist/policy.d.ts', 'README.md', 'package.json']
const packOf = (paths: string[]) => paths.map(path => ({ path }))

describe('SR-02 internal dependency gate', () => {
  it('sees every workspace dependency of the bundle, whatever the scope is called', () => {
    const bundle = {
      dependencies: {
        '@albaincompleta/dsh-cu-core': '0.2.8',
        '@albaincompleta/dsh-cu-client': '0.2.8',
        '@albaincompleta/dsh-cu-computer-use-d1': '0.2.8',
        '@albaincompleta/dsh-cu-browser-use-d1': '0.2.8',
        zod: '4.4.3',
      },
    }
    const internal = internalDependencies(bundle, WORKSPACE)
    expect(internal.map(([name]) => name).sort()).toEqual([
      '@albaincompleta/dsh-cu-browser-use-d1',
      '@albaincompleta/dsh-cu-client',
      '@albaincompleta/dsh-cu-computer-use-d1',
      '@albaincompleta/dsh-cu-core',
    ])
    expect(internal.map(([, version]) => version)).toEqual(['0.2.8', '0.2.8', '0.2.8', '0.2.8'])
  })

  it('recognises an internal dependency under any scope prefix', () => {
    const renamed = { dependencies: { '@renamed-scope/dsh-cu-core': '9.9.9' } }
    const workspace = new Set(['@renamed-scope/dsh-cu-core'])
    expect(internalDependencies(renamed, workspace)).toEqual([['@renamed-scope/dsh-cu-core', '9.9.9']])
  })

  it('does not treat third-party dependencies as internal', () => {
    const pkg = { dependencies: { zod: '4.4.3', '@deepseek-ai/dsh-cua': '0.2.1-rc.5' } }
    expect(internalDependencies(pkg, WORKSPACE)).toEqual([])
  })

  it('blocks a downstream package whose core is not on the registry', () => {
    const bundle = { dependencies: { '@albaincompleta/dsh-cu-core': '0.2.9', '@albaincompleta/dsh-cu-client': '0.2.9' } }
    const internal = internalDependencies(bundle, WORKSPACE)
    const resolved = new Set(['@albaincompleta/dsh-cu-client@0.2.9'])
    expect(missingDependencies(internal, resolved)).toEqual(['@albaincompleta/dsh-cu-core@0.2.9'])
    expect(() => gate(internal, resolved, 'to publish')).toThrow(/dsh-cu-core@0\.2\.9/)
  })

  it('lets core publish first because it has no internal dependency', () => {
    expect(internalDependencies({ dependencies: { zod: '4.4.3' } }, WORKSPACE)).toEqual([])
    expect(gate([], new Set(), 'to publish')).toBeUndefined()
  })

  it('lets a package with its dependencies present through', () => {
    const internal = internalDependencies({ dependencies: { '@albaincompleta/dsh-cu-core': '0.2.8' } }, WORKSPACE)
    const resolved = new Set(['@albaincompleta/dsh-cu-core@0.2.8'])
    expect(missingDependencies(internal, resolved)).toEqual([])
    expect(gate(internal, resolved, 'to publish')).toBeUndefined()
  })
})

describe('SR-01 publish gate', () => {
  it('reads every exports target', () => {
    expect(exportTargets(CORE_MANIFEST.exports).sort()).toEqual(
      ['dist/index.d.ts', 'dist/index.js', 'dist/policy.d.ts', 'dist/policy.js', 'package.json'],
    )
    expect(requiredFiles(CORE_MANIFEST).sort()).toEqual(
      ['dist/index.d.ts', 'dist/index.js', 'dist/policy.d.ts', 'dist/policy.js'],
    )
  })

  it('passes a built package whose tarball carries every target', () => {
    const problems = evaluatePack(CORE_MANIFEST, packOf(BUILT), path => BUILT.includes(path))
    expect(problems).toEqual([])
  })

  it('fails the empty package a clean checkout would publish', () => {
    const onDisk = (path: string) => path === 'README.md'
    const problems = evaluatePack(CORE_MANIFEST, packOf(['README.md', 'package.json']), onDisk)
    expect(problems).toContain('manifest target dist/index.js is missing on disk')
    expect(problems).toContain('npm pack would not include dist/index.js')
    expect(problems.some(problem => problem.startsWith('npm pack lists 2 files'))).toBe(true)
  })

  it('fails when dist exists but files[] leaves it out of the tarball', () => {
    const unshipped = { ...CORE_MANIFEST, files: ['README.md'] }
    const problems = evaluatePack(unshipped, packOf(['README.md', 'package.json', 'dist/extra.js']), path => BUILT.includes(path))
    expect(problems).toContain('npm pack would not include dist/index.js')
  })

  it('fails when a manifest target escapes the package directory', () => {
    const escaping = { ...CORE_MANIFEST, main: '../outside.js' }
    const problems = evaluatePack(escaping, packOf(BUILT), path => BUILT.includes(path))
    expect(problems).toContain('manifest target ../outside.js escapes the package directory')
  })

  it('fails a built package that depends on nothing checkable', () => {
    const shapeless = { name: 'x', version: '1.0.0' }
    const problems = evaluatePack(shapeless, packOf(BUILT), path => BUILT.includes(path))
    expect(problems).toContain('manifest declares no main/types/exports target, so nothing verifies a build')
  })
})
