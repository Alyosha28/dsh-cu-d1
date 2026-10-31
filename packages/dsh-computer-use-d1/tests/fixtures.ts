import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'


export const ROOT = resolve(import.meta.dirname, '../../..')
export const HELPER = '/tmp/dsh-official-alpha2/packages/experimental/cua-macos/native/.build/release/dsh-cua-native'
export const REPORT_PATH = '/tmp/dsh-cu-test-report.csv'

export function pathGrant(path: string) {
  return {
    id: createHash('sha256').update(`macos:executable-path:${path}`).digest('hex'),
    name: 'WorkflowFixture',
    executablePath: path,
  }
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing server address')
  return `http://127.0.0.1:${address.port}`
}

export async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

export function visualDecisionServer(token: string): Server {
  let calls = 0
  return createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}` || request.method !== 'POST' || request.url !== '/decide') {
      response.writeHead(401).end()
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body) as {
      observation: { elements: Array<{ identifier?: string; value: string | null }> }
      screenshot?: { data: string; mimeType: string }
      inputs?: Record<string, string>
    }
    if (payload.screenshot === undefined) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'screenshot_required' }))
      return
    }
    calls += 1
    const reportPath = payload.inputs?.['Report path'] ?? REPORT_PATH
    const decision = calls === 1
      ? {
          operation: 'TYPE_TEXT', target: null, text: reportPath, confidence: 0.99,
          box: { left: 0.1, top: 0.35, right: 0.9, bottom: 0.55 }, found: 1,
        }
      : {
          operation: 'CLICK', target: null, confidence: 0.99,
          box: { left: 0.1, top: 0.55, right: 0.4, bottom: 0.75 }, found: 1,
        }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      decision,
      usage: { input_tokens: 10, output_tokens: 0 },
      latencyMs: 1,
      textExtractionCalls: 0,
    }))
  })
}
export function decisionServer(token: string): Server {
  return createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}` || request.method !== 'POST' || request.url !== '/decide') {
      response.writeHead(401).end()
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body) as {
      goal: string
      observation: { elements: Array<{ id: string; identifier?: string; value: string | null }> }
      inputs?: Record<string, string>
    }
    const reportPath = payload.inputs?.['Report path'] ?? REPORT_PATH
    const field = payload.observation.elements.find(element => element.identifier === 'dsh-workflow-path')
    const button = payload.observation.elements.find(element => element.identifier === 'dsh-workflow-import')
    const decision = field && field.value !== reportPath
      ? { operation: 'TYPE_TEXT', target: field.id, text: reportPath, confidence: 0.99 }
      : button
        ? { operation: 'CLICK', target: button.id, confidence: 0.99 }
        : { operation: 'BLOCKED', target: null, confidence: 0.99 }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      decision,
      usage: { input_tokens: 10, output_tokens: 0 },
      latencyMs: 1,
      textExtractionCalls: 0,
    }))
  })
}
