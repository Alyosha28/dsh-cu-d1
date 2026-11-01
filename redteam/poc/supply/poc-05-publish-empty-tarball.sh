#!/usr/bin/env bash
# SR-01: `dist/` is gitignored and no package declares prepublishOnly/prepare,
# so `npm publish --workspace ...` (what scripts/publish-packages.mts runs) has
# no build step and no dist check. Publishing from a clean checkout produces a
# package whose `main`/`exports` point at files that do not exist.
set -u
REPO=/Users/albaincompleta/DSH_CU
T=$(mktemp -d /tmp/sr-pack.XXXXXX)
git -C "$REPO" archive HEAD packages/dsh-cu-core | tar -x -C "$T"
echo "== what a fresh clone has (git archive HEAD) =="
find "$T/packages/dsh-cu-core" -maxdepth 1 -type d | sed "s|$T|T|"
echo
echo "== lifecycle hooks declared by the package =="
node -e "const p=require('$T/packages/dsh-cu-core/package.json');console.log('scripts:',JSON.stringify(p.scripts));console.log('main:',p.main)"
echo
echo "== npm pack --dry-run in that checkout =="
cd "$T/packages/dsh-cu-core" || exit 1
npm pack --dry-run 2>&1 | grep -E "Tarball Contents|README.md|package.json|total files|unpacked size"
echo
echo "== same command inside the built repo =="
cd "$REPO" || exit 1
npm pack --dry-run -w @albaincompleta/dsh-cu-core 2>&1 | grep -E "total files|unpacked size"
echo
echo "== publish script has no build/verify step =="
grep -n "npm(\['publish'\|npm run build\|dist" scripts/publish-packages.mts || echo "  (no build, no dist check in publish-packages.mts)"
