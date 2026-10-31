import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'


export const ROOT = resolve(import.meta.dirname, '../../..')
export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export interface ObservationElement {
  id: string
  role: string
  name: string
  value: string | null
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing test server address')
  return `http://127.0.0.1:${address.port}`
}

export async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

export function fixtureServer(): Server {
  const root = resolve(ROOT, 'fixtures/web')
  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://fixture').pathname
      const path = resolve(root, `.${pathname}`)
      if (!path.startsWith(`${root}${sep}`)) throw new Error('Invalid fixture path')
      const body = await readFile(path)
      const type = extname(path) === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream'
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      response.end(body)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
}

function decision(operation: string, target: string | null, text?: string) {
  return {
    operation, target, confidence: 0.99,
    ...text === undefined ? {} : { text },
  }
}

export function nextFixtureDecision(goal: string, elements: ObservationElement[]) {
  if (/premature/iu.test(goal)) return decision('DONE', null)
  if (/ambiguous|without choosing/iu.test(goal)) {
    const button = elements.find(element => element.role === 'button')
    if (button !== undefined) return decision('CLICK', button.id)
  }
  if (/no progress|stale/iu.test(goal)) {
    const button = elements.find(element => element.role === 'button')
    if (button !== undefined) return decision('CLICK', button.id)
  }
  const byName = (name: string) => elements.find(element => element.name === name)
  if (/cross-origin capture/iu.test(goal)) {
    const go = byName('Go')
    if (go !== undefined) return decision('CLICK', go.id)
  }
  if (/repeated secrets/iu.test(goal)) {
    const field = byName('__proto__')
    if (field?.value === 'firstSecret') return decision('TYPE_TEXT', field.id, 'secondSecret')
    if (field?.value === 'secondSecret') {
      const done = byName('Done')
      if (done !== undefined) return decision('CLICK', done.id)
    }
    if (field !== undefined) return decision('TYPE_TEXT', field.id, 'firstSecret')
  }
  if (/Adults|Nonstop|available flights/iu.test(goal)) {
    const adults = byName('Adults')
    if (adults?.value === '2') return decision('INCREMENT', adults.id)
    const nonstop = byName('Nonstop only')
    if (nonstop?.value === 'unchecked') return decision('CLICK', nonstop.id)
    const apply = byName('Apply filters')
    if (apply !== undefined) return decision('CLICK', apply.id)
  }
  if (/flights from|Find one-way flights/iu.test(goal)) {
    const from = byName('From')
    if (from?.value !== 'Zürich') return decision('TYPE_TEXT', from!.id, 'Zürich')
    const to = byName('To')
    if (to?.value !== 'London') return decision('TYPE_TEXT', to!.id, 'London')
    const date = byName('Departure date')
    if (date?.value !== '2026-11-01') return decision('TYPE_TEXT', date!.id, '2026-11-01')
    const search = byName('Search flights')
    if (search !== undefined) return decision('CLICK', search.id)
  }
  if (/Delayed results|Load the results/iu.test(goal)) {
    const load = byName('Load results')
    if (load !== undefined) return decision('CLICK', load.id)
  }
  if (/Sign in/iu.test(goal)) {
    const signIn = byName('Sign in')
    if (signIn !== undefined) return decision('CLICK', signIn.id)
  }
  return decision('BLOCKED', null)
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
      observation: { elements: ObservationElement[] }
    }
    const result = nextFixtureDecision(payload.goal, payload.observation.elements)
    if (/stale/iu.test(payload.goal)) await new Promise(resolve => setTimeout(resolve, 100))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      decision: result,
      usage: { input_tokens: 10, output_tokens: 0 },
      latencyMs: 1,
      textExtractionCalls: 0,
    }))
  })
}
