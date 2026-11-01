#!/usr/bin/env bash
# SR-03b: publish-packages.mts writes the npm token to a world-listable temp
# path (mode 0600) and removes it in a `finally` block that process.exit()
# bypasses. Every failure path calls fail() -> process.exit(1), so the token
# file survives the run, and a SIGINT leaves it too.
#
# The token used here is a placeholder string; nothing is published because the
# script is invoked without --publish.
set -u
REPO=/Users/albaincompleta/DSH_CU
PROBE_TOKEN="npm_PLACEHOLDER_$(date +%s)_aaaaaaaaaaaaaaaaaaaa"
before=$(ls /tmp/dsh-cu-npmrc-* 2>/dev/null | wc -l | tr -d ' ')
cd "$REPO" || exit 1
echo "== run: NPM_TOKEN=<placeholder> node scripts/publish-packages.mts  (no --publish) =="
NPM_TOKEN="$PROBE_TOKEN" node scripts/publish-packages.mts 2>&1 | head -5
echo "exit=$?"
echo
echo "== leftover token files in \$TMPDIR (/tmp) =="
ls -l /tmp/dsh-cu-npmrc-* 2>/dev/null | tail -5
for f in /tmp/dsh-cu-npmrc-*; do
  [ -f "$f" ] || continue
  if grep -q "$PROBE_TOKEN" "$f" 2>/dev/null; then
    echo "LEAK: $f still holds the placeholder token:"
    sed 's/\(_authToken=\).*/\1<redacted-but-present>/' "$f"
  fi
done
echo "files before=$before after=$(ls /tmp/dsh-cu-npmrc-* 2>/dev/null | wc -l | tr -d ' ')"
