import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ROOT } from './fixtures.ts'

interface Registration {
  options: { name: string; key?: string; id?: string }
  component: (props: unknown) => unknown
}

/**
 * Loads the shipped client module exactly as the DSH browser kernel does:
 * `window.__ModuleLoader__.load({ id, factory })` runs the factory with a
 * synchronous `require` for baseline modules.
 */
function loadClientModule() {
  const source = readFileSync(join(ROOT, 'packages/dsh-cu-client/lib/client.js'), 'utf8')
  const require = (name: string): unknown => {
    if (name === 'react') return reactModule
    if (name === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected client module request: ${name}`)
  }
  let loaded: { id: string; exports: Record<string, unknown> } | undefined
  const window = {
    __ModuleLoader__: {
      load(input: { id: string; factory: (require: (name: string) => unknown) => Record<string, unknown> }) {
        loaded = { id: input.id, exports: input.factory(require) }
      },
    },
  }
  new Function('window', source)(window)
  if (loaded === undefined) throw new Error('client module did not register')
  return loaded
}

let reactModule: unknown
let jsxRuntime: unknown

/** Registers the client module against a fake slots service and records cards. */
function mountCards(): Registration[] {
  const bundled = loadClientModule()
  expect(bundled.id).toBe('@albaincompleta/dsh-cu-client')
  expect(typeof bundled.exports.apply).toBe('function')
  expect(bundled.exports.inject).toEqual(['slots'])
  const registrations: Registration[] = []
  ;(bundled.exports.apply as (ctx: unknown) => void)({
    slots: {
      inject: (_name: string, factory: () => void) => factory(),
      register: (options: Registration['options'], component: Registration['component']) => {
        registrations.push({ options, component })
        return () => undefined
      },
    },
  })
  return registrations
}

async function prepare(): Promise<void> {
  reactModule = await import('react')
  jsxRuntime = await import('react/jsx-runtime')
}

const EXPECTED_KEYS = [
  'd1_browser_subgoal', 'browser_observe', 'browser_extract', 'browser_navigate', 'browser_tabs',
  'browser_upload', 'browser_downloads', 'browser_control', 'browser_skill_publish',
  'computer_subgoal', 'computer_control', 'computer_skill_publish',
]

it('registers one tool card for every tool the providers expose', async () => {
  await prepare()
  const registrations = mountCards()
  expect(registrations.every(item => item.options.name === 'tool.call.toolview')).toBe(true)
  const keys = registrations.map(item => item.options.key)
  expect(keys.sort()).toEqual([...EXPECTED_KEYS].sort())
  expect(new Set(keys).size).toBe(keys.length)
})

it('renders a settled result with status, route, and summary', async () => {
  await prepare()
  const card = mountCards().find(item => item.options.key === 'browser_tabs')
  if (card === undefined) throw new Error('browser_tabs card not registered')
  const html = renderToStaticMarkup(createElement(card.component as never, {
    toolName: 'browser_tabs',
    phase: 'settled',
    block: {
      kind: 'settled',
      content: [{ type: 'text', text: JSON.stringify({ status: 'success', action: 'list', tabs: [{ index: 0 }, { index: 1 }] }) }],
    },
  }))
  expect(html).toContain('data-dsh-cu-card="browser_tabs"')
  expect(html).toContain('data-dsh-cu-status="success"')
  expect(html).toContain('2 个标签页')
})

it('marks a blocked result and shows its reason', async () => {
  await prepare()
  const card = mountCards().find(item => item.options.key === 'browser_upload')
  if (card === undefined) throw new Error('browser_upload card not registered')
  const html = renderToStaticMarkup(createElement(card.component as never, {
    toolName: 'browser_upload',
    phase: 'settled',
    block: {
      kind: 'settled',
      content: [{ type: 'text', text: JSON.stringify({ status: 'blocked', reason: 'upload_file_not_found' }) }],
    },
  }))
  expect(html).toContain('data-dsh-cu-status="blocked"')
  expect(html).toContain('upload_file_not_found')
})

it('renders a preparing state before the call settles', async () => {
  await prepare()
  const card = mountCards().find(item => item.options.key === 'd1_browser_subgoal')
  if (card === undefined) throw new Error('d1_browser_subgoal card not registered')
  const html = renderToStaticMarkup(createElement(card.component as never, {
    toolName: 'd1_browser_subgoal',
    phase: 'preparing',
  }))
  expect(html).toContain('data-dsh-cu-status="running"')
  expect(html).toContain('准备执行')
})

it('renders untrusted tool payload text as escaped text, never as markup', async () => {
  await prepare()
  const card = mountCards().find(item => item.options.key === 'browser_navigate')
  if (card === undefined) throw new Error('browser_navigate card not registered')
  // A window title or URL is attacker-controlled data; it must never reach an HTML sink.
  const hostile = '<img src=x onerror="globalThis.__dshCuPwned=1">'
  const html = renderToStaticMarkup(createElement(card.component as never, {
    toolName: 'browser_navigate',
    phase: 'settled',
    block: {
      kind: 'settled',
      content: [{ type: 'text', text: JSON.stringify({ status: 'success', url: hostile, reason: hostile }) }],
    },
  }))
  expect(html).toContain('&lt;img src=x onerror=')
  expect(html).not.toContain('<img src=x')
  expect(html).not.toContain('onerror="globalThis')
})

it('never reads page credentials and never uses an HTML injection sink', () => {
  const source = readFileSync(join(ROOT, 'packages/dsh-cu-client/lib/client.js'), 'utf8')
  for (const sink of ['dangerouslySetInnerHTML', 'innerHTML', 'outerHTML', 'document.write', 'eval(', 'new Function(']) {
    expect(source).not.toContain(sink)
  }
  for (const credential of ['localStorage', 'sessionStorage', 'document.cookie', 'location.hash', 'location.search', 'authorization']) {
    expect(source).not.toContain(credential)
  }
})
