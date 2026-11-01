/**
 * NR-02 / NR-08 — indicator lifecycle holes.
 *
 *  NR-02: the shipped helper clears its own state when the user dismisses the panel
 *         (ControlIndicator.swift:265-269) and emits no event, so the Node side keeps
 *         `runId` and keeps dispatching input with no cursor and no visible panel.
 *  NR-08: a single non-JSON stdout line takes down the host process (indicator.ts:123),
 *         and helper loss kills an otherwise healthy run instead of degrading.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { NativeControlIndicator } from '../../../packages/dsh-computer-use-d1/src/indicator.ts'

const helperPath = fileURLToPath(new URL('./fixtures/fake-indicator.mjs', import.meta.url))
const target = { pid: 4711, windowId: 2, title: 'Fixture Window', appName: 'Fixture' }
let root: string
let statePath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nr02-'))
  statePath = join(root, 'helper-state.jsonl')
  process.env.NR_STATE = statePath
})

afterEach(async () => {
  delete process.env.NR_STATE
  delete process.env.NR_MODE
  await rm(root, { recursive: true, force: true })
})

async function helperView(): Promise<Array<{ type: string; runId: string | null }>> {
  return (await readFile(statePath, 'utf8'))
    .split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; runId: string | null })
}

describe('NR-02 indicator dismissal desync', () => {
  it('keeps the run alive after the indicator is dismissed', async () => {
    const indicator = await NativeControlIndicator.create(helperPath, () => {}, () => {})
    try {
      await indicator.start(randomUUID(), target)
      expect(indicator.pid).toBeTypeOf('number')
      await indicator.dismiss()
      await new Promise(resolve => setTimeout(resolve, 100))
      // The helper dropped the run: no panel, no cursor, nothing on screen.
      const view = await helperView()
      const last = view.at(-1)!
      expect(last.type).toBe('dismiss')
      expect(last.runId).toBeNull()
      // The controller still believes the run is indicated: activity is accepted, no
      // error, no restart, no stop. From here every native action is invisible.
      await expect(indicator.activity({ phase: 'acting', operation: 'CLICK' })).resolves.toBeUndefined()
      const after = await helperView()
      expect(after.at(-1)!.runId).toBeNull()
    } finally {
      await indicator.close()
    }
  })

  it('reports no error when finish races a dismissed indicator', async () => {
    const indicator = await NativeControlIndicator.create(helperPath, () => {}, () => {})
    try {
      await indicator.start(randomUUID(), target)
      await indicator.dismiss()
      await expect(indicator.finish({ status: 'success', reason: 'independently_verified' })).resolves.toBeUndefined()
      // Nothing in the protocol tells the caller the indicator was already gone.
      expect((await helperView()).filter(line => line.type === 'finish')).toHaveLength(0)
    } finally {
      await indicator.close()
    }
  })
})

describe('NR-08 indicator availability', () => {
  it('turns one malformed helper line into an uncaught exception', async () => {
    process.env.NR_MODE = 'garbage'
    const fatal: unknown[] = []
    const onFatal = (error: unknown): void => { fatal.push(error) }
    process.on('uncaughtException', onFatal)
    const indicator = await NativeControlIndicator.create(helperPath, () => {}, () => {})
    try {
      await indicator.start(randomUUID(), target)
      await new Promise(resolve => setTimeout(resolve, 100))
    } finally {
      process.off('uncaughtException', onFatal)
      await indicator.close()
    }
    expect(fatal).toHaveLength(1)
    expect(String(fatal[0])).toMatch(/JSON|Unexpected|token/u)
  })

  it('kills the run when the helper disappears instead of degrading', async () => {
    process.env.NR_MODE = 'dies-after-start'
    let unavailable = 0
    const indicator = await NativeControlIndicator.create(helperPath, () => {}, () => { unavailable += 1 })
    try {
      await indicator.start(randomUUID(), target)
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(unavailable).toBeGreaterThan(0)
      await expect(indicator.activity({ phase: 'acting', operation: 'CLICK' }))
        .rejects.toThrow(/native_indicator_not_running/u)
    } finally {
      await indicator.close()
    }
  })
})
