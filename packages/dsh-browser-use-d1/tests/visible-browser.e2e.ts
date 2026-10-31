import { expect, it } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { PreviewBrowserIndicator } from '../src/preview.ts'
import { BrowserDom } from '../src/dom.ts'
import type { ControlAction } from '@dsh-cu/core/activity'
import { CHROME } from './fixtures.ts'

const execFileAsync = promisify(execFile)
const ROOT = join(import.meta.dirname, '../../..')

async function compile(source: string, destination: string): Promise<void> {
  const child = spawn('swiftc', [source, '-o', destination], { stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`swiftc_exited_${code}`)))
  })
}

it('shows live Browser control in a visible preview without moving foreground or the system pointer', { timeout: 120000 }, async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-browser-preview-e2e-'))
  const foregroundBinary = join(temporaryRoot, 'ForegroundControl')
  const inventoryBinary = join(temporaryRoot, 'WindowInventory')
  const pressBinary = join(temporaryRoot, 'PressControl')
  let browser: Browser | undefined
  let indicator: PreviewBrowserIndicator | undefined
  try {
    await Promise.all([
      compile(join(ROOT, 'fixtures/native/ForegroundControl.swift'), foregroundBinary),
      compile(join(ROOT, 'fixtures/native/WindowInventory.swift'), inventoryBinary),
      compile(join(ROOT, 'fixtures/native/PressControl.swift'), pressBinary),
    ])
    const foreground = async (): Promise<number> => Number((await execFileAsync(foregroundBinary, ['frontmost'])).stdout.trim())
    const pointer = async (): Promise<string> => (await execFileAsync(foregroundBinary, ['pointer'])).stdout.trim()
    const initialForeground = await foreground()
    const initialPointer = await pointer()
    browser = await chromium.launch({ executablePath: CHROME, headless: true })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.setContent('<title>Controlled preview</title><button>Visible background action</button>')
    const actions: ControlAction[] = []
    indicator = await PreviewBrowserIndicator.create(page, action => actions.push(action))
    await indicator.start(randomUUID())
    await expect.poll(() => foreground()).toBe(initialForeground)
    expect(await pointer()).toBe(initialPointer)
    const previewPid = indicator.pid!
    const inventory = async (): Promise<Array<{ isOnscreen: boolean; bounds: { width: number; height: number } }>> => JSON.parse(
      (await execFileAsync(inventoryBinary, [String(previewPid)])).stdout,
    )
    await expect.poll(async () => (await inventory()).some(record => record.isOnscreen && record.bounds.width === 960)).toBe(true)

    const dom = new BrowserDom(page, 60, indicator)
    const snapshot = await dom.snapshot()
    await dom.execute(snapshot, { operation: 'CLICK', target: snapshot.elements[0].id }, 1000)
    await expect.poll(() => page.locator('[data-dsh-cu-control]').count()).toBe(1)
    await expect.poll(() => page.locator('[data-dsh-cu-control]').getAttribute('data-dsh-cu-operation')).toBe('CLICK')
    expect(await foreground()).toBe(initialForeground)
    expect(await pointer()).toBe(initialPointer)

    await indicator.finish()
    await expect.poll(async () => (await inventory()).some(record => record.isOnscreen)).toBe(false)
    await indicator.start(randomUUID())
    await indicator.finish({ status: 'success', reason: 'independently_verified', route: 'd1' })
    await expect.poll(async () => (await inventory()).some(record => record.isOnscreen)).toBe(true)
    await execFileAsync(pressBinary, [String(previewPid), '关闭'])
    await expect.poll(async () => (await inventory()).some(record => record.isOnscreen)).toBe(false)
    for (const [title, action] of [['暂停', 'pause'], ['停止', 'stop'], ['接管', 'takeover']] as const) {
      await indicator.start(randomUUID())
      await execFileAsync(pressBinary, [String(previewPid), title])
      await expect.poll(() => actions).toContain(action)
      await indicator.finish()
      expect(await foreground()).toBe(initialForeground)
    }
    const actionCount = actions.length
    await indicator.start(randomUUID())
    process.kill(previewPid, 'SIGKILL')
    await expect.poll(() => actions.length).toBeGreaterThan(actionCount)
    expect(actions.at(-1)).toBe('stop')
    await expect.poll(async () => (await inventory()).some(record => record.isOnscreen)).toBe(false)
    expect(await foreground()).toBe(initialForeground)
  } finally {
    await indicator?.close()
    await browser?.close()
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
