import { expect, it } from 'vitest'
import { spawn, execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { NativeControlIndicator } from '../src/indicator.ts'
import type { ControlAction } from '@alyosha28/dsh-cu-core/activity'
import { ROOT } from './fixtures.ts'

const execFileAsync = promisify(execFile)

interface WindowRecord {
  windowId: number
  bounds: { x: number; y: number; width: number; height: number }
  isOnscreen: boolean
  layer: number
  sharingState: number
}

async function compile(source: string, destination: string): Promise<void> {
  const child = spawn('swiftc', [source, '-o', destination], { stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`swiftc_exited_${code}`)))
  })
}

async function ready(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve())
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`fixture_exited_${code}`)))
  })
}

it('keeps native indicators visible without changing foreground and removes them on finish and disconnect', { timeout: 120000 }, async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-indicator-e2e-'))
  const fixtureBinary = join(temporaryRoot, 'WorkflowFixture')
  const foregroundBinary = join(temporaryRoot, 'ForegroundControl')
  const inventoryBinary = join(temporaryRoot, 'WindowInventory')
  const pressBinary = join(temporaryRoot, 'PressControl')
  let target: ChildProcess | undefined
  let anchor: ChildProcess | undefined
  let indicator: NativeControlIndicator | undefined
  try {
    await Promise.all([
      compile(join(ROOT, 'fixtures/native/WorkflowFixture.swift'), fixtureBinary),
      compile(join(ROOT, 'fixtures/native/ForegroundControl.swift'), foregroundBinary),
      compile(join(ROOT, 'fixtures/native/WindowInventory.swift'), inventoryBinary),
      compile(join(ROOT, 'fixtures/native/PressControl.swift'), pressBinary),
    ])
    target = spawn(fixtureBinary, [join(temporaryRoot, 'target.json')], { stdio: ['ignore', 'pipe', 'ignore'] })
    await ready(target)
    anchor = spawn(fixtureBinary, [join(temporaryRoot, 'anchor.json')], { stdio: ['ignore', 'pipe', 'ignore'] })
    await ready(anchor)
    await delay(100)
    const targetState = JSON.parse(await readFile(join(temporaryRoot, 'target.json'), 'utf8')) as {
      windowId: number
      buttonPoint: [number, number]
    }
    const foreground = async (): Promise<number> => Number((await execFileAsync(foregroundBinary, ['frontmost'])).stdout.trim())
    const inventory = async (pid: number): Promise<WindowRecord[]> => JSON.parse(
      (await execFileAsync(inventoryBinary, [String(pid)])).stdout,
    ) as WindowRecord[]
    const initialForeground = await foreground()
    expect(initialForeground).toBe(anchor.pid)
    const targetWindow = (await inventory(target.pid!)).find(record => record.windowId === targetState.windowId && record.isOnscreen)
    expect(targetWindow).toBeDefined()
    const controls: ControlAction[] = []
    let unavailable = 0
    indicator = await NativeControlIndicator.create(undefined, action => controls.push(action), () => { unavailable += 1 })
    await indicator.start(randomUUID(), {
      pid: target.pid!,
      windowId: targetState.windowId,
      title: 'DSH Workflow Fixture',
      bounds: targetWindow!.bounds,
    })
    await delay(120)
    expect(await foreground()).toBe(initialForeground)
    const helperPid = indicator.pid!
    let panels = (await inventory(helperPid)).filter(record => record.isOnscreen)
    expect(panels.map(record => [record.bounds.width, record.bounds.height])).toEqual([[360, 116]])
    expect(panels.every(record => record.sharingState === 0)).toBe(true)

    const point = {
      x: targetWindow!.bounds.x + targetState.buttonPoint[0],
      y: targetWindow!.bounds.y + targetState.buttonPoint[1],
    }
    await indicator.activity({ phase: 'acting', operation: 'CLICK', point })
    await delay(120)
    panels = (await inventory(helperPid)).filter(record => record.isOnscreen)
    expect(panels).toHaveLength(2)
    const cursor = panels.find(record => record.bounds.width === 52 && record.bounds.height === 52)
    expect(cursor).toBeDefined()
    expect(cursor!.bounds.x).toBeCloseTo(point.x - 10, 0)
    expect(cursor!.bounds.y).toBeCloseTo(point.y - 9, 0)
    expect(panels.every(record => record.sharingState === 0)).toBe(true)
    expect(await foreground()).toBe(initialForeground)

    await indicator.finish()
    await delay(120)
    expect((await inventory(helperPid)).filter(record => record.isOnscreen)).toEqual([])
    expect(await foreground()).toBe(initialForeground)

    await indicator.start(randomUUID(), {
      pid: target.pid!, windowId: targetState.windowId, title: 'DSH Workflow Fixture', bounds: targetWindow!.bounds,
    })
    await indicator.finish({ status: 'success', reason: 'independently_verified', route: 'd1' })
    await delay(120)
    const resultPanels = (await inventory(helperPid)).filter(record => record.isOnscreen)
    expect(resultPanels.map(record => [record.bounds.width, record.bounds.height])).toEqual([[360, 116]])
    await execFileAsync(pressBinary, [String(helperPid), '关闭'])
    await delay(120)
    expect((await inventory(helperPid)).filter(record => record.isOnscreen)).toEqual([])

    for (const [title, action] of [['暂停', 'pause'], ['停止', 'stop'], ['接管', 'takeover']] as const) {
      await indicator.start(randomUUID(), {
        pid: target.pid!, windowId: targetState.windowId, title: 'DSH Workflow Fixture', bounds: targetWindow!.bounds,
      })
      await delay(50)
      await execFileAsync(pressBinary, [String(helperPid), title])
      await expect.poll(() => controls).toContain(action)
      await indicator.finish()
      expect(await foreground()).toBe(initialForeground)
    }

    await indicator.start(randomUUID(), {
      pid: target.pid!, windowId: targetState.windowId, title: 'DSH Workflow Fixture', bounds: targetWindow!.bounds,
    })
    process.kill(helperPid, 'SIGKILL')
    await expect.poll(() => unavailable).toBe(1)
    expect((await inventory(helperPid)).filter(record => record.isOnscreen)).toEqual([])
    expect(controls).toEqual(['pause', 'stop', 'takeover'])
  } finally {
    await indicator?.close()
    target?.kill('SIGTERM')
    anchor?.kill('SIGTERM')
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
