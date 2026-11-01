/**
 * NR-09 — permission state is read from a freshly compiled temp binary, not from the
 * process that dispatches input.
 *
 * permissions.ts:29-49 compiles native/PermissionPrompt.swift into the shared helper
 * cache and reports the JSON it prints. PermissionPrompt.swift:19 asks
 * AXIsProcessTrusted(), which macOS answers for *that binary*. The input path, however,
 * is dispatched by dsh-cua-native (a different binary, a different TCC subject) and the
 * run path checks capabilities.permissions from that helper (controller.ts:283-302).
 * Two independent answers to "is Accessibility granted", one of them about a throwaway file.
 *
 * NR-10 — hasPendingState() lets the controlled application choose to look busy.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { compileSwiftHelper } from '@albaincompleta/dsh-cu-core/helper-cache'
import { hasPendingState } from '../../../packages/dsh-computer-use-d1/src/controller.ts'

const roots: string[] = []

/** Remove every cache entry this file created, even when files run in parallel. */
async function removeProbeCaches(prefix: string): Promise<void> {
  const root = join(tmpdir(), 'dsh-cu-helper-cache')
  for (const entry of await readdir(root).catch(() => [] as string[])) {
    if (entry.startsWith(prefix)) await rm(join(root, entry), { recursive: true, force: true })
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  await removeProbeCaches('Nr09Prompt')
})

describe('NR-09 permission identity', () => {
  it('gives a one-comment source change a brand new TCC identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nr09-'))
    roots.push(root)
    const first = join(root, 'PermissionPrompt.swift')
    const second = join(root, 'PermissionPrompt2.swift')
    const body = [
      'import ApplicationServices',
      'import CoreGraphics',
      'print("accessibility=\\(AXIsProcessTrusted())")',
    ].join('\n')
    await writeFile(first, `${body}\n`)
    await writeFile(second, `${body}\n// a single added comment\n`)
    const a = await compileSwiftHelper([first], 'Nr09PromptA')
    const b = await compileSwiftHelper([second], 'Nr09PromptB')
    roots.push(dirname(a), dirname(b))
    // Different source text, different path. A grant made against either binary is
    // attached to that path in the TCC database and does not follow the next build.
    expect(a).not.toBe(b)
    expect(a).toContain('Nr09PromptA-')
    expect(b).toContain('Nr09PromptB-')
  })
})

describe('NR-10 app-controlled pending state', () => {
  it('treats any "loading/waiting" word in the AX tree as a pending operation', () => {
    // Words a normal application renders for reasons unrelated to this run.
    for (const tree of [
      '- [1] AXWindow "Support"\n  - [2] AXStaticText "Waiting for customer reply"',
      '- [1] AXWindow "CI"\n  - [2] AXStaticText "Build loading…"',
      '- [1] AXWindow "聊天"\n  - [2] AXStaticText "正在等待对方输入"',
      '- [1] AXWindow "Uploads"\n  - [2] AXStaticText "please wait"',
    ]) {
      expect(hasPendingState({ tree })).toBe(true)
    }
    // And a real spinner with no English verb is invisible to the heuristic.
    expect(hasPendingState({ tree: '- [1] AXWindow "Progress"\n  - [2] AXProgressIndicator' })).toBe(false)
  })
})
