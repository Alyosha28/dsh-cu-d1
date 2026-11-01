#!/usr/bin/env bash
# SR-05: scripts/install-plugin.mts resolves --profile against DSH_HOME with
# resolve() and no containment check, so `../` escapes ~/.dsh/profiles and the
# script rewrites an unrelated project's package.json (adds dsh.profile.bundles).
#
# Read-only w.r.t. the repo: everything happens under /tmp.
# DSH_BIN=/usr/bin/true stands in for the dsh CLI so `dsh plugin add` is a no-op;
# the write under test is the script's own manifest patch, not the CLI's.
set -u
REPO=/Users/albaincompleta/DSH_CU
BASE=$(mktemp -d /tmp/sr-trav.XXXXXX)
mkdir -p "$BASE/dsh/profiles/unused" "$BASE/victimproj"
cat > "$BASE/victimproj/package.json" <<'JSON'
{
  "name": "unrelated-user-project",
  "version": "3.1.4",
  "scripts": { "postinstall": "node build.js" }
}
JSON
echo "== victim manifest BEFORE =="
cat "$BASE/victimproj/package.json"
echo
echo "== run: install-plugin --profile=../../victimproj  (DSH_HOME=$BASE/dsh) =="
cd "$REPO" || exit 1
DSH_HOME="$BASE/dsh" DSH_BIN=/usr/bin/true node scripts/install-plugin.mts --profile=../../victimproj 2>&1 | head -12
echo
echo "== victim manifest AFTER =="
cat "$BASE/victimproj/package.json"
echo
echo "== files the installer left in the victim directory =="
ls -1 "$BASE/victimproj"
