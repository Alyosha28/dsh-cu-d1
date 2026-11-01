#!/usr/bin/env bash
# Acceptance harness for the red/blue exercise.
# Usage: bash redteam/verify.sh [--skip-build]
# Exit code 0 only when the build and every workspace test suite pass.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2
SKIP_BUILD=0
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=1

fail=0
if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "== build =="
  if npm run build >/tmp/verify-build.log 2>&1; then
    echo "build: PASS"
  else
    echo "build: FAIL (see /tmp/verify-build.log)"
    tail -20 /tmp/verify-build.log
    fail=1
  fi
fi

# "dir:package" — directory name and npm workspace name differ for the providers.
for entry in dsh-cu-core:dsh-cu-core dsh-browser-use-d1:dsh-cu-browser-use-d1 \
             dsh-computer-use-d1:dsh-cu-computer-use-d1 dsh-cu-client:dsh-cu-client \
             dsh-cu-bundle:dsh-cu-bundle; do
  ws="${entry%%:*}"
  pkgName="${entry##*:}"
  pkg="packages/$ws"
  [ -d "$pkg" ] || continue
  log="/tmp/verify-$ws.log"
  npm test --workspace "@albaincompleta/$pkgName" >"$log" 2>&1
  code=$?
  line=$(grep -E "^ +Tests +" "$log" | tail -1)
  if [ $code -eq 0 ]; then
    echo "$ws: PASS ${line:-}"
  else
    echo "$ws: FAIL ${line:-}"
    grep -E "FAIL |AssertionError|Error:" "$log" | head -12
    fail=1
  fi
done

if [ -d .venv ] && [ -x .venv/bin/python ]; then
  echo "== python tests =="
  if .venv/bin/python -m pytest -q >/tmp/verify-pytest.log 2>&1; then
    echo "pytest: PASS $(tail -1 /tmp/verify-pytest.log)"
  else
    echo "pytest: FAIL"
    tail -15 /tmp/verify-pytest.log
    fail=1
  fi
fi

echo "== result: $([ $fail -eq 0 ] && echo GREEN || echo RED) =="
exit $fail
