import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { compileSwiftHelper } from '@alyosha28/dsh-cu-core/helper-cache'
import { ROOT } from './fixtures.ts'

interface HelperEvent {
  type: string
  runId?: string
  visible?: boolean
}

async function waitFor(events: HelperEvent[], predicate: (event: HelperEvent) => boolean, timeoutMs: number): Promise<HelperEvent> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = events.find(predicate)
    if (found !== undefined) return found
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`helper event missing: ${JSON.stringify(events)}`)
}

it('shows a menu-bar indicator for the run and hides it on finish', { timeout: 120000 }, async () => {
  const binary = await compileSwiftHelper([
    join(ROOT, 'packages/dsh-computer-use-d1/native/CursorView.swift'),
    join(ROOT, 'packages/dsh-computer-use-d1/native/ControlIndicator.swift'),
  ], 'ControlIndicator')

  const child: ChildProcess = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'] })
  const events: HelperEvent[] = []
  const lines = createInterface({ input: child.stdout! })
  lines.on('line', line => {
    try {
      events.push(JSON.parse(line) as HelperEvent)
    } catch {
      // Ignore a partially written line.
    }
  })
  const runId = randomUUID()
  try {
    await waitFor(events, event => event.type === 'ready', 15000)
    child.stdin!.write(`${JSON.stringify({
      type: 'start', runId, pid: process.pid, windowId: 1,
      title: 'Menu bar fixture', appName: 'Fixture',
    })}\n`)
    await waitFor(events, event => event.type === 'started', 10000)
    expect(await waitFor(events, event => event.type === 'menu' && event.visible === true, 5000))
      .toMatchObject({ type: 'menu', visible: true })

    child.stdin!.write(`${JSON.stringify({ type: 'finish', runId })}\n`)
    expect(await waitFor(events, event => event.type === 'menu' && event.visible === false, 5000))
      .toMatchObject({ type: 'menu', visible: false })
  } finally {
    child.kill()
  }
})
