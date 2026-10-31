import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import * as BrowserProvider from '../../dsh-browser-use-d1/src/index.ts'
import * as ComputerProvider from '../src/index.ts'
import { CHROME } from '../../dsh-browser-use-d1/tests/fixtures.ts'
import { HELPER } from './fixtures.ts'

let ctx: Context

beforeEach(async () => {
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(BrowserUseRegistry)
  await ctx.plugin(ComputerUseRegistry)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

it('mounts browser and native providers together with disjoint tool names', async () => {
  await ctx.plugin(BrowserProvider, {
    mode: 'launch', executablePath: CHROME, headless: true,
    decisionEndpoint: 'http://127.0.0.1:8765', decisionToken: 'unused',
  })
  await ctx.plugin(ComputerProvider, {
    helperPath: HELPER,
    decisionEndpoint: 'http://127.0.0.1:8765', decisionToken: 'unused',
  })
  expect(ctx.browserUse.providerName).toBe('d1-system-one')
  expect(ctx.computerUse.providerName).toBe('dsh-cua')
  const names = ctx.tools.schemas().map(tool => tool.name)
  expect(names).toEqual(expect.arrayContaining([
    'd1_browser_subgoal', 'browser_extract', 'browser_observe', 'browser_navigate', 'browser_tabs',
    'browser_upload', 'browser_downloads', 'browser_control', 'browser_skill_publish',
    'computer_subgoal', 'computer_control', 'computer_skill_publish',
  ]))
  expect(new Set(names).size).toBe(names.length)
  expect(names).not.toContain('skill_publish')
})
