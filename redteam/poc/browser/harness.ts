/**
 * Red-team harness for the D1 browser execution layer.
 *
 * Every PoC drives the *real* provider code (src/*.ts) against a real Chromium.
 * Nothing here is a mock of the code under test: only the D1 decision service,
 * the approval gateway and the run handle are stubs, because those are host
 * side inputs.
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { Config } from '../../../packages/dsh-browser-use-d1/src/config.ts'
import type { ResolvedConfig } from '../../../packages/dsh-browser-use-d1/src/config.ts'
import type { Decision } from '@albaincompleta/dsh-cu-core/actions'

export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export async function launch(): Promise<Browser> {
  return chromium.launch({ executablePath: CHROME, headless: true })
}

export function config(overrides: Record<string, unknown> = {}): ResolvedConfig {
  return Config({ mode: 'launch', decisionToken: 'redteam-token', ...overrides })
}

export interface Served { url: string; server: Server; close: () => Promise<void> }

/** Serves one HTML body (plus optional extra routes) on loopback. */
export async function serve(
  body: string,
  routes: Record<string, (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void> = {},
): Promise<Served> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture').pathname
    const extra = routes[path]
    if (extra !== undefined) return extra(request, response)
    if (path !== '/') { response.writeHead(404).end(); return }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(body)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return {
    url: `http://127.0.0.1:${address.port}/`,
    server,
    close: () => new Promise<void>((resolve, reject) => {
      // Chrome keeps idle keep-alive sockets open; close them so a test's
      // teardown cannot stall waiting for the browser to hang up.
      server.closeAllConnections()
      server.close(error => error ? reject(error) : resolve())
    }),
  }
}

/** Serves an HTML body at an arbitrary path. */
export function htmlRoute(body: string) {
  return (_request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): void => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(body)
  }
}

export interface DecisionStep { decision: Decision; usage?: { input_tokens: number; output_tokens: number } }

/** A scripted stand-in for the local D1 decision service. */
export function scriptedClient(steps: DecisionStep[]) {
  const calls: Array<{ goal: string; observation: unknown }> = []
  let index = 0
  return {
    calls,
    async decide(goal: string, observation: unknown) {
      calls.push({ goal, observation })
      const step = steps[Math.min(index, steps.length - 1)]
      index += 1
      return {
        decision: step.decision,
        usage: step.usage ?? { input_tokens: 1, output_tokens: 1 },
        latencyMs: 1,
        textExtractionCalls: 0,
      }
    },
  }
}

export interface RecordedApproval { id: string; question: string; detail: string }

/** Records every approval the provider asks for; `approve` decides the answer. */
export function approvalSpy(approve = true, during?: () => Promise<void>) {
  const calls: RecordedApproval[] = []
  return {
    calls,
    async request(_agent: unknown, request: RecordedApproval) {
      calls.push(request)
      if (during !== undefined) await during()
      return approve ? { approved: true } : { approved: false, reason: 'denied_by_user' }
    },
  }
}

/** A minimal ExecutionHandle; the real one only adds pause/stop bookkeeping. */
export function execution(agentId = 'redteam-agent') {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    agent: { id: agentId } as never,
    signal: new AbortController().signal,
    admit: () => null,
    waitWhilePaused: async () => null,
    pausedMs: () => 0,
  }
}

export async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  return context.newPage()
}
