import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { Config } from '../src/config.ts'
import { runBrowserSubgoal } from '../src/controller.ts'
import type { D1DecisionClient } from '../src/decision.ts'
import { RunController } from '@alyosha28/dsh-cu-core/run-controller'
import { CHROME } from './fixtures.ts'

let browser: Browser
let page: Page

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: CHROME, headless: true })
  page = await browser.newPage()
  await page.setContent('<title>Pause fixture</title><button>Click me</button><p id="done" hidden>Clicked</p>')
  await page.evaluate(() => {
    document.querySelector('button')!.addEventListener('click', () => {
      document.querySelector('#done')!.removeAttribute('hidden')
    })
  })
})
afterAll(async () => { await browser.close() })

it('keeps an active browser run alive across pause and resumes the same step', async () => {
  let calls = 0
  const client = {
    async decide(_goal: string, observation: { elements: Array<{ id: string; name: string }> }) {
      await new Promise(resolve => setTimeout(resolve, 150))
      calls += 1
      const button = observation.elements.find(element => element.name === 'Click me')
      return calls === 1
        ? {
            decision: { operation: 'CLICK', target: button!.id },
            usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
          }
        : {
            decision: { operation: 'DONE', target: null },
            usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
          }
    },
  } as unknown as D1DecisionClient
  const controller = new RunController()
  const agent = { id: 'pause-agent' } as any
  const execution = controller.start(agent, 'browser_subgoal')
  const config = Config({
    mode: 'launch', headless: true, decisionToken: 'unused',
    operationTimeoutMs: 5000, verificationTimeoutMs: 1000,
  })
  const running = runBrowserSubgoal(page, client, config, {
    goal: 'Click the button.', url: undefined,
    verify: [{ type: 'text_visible', text: 'Clicked' }],
  }, execution.signal, undefined, execution)

  await new Promise(resolve => setTimeout(resolve, 50))
  controller.pause(agent)
  expect(controller.status(agent).active?.status).toBe('paused')
  await new Promise(resolve => setTimeout(resolve, 250))
  expect(controller.status(agent).active?.status).toBe('paused')
  controller.resume(agent)
  const result = await running
  expect(result).toMatchObject({ status: 'success', actionsExecuted: 1 })
  expect(calls).toBe(1)
  controller.finish(agent, result.status, result.reason, result.route)
})
