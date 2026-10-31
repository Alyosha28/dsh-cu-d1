import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { D1DecisionClient } from '../src/decision.ts'

const servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  delete process.env.DEBUG_D1
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => error ? reject(error) : resolve())
  })))
})

it('keeps goals, inputs, page text, typed values and screenshots out of decision debug logs', async () => {
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      expect(body).toContain('private-goal')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        decision: { operation: 'TYPE_TEXT', target: '1', text: 'private-typed-value' },
        usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
      }))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing test server address')
  process.env.DEBUG_D1 = '1'
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const client = new D1DecisionClient({
    decisionEndpoint: `http://127.0.0.1:${address.port}`, decisionToken: 'private-token',
    decisionTimeoutMs: 5000, textStrategy: 'speculative',
  })
  await client.decide('private-goal', {
    elements: [{ id: '1', name: 'private-page-text' }],
  }, new AbortController().signal, { Field: 'private-input' }, { data: 'cHJpdmF0ZS1zY3JlZW5zaG90', mimeType: 'image/png' })
  const logs = errors.mock.calls.map(call => call.map(String).join(' ')).join('\n')
  expect(logs).toContain('D1_REQUEST')
  expect(logs).toContain('D1_RESPONSE')
  for (const marker of ['private-goal', 'private-page-text', 'private-input', 'private-typed-value', 'private-screenshot', 'private-token']) {
    expect(logs).not.toContain(marker)
  }
})

it('rejects visual boxes outside normalized bounds or with zero area', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      decision: { operation: 'CLICK', target: null, box: { left: 2, right: 2, top: 0, bottom: 1 } },
      usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
    }))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing test server address')
  const client = new D1DecisionClient({
    decisionEndpoint: `http://127.0.0.1:${address.port}`, decisionToken: 'token',
    decisionTimeoutMs: 5000, textStrategy: 'speculative',
  })
  await expect(client.decide('goal', { elements: [] }, new AbortController().signal)).rejects.toThrow()
})
