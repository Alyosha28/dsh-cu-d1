#!/usr/bin/env node
/**
 * Protocol double for native/ControlIndicator.swift, used by the indicator lease
 * regression tests. It speaks the same JSONL contract the shipped helper does:
 *
 *   ready -> started -> (activity|heartbeat)* -> unavailable|finish
 *
 * Modes (env LEASE_MODE):
 *   normal      accept activity while the run is live
 *   garbage     emit a non-JSON line before `ready` (a stray Swift print)
 *   offscreen   report `unavailable` with reason window_offscreen after start
 *   die         exit immediately after `started`
 *   dismiss     report `unavailable` with reason panel_dismissed when asked to dismiss
 *
 * Every command is mirrored to $LEASE_STATE so a test can read what the helper
 * itself believed at that moment.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const mode = process.env.LEASE_MODE ?? 'normal'
const statePath = process.env.LEASE_STATE
let runId = null
let lastHeartbeat = Date.now()

function emit(object) {
  process.stdout.write(`${JSON.stringify(object)}\n`)
}

function record(command) {
  if (statePath === undefined) return
  appendFileSync(statePath, `${JSON.stringify({ type: command.type, runId })}\n`)
}

if (statePath !== undefined) writeFileSync(statePath, '')
if (mode === 'garbage') process.stdout.write('helper: warming up\n')
emit({ type: 'ready' })

createInterface({ input: process.stdin }).on('line', line => {
  let command
  try {
    command = JSON.parse(line)
  } catch {
    return
  }
  switch (command.type) {
    case 'start':
      runId = command.runId
      lastHeartbeat = Date.now()
      record(command)
      emit({ type: 'started', runId })
      if (mode === 'die') process.exit(2)
      if (mode === 'offscreen') {
        setTimeout(() => {
          const reported = runId
          runId = null
          emit({ type: 'unavailable', runId: reported, reason: 'window_offscreen' })
        }, 30)
      }
      break
    case 'activity':
      record(command)
      if (command.runId !== runId) return
      break
    case 'heartbeat':
      if (command.runId === runId) lastHeartbeat = Date.now()
      break
    case 'finish':
      if (command.runId !== runId) return
      runId = null
      record(command)
      break
    case 'dismiss':
      if (mode === 'dismiss') {
        const reported = runId
        runId = null
        record(command)
        emit({ type: 'unavailable', runId: reported, reason: 'panel_dismissed' })
        break
      }
      runId = null
      record(command)
      break
    case 'stop':
      record(command)
      process.exit(0)
      break
    default:
      break
  }
})

setInterval(() => {
  if (runId !== null && Date.now() - lastHeartbeat > 3000) {
    const expired = runId
    runId = null
    emit({ type: 'expired', runId: expired })
  }
}, 500)
