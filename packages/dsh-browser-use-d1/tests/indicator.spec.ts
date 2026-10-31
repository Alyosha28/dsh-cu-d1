import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium } from 'playwright'
import type { Browser, CDPSession, Page } from 'playwright'
import { randomUUID } from 'node:crypto'
import { BrowserControlIndicator } from '../src/indicator.ts'
import { BrowserDom } from '../src/dom.ts'
import type { ControlAction } from '@dsh-cu/core/activity'
import { CHROME } from './fixtures.ts'

interface DomNode {
  nodeName: string
  backendNodeId: number
  attributes?: string[]
  children?: DomNode[]
  shadowRoots?: DomNode[]
  contentDocument?: DomNode
}

let browser: Browser
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: CHROME, headless: true })
})
afterAll(async () => { await browser.close() })

function findNode(node: DomNode, predicate: (candidate: DomNode) => boolean): DomNode | undefined {
  if (predicate(node)) return node
  const descendants = [...node.children ?? [], ...node.shadowRoots ?? []]
  if (node.contentDocument !== undefined) descendants.push(node.contentDocument)
  for (const child of descendants) {
    const found = findNode(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

function findButton(node: DomNode, action: string): DomNode | undefined {
  return findNode(node, candidate => {
    if (candidate.nodeName !== 'BUTTON') return false
    const index = candidate.attributes?.indexOf('data-dsh-action') ?? -1
    return index >= 0 && candidate.attributes?.[index + 1] === action
  })
}

async function clickControl(cdp: CDPSession, action: ControlAction): Promise<void> {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
  const button = findButton(root, action)
  expect(button, `missing ${action} control`).toBeDefined()
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: button!.backendNodeId })
  expect(object.objectId).toBeDefined()
  await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function(){ this.click(); }',
    returnByValue: true,
  })
}

it('shows the real cursor and controls without entering observations, then removes them', async () => {
  const page: Page = await browser.newPage()
  const actions: ControlAction[] = []
  const indicator = new BrowserControlIndicator(page, action => actions.push(action))
  const cdp = await page.context().newCDPSession(page)
  try {
    await page.setContent('<button>Run fixture</button>')
    await indicator.start(randomUUID())
    const host = page.locator('[data-dsh-cu-control]')
    await expect.poll(() => host.count()).toBe(1)
    await expect.poll(() => host.getAttribute('data-dsh-cu-phase')).toBe('running')
    const dom = new BrowserDom(page, 60, indicator)
    const snapshot = await dom.snapshot()
    expect(snapshot.elements.map(element => element.name)).toEqual(['Run fixture'])
    await dom.execute(snapshot, { operation: 'CLICK', target: snapshot.elements[0].id }, 1000)
    await expect.poll(() => host.getAttribute('data-dsh-cu-operation')).toBe('CLICK')
    expect(Number.parseInt((await host.getAttribute('data-dsh-cu-point'))?.split(',')[0] ?? '', 10)).toBeGreaterThan(0)
    for (const action of ['pause', 'stop', 'takeover'] as const) {
      await clickControl(cdp, action)
      await expect.poll(() => actions).toContain(action)
    }
    await indicator.activity({ phase: 'acting', operation: 'CLICK', point: { x: 100, y: 80 } })
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
    const cursor = findNode(root, node => node.nodeName === 'DIV' && node.attributes?.includes('cursor') === true)
    expect(cursor, 'missing software cursor').toBeDefined()
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: cursor!.backendNodeId })
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function(){ return {
        transform: this.style.transform.replace(/\\s/g, ''),
        width: getComputedStyle(this).width,
        height: getComputedStyle(this).height,
        viewBox: this.querySelector('svg').getAttribute('viewBox')
      }; }`,
      returnByValue: true,
    })
    expect(result.value).toEqual({
      transform: 'translate(90px,71px)', width: '52px', height: '52px', viewBox: '-4 -4 52 52',
    })
    await indicator.finish()
    await expect.poll(() => host.count()).toBe(0)
    expect(JSON.stringify(snapshot)).not.toContain('暂停')
  } finally {
    await indicator.close()
    await cdp.detach()
    await page.close()
  }
})

it('restores activity after navigation and cleans the new document', async () => {
  const page = await browser.newPage()
  const indicator = new BrowserControlIndicator(page, () => undefined)
  try {
    await indicator.start(randomUUID())
    await page.goto('data:text/html,<button>After navigation</button>')
    const dom = new BrowserDom(page, 60, indicator)
    const snapshot = await dom.snapshot()
    await dom.execute(snapshot, { operation: 'CLICK', target: snapshot.elements[0].id }, 1000)
    const host = page.locator('[data-dsh-cu-control]')
    await expect.poll(() => host.count()).toBe(1)
    await expect.poll(() => host.getAttribute('data-dsh-cu-operation')).toBe('CLICK')
    await indicator.finish()
    await expect.poll(() => host.count()).toBe(0)
  } finally {
    await indicator.close()
    await page.close()
  }
})
