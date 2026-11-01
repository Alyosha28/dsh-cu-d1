#!/usr/bin/env node
/**
 * Protocol double for ControlIndicator.swift.
 *
 * Mirrors the parts that matter for the lifecycle audit:
 *  - `ready` once, `started` after `start`
 *  - `activity` accepted only while runId matches
 *  - `dismiss` clears local state and emits NOTHING (ControlIndicator.swift:265-269)
 *  - `expired` after 3 s without a heartbeat
 *
 * The current runId is mirrored to $NR_STATE so the spec can observe the helper's
 * own view of the world.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const statePath = process.env.NR_STATE
const mode = process.env.NR_MODE ?? 'normal'
let runId = null
let lastHeartbeat = Date.now()

function emit(object) {
  process.stdout.write(`${JSON.stringify(object)}\n`)
}

function record(command) {
  if (statePath === undefined) return
  appendFileSync(statePath, `${JSON.stringify({ type: command.type, runId, at: Date.now() })}\n`)
}

if (mode === 'garbage') process.stdout.write('helper: starting up\n')
if (statePath !== undefined) writeFileSync(statePath, '')
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
      if (mode === 'dies-after-start') process.exit(3)
      break
    case 'activity':
      if (command.runId !== runId) {
        record(command)
        return
      }
      record(command)
      break
    case 'heartbeat':
      if (command.runId === runId) lastHeartbeat = Date.now()
      break
    case 'finish':
      if (command.runId !== runId) return
      record(command)
      runId = null
      break
    case 'dismiss':
      // Exactly what the shipped helper does: clear locally, tell nobody.
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
    emit({ type: 'expired', runId })
    runId = null
  }
}, 500)
