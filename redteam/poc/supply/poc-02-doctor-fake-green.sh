#!/usr/bin/env bash
# SR-03: plugin-doctor only parses `dsh --dump-config`, which renders a bundle's
# cordis.patch.yml without resolving the plugin packages it names. A profile
# whose node_modules holds the bundle but NOT the providers therefore composes
# the same 6 rows, and the doctor prints `doctor: ok` with exit 0 - while the
# profile cannot import @albaincompleta/dsh-cu-browser-use-d1 at boot.
set -u
REPO=/Users/albaincompleta/DSH_CU
T=$(mktemp -d /tmp/sr-doctor-green.XXXXXX)
mkdir -p "$T/profiles/probe/node_modules/@albaincompleta"
ln -s "$REPO/packages/dsh-cu-bundle" "$T/profiles/probe/node_modules/@albaincompleta/dsh-cu-bundle"
cat > "$T/profiles/probe/package.json" <<JSON
{
  "name": "probe-profile",
  "dependencies": { "@albaincompleta/dsh-cu-bundle": "link:$REPO/packages/dsh-cu-bundle" },
  "dsh": { "profile": { "bundles": ["@albaincompleta/dsh-cu-bundle"] } }
}
JSON
echo "== installed under node_modules =="
find "$T/profiles/probe/node_modules" -maxdepth 3 -name 'dsh-cu*' -o -maxdepth 3 -name 'dsh-browser*' | sed "s|$T|T|"
echo
echo "== provider package really absent? =="
node -e "try{console.log(require.resolve('@albaincompleta/dsh-cu-browser-use-d1',{paths:['$T/profiles/probe']}))}catch(e){console.log('UNRESOLVABLE: '+e.code)}"
echo
echo "== doctor verdict =="
cd "$REPO" || exit 1
DSH_HOME="$T" DSH_BIN="$REPO/node_modules/.bin/dsh" node scripts/plugin-doctor.mts --profile=probe
echo "exit=$?"
