#!/bin/bash
# NR-07 — baseline reproduction for the 7 red tests in @albaincompleta/dsh-cu-computer-use-d1.
#
# Read-only with respect to packages/** and src/**: the only writes are the helper
# cache that the product itself creates, a symlink tree under /tmp/dsh-official-alpha2
# (created and removed here), and redteam/poc/native/out/.
#
# Usage: bash redteam/poc/native/baseline.sh
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$ROOT/redteam/poc/native/out"
HELPER="/tmp/dsh-official-alpha2/packages/experimental/cua-macos/native/.build/release/dsh-cua-native"
BUILD="$ROOT/node_modules/@deepseek-ai/dsh-experimental-cua-macos/native"
SCRATCH="${TMPDIR:-/tmp}/red-native-helper-build"
mkdir -p "$OUT"

section() { printf '\n===== %s =====\n' "$1"; }

section "1. host permissions (AX and screen recording, as seen by a fresh binary)"
cat > "$OUT/axprobe.swift" <<'SWIFT'
import ApplicationServices
import CoreGraphics
import Foundation
let ax = AXIsProcessTrusted()
let sr = CGPreflightScreenCaptureAccess()
print("accessibility=\(ax) screenRecording=\(sr) guiSession=\(CGSessionCopyCurrentDictionary() != nil)")
SWIFT
swiftc "$OUT/axprobe.swift" -o "$OUT/axprobe" 2>/dev/null && "$OUT/axprobe"

section "2. the helper path the suite hard-codes (tests/fixtures.ts:9)"
ls -l "$HELPER" 2>&1 || true
echo "swiftc: $(command -v swiftc || echo missing)"
echo "node:   $(node -v)"

section "3. baseline test run"
( cd "$ROOT" && npm test --workspace @albaincompleta/dsh-cu-computer-use-d1 2>&1 ) | tee "$OUT/baseline-test.log" | grep -E "✓ |× |Tests  |FAIL " || true

section "4. negative control: helper present, Accessibility not granted"
if [ ! -x "$SCRATCH/release/dsh-cua-native" ]; then
  echo "building dsh-cua-native from node_modules (offline, no remote dependencies)"
  swift build --package-path "$BUILD" --scratch-path "$SCRATCH" -c release --product dsh-cua-native 2>&1 | tail -3
fi
if [ -x "$SCRATCH/release/dsh-cua-native" ]; then
  mkdir -p "$(dirname "$HELPER")"
  ln -sf "$SCRATCH/release/dsh-cua-native" "$HELPER"
  echo "linked: $(readlink "$HELPER")"
  ( cd "$ROOT" && npx vitest run --root packages/dsh-computer-use-d1 tests/multiwindow.spec.ts tests/visual.spec.ts 2>&1 ) | tee "$OUT/negative-control.log" | grep -E "✓ |× |Tests  |AssertionError|accessibility|status|reason" | head -30
  rm -f "$HELPER"
  rm -rf /tmp/dsh-official-alpha2
  echo "removed the symlink tree"
else
  echo "build unavailable; negative control skipped"
fi

section "5. left-over helper processes after the runs"
pgrep -fl "dsh-cua-native|ControlIndicator|BrowserPreview|PermissionPrompt" || echo "none"
ls -la /tmp/dsh-cua-* 2>/dev/null || echo "no /tmp/dsh-cua-* runtime directory"
echo
echo "logs: $OUT/baseline-test.log $OUT/negative-control.log"
