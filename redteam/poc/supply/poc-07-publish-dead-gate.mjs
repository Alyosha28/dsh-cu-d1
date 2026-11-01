#!/usr/bin/env node
// SR-02: publish-packages.mts gates publication on "every internal dependency is
// already on the registry" but selects internal dependencies with
// `dependency.startsWith('@dsh-cu/')`. The packages were renamed to
// `@albaincompleta/dsh-cu-*` (commit 89550a9), so the predicate matches nothing:
// `missing` is always empty and the gate can never fire.
//
// Read-only: reads the manifests and prints what the predicate sees.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '')
const ORDER = ['dsh-cu-core', 'dsh-browser-use-d1', 'dsh-computer-use-d1', 'dsh-cu-client', 'dsh-cu-bundle']
const PREFIX = '@dsh-cu/' // copied verbatim from scripts/publish-packages.mts:65

let internal = 0
let matched = 0
for (const name of ORDER) {
  const pkg = JSON.parse(await readFile(join(ROOT, 'packages', name, 'package.json'), 'utf8'))
  const deps = Object.entries(pkg.dependencies ?? {}).filter(([dep]) => dep.includes('dsh-cu-') || dep.startsWith('@albaincompleta/'))
  for (const [dep, version] of deps) {
    internal += 1
    const seen = dep.startsWith(PREFIX)
    if (seen) matched += 1
    console.log(`${seen ? 'GATED ' : 'ungated'}  ${pkg.name} -> ${dep}@${version}`)
  }
}
console.log(`\ninternal-looking dependencies: ${internal}`)
console.log(`matched by the script's prefix filter (${JSON.stringify(PREFIX)}): ${matched}`)
console.log(matched === 0 ? 'RESULT: the registry-existence gate is dead code; --publish proceeds regardless.' : 'RESULT: gate is live.')
