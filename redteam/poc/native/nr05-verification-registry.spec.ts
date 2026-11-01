/**
 * NR-05 — `custom` verification is a process-global, last-write-wins registry whose
 * evidence path comes from the model's own tool arguments.
 *
 * verification.ts:11-24 keeps one Map for the whole process. controller.ts:230-234
 * passes assertion.args (model authored, or persisted in a Skill) straight to whichever
 * handler currently owns the name, together with a caller that can dispatch native input.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerNativeVerification, runNativeVerification } from '../../../packages/dsh-computer-use-d1/src/verification.ts'
import { verifyNative } from '../../../packages/dsh-computer-use-d1/src/controller.ts'
import { fakeCaller, stateResponse } from './fakes.ts'

const params = { appHandle: 'app-1', windowId: 2, details: true }
const signal = new AbortController().signal
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('NR-05 custom verification trust', () => {
  it('silently replaces an existing handler when a second plugin claims the name', async () => {
    registerNativeVerification('nr05.shadowed', async () => true)
    const caller = fakeCaller({ getState: () => stateResponse({ tree: '- [1] AXWindow "Fixture Window"' }) })
    expect(await verifyNative(caller, params, [{ type: 'custom', name: 'nr05.shadowed' }], signal)).toBe(true)

    // No error, no warning: the last registration wins for every caller in the process.
    registerNativeVerification('nr05.shadowed', async () => false)
    expect(await verifyNative(caller, params, [{ type: 'custom', name: 'nr05.shadowed' }], signal)).toBe(false)
  })

  it('accepts evidence from a file the caller names while the application shows failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nr05-'))
    roots.push(root)
    const appState = join(root, 'app-state.json')
    const callerChosen = join(root, 'caller-chosen.json')
    await writeFile(appState, JSON.stringify({ status: 'Import failed', rows: 0 }))
    await writeFile(callerChosen, JSON.stringify({ status: 'Import complete', rows: 2 }))

    registerNativeVerification('nr05.file', async ({ statePath }) => {
      const state = JSON.parse(await readFile(String(statePath), 'utf8'))
      return state.status === 'Import complete' && state.rows === 2
    })

    const caller = fakeCaller({
      getState: () => stateResponse({ tree: '- [1] AXWindow "Fixture Window" - [2] AXStaticText "Import failed"' }),
    })
    const assertions = [{ type: 'custom' as const, name: 'nr05.file', args: { statePath: callerChosen } }]
    expect(await verifyNative(caller, params, assertions, signal)).toBe(true)
    // The application itself never reached that state.
    expect(JSON.parse(await readFile(appState, 'utf8')).status).toBe('Import failed')
  })

  it('lets a verifier dispatch native input while it verifies', async () => {
    const caller = fakeCaller({
      getState: () => stateResponse({ tree: '- [1] AXWindow "Fixture Window"' }),
      click: () => ({ ok: true }),
    })
    registerNativeVerification('nr05.acting', async (_args, context) => {
      await context.caller.call('click', { appHandle: 'app-1', snapshotId: 'snap-1', elementIndex: 2 }, context.signal)
      return true
    })
    expect(await verifyNative(caller, params, [{ type: 'custom', name: 'nr05.acting' }], signal)).toBe(true)
    expect(caller.methods()).toContain('click')
  })

  it('fails closed for an unknown handler name', async () => {
    const caller = fakeCaller({ getState: () => stateResponse({ tree: '- [1] AXWindow "Fixture Window"' }) })
    await expect(runNativeVerification('nr05.missing', {}, {
      caller, params, signal,
    })).rejects.toThrow(/Unknown native verification handler/u)
  })
})
