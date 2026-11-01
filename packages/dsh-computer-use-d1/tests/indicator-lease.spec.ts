/**
 * NR-02 / NR-08: the indicator is a lease, not a decoration.
 *
 * These tests drive the shipped `NativeControlIndicator` against a protocol
 * double so they are deterministic without a GUI, Accessibility permission, or
 * a compiled AppKit helper.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  NativeControlIndicator, NoopNativeIndicator, type IndicatorUnavailableReason,
} from '../src/indicator.ts'

const helperPath = fileURLToPath(new URL('./helpers/lease-helper.mjs', import.meta.url))
const target = { pid: 4711, windowId: 2, title: 'Fixture Window', appName: 'Fixture' }

let root: string
let reasonLog: IndicatorUnavailableReason[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'indicator-lease-'))
  process.env.LEASE_STATE = join(root, 'state.jsonl')
  reasonLog = []
})

afterEach(async () => {
  delete process.env.LEASE_STATE
  delete process.env.LEASE_MODE
  await rm(root, { recursive: true, force: true })
})

async function state(): Promise<Array<{ type: string; runId: string | null }>> {
  const path = process.env.LEASE_STATE!
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { type: string; runId: string | null })
}

async function indicator(): Promise<NativeControlIndicator> {
  return NativeControlIndicator.create(helperPath, () => undefined, reason => { reasonLog.push(reason) })
}

describe('NR-02 indicator lease', () => {
  it('revokes the run when the helper reports the window is no longer shown', async () => {
    process.env.LEASE_MODE = 'offscreen'
    const lease = await indicator()
    try {
      await lease.start(randomUUID(), target)
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(reasonLog).toEqual(['window_offscreen'])
      // Fail closed: the run can no longer claim a visible indicator.
      await expect(lease.activity({ phase: 'acting', operation: 'CLICK' }))
        .rejects.toThrow(/native_indicator_unavailable: window_offscreen/u)
      // And the reason is reported exactly once, not once per activity.
      expect(reasonLog).toHaveLength(1)
    } finally {
      await lease.close()
    }
  })

  it('treats a dismissed panel as a lost indicator instead of a quiet hide', async () => {
    process.env.LEASE_MODE = 'dismiss'
    const lease = await indicator()
    try {
      await lease.start(randomUUID(), target)
      await lease.dismiss()
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(reasonLog).toEqual(['panel_dismissed'])
      await expect(lease.activity({ phase: 'verifying' }))
        .rejects.toThrow(/native_indicator_unavailable: panel_dismissed/u)
    } finally {
      await lease.close()
    }
  })

  it('fails closed when activity is reported with no live visible run', async () => {
    const lease = await indicator()
    try {
      await expect(lease.activity({ phase: 'observing' })).rejects.toThrow(/native_indicator_not_running/u)
      await lease.start(randomUUID(), target)
      await lease.finish({ status: 'success', reason: 'independently_verified' })
      await expect(lease.activity({ phase: 'observing' })).rejects.toThrow(/native_indicator_not_running/u)
    } finally {
      await lease.close()
    }
  })

  it('resets the lease for the next run after a loss', async () => {
    process.env.LEASE_MODE = 'offscreen'
    const lease = await indicator()
    try {
      await lease.start(randomUUID(), target)
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(reasonLog).toHaveLength(1)
      delete process.env.LEASE_MODE
      await lease.start(randomUUID(), target)
      await expect(lease.activity({ phase: 'acting', operation: 'CLICK' })).resolves.toBeUndefined()
    } finally {
      await lease.close()
    }
  }, 15000)
})

describe('NR-08 indicator robustness', () => {
  it('drops a non-JSON helper line instead of killing the host process', async () => {
    process.env.LEASE_MODE = 'garbage'
    const fatal: unknown[] = []
    const onFatal = (error: unknown): void => { fatal.push(error) }
    process.on('uncaughtException', onFatal)
    const lease = await indicator()
    try {
      await lease.start(randomUUID(), target)
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(fatal).toEqual([])
      await expect(lease.activity({ phase: 'acting', operation: 'CLICK' })).resolves.toBeUndefined()
    } finally {
      process.off('uncaughtException', onFatal)
      await lease.close()
    }
  })

  it('maps helper exit to a structured unavailable reason', async () => {
    process.env.LEASE_MODE = 'die'
    const lease = await indicator()
    try {
      await lease.start(randomUUID(), target)
      for (let attempt = 0; attempt < 40 && reasonLog.length === 0; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(reasonLog).toEqual(['helper_exited'])
      await expect(lease.activity({ phase: 'acting', operation: 'CLICK' }))
        .rejects.toThrow(/native_indicator_unavailable: helper_exited/u)
      expect((await state()).some(line => line.type === 'start')).toBe(true)
    } finally {
      await lease.close()
    }
  })

  it('marks a degraded indicator instead of pretending a cursor exists', () => {
    const noop = new NoopNativeIndicator('native_indicator_compilation_failed')
    expect(noop.degraded).toEqual({ reason: 'native_indicator_compilation_failed' })
    expect(new NoopNativeIndicator().degraded.reason).toBe('native_indicator_unavailable')
  })
})
