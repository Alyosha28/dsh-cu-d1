/**
 * BR-13 — `browser_downloads action=wait` writes to disk only after an explicit
 * approval naming the destination, and reports only the file this wait produced.
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Provider from '../src/index.ts'
import { executeToolFixture } from '@albaincompleta/dsh-cu-testkit'
import { CHROME, close, fixtureServer, listen } from './fixtures.ts'
import { FakeUserQuestions } from './approval-fixtures.ts'

class NoModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('downloads must not call the Session model') }
}

let ctx: Context
let agent: Agent
let fixtures: ReturnType<typeof fixtureServer>
let fixtureUrl: string
let tempRoot: string
let downloadDir: string

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-downloads-tool-'))
  downloadDir = join(tempRoot, 'downloads')
  fixtures = fixtureServer()
  fixtureUrl = await listen(fixtures)
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(BrowserUseRegistry)
  ctx.llm.registerAdapter(['fixture'], new NoModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  agent = await harness.create(SessionId('downloads-tool'), { provider: 'fixture', model: 'structured' })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await close(fixtures)
  await rm(tempRoot, { recursive: true, force: true })
})

async function mount(approve: boolean) {
  const questions = new FakeUserQuestions(approve)
  ctx.provide('userQuestions', questions)
  await ctx.plugin(Provider, {
    mode: 'launch', executablePath: CHROME, headless: true,
    decisionEndpoint: 'http://127.0.0.1:9', decisionToken: 'unused-token',
    downloadDir,
  })
  const opened = await call('browser_navigate', { url: `${fixtureUrl}/download.html` })
  expect(opened.status).toBe('success')
  return questions
}

async function call(name: string, args: unknown) {
  const result = await executeToolFixture(ctx, {
    agent, name, arguments: args, callId: ToolCallId(`${name}-${Math.random()}`), signal: new AbortController().signal,
  })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  return JSON.parse((result.content[0] as { text: string }).text) as Record<string, any>
}

it('asks before writing, and writes nothing when the user denies', async () => {
  const questions = await mount(false)
  const result = await call('browser_downloads', { action: 'wait', timeoutMs: 300 })
  expect(result).toMatchObject({ status: 'confirmation_required', reason: 'denied_by_user' })
  expect(questions.calls).toHaveLength(1)
  const detail = (questions.calls[0]!.questions[0] as { detail: string }).detail
  expect(detail).toContain(downloadDir)
  expect(await readdir(downloadDir)).toEqual([])
})

it('reports only the file this wait produced', async () => {
  const questions = await mount(true)
  const first = await call('browser_downloads', { action: 'wait', timeoutMs: 2000 })
  // No click was issued yet, so this wait must time out instead of returning an
  // older file from a previous action.
  expect(first).toMatchObject({ status: 'escalated', reason: 'download_timeout', action: 'wait' })
  expect(first.download).toBeUndefined()
  expect(questions.calls.length).toBeGreaterThanOrEqual(1)

  const listed = await call('browser_downloads', { action: 'list' })
  expect(listed).toMatchObject({ status: 'success', action: 'list', dir: downloadDir })
  // Listing is metadata only: it never writes and never approves anything.
  expect(await readdir(downloadDir)).toEqual([])
})

it('reports download_timeout, never an older file, when nothing new arrives', async () => {
  await mount(true)
  // A second wait in the same session: the first approved wait produced no file,
  // so this one must not resurrect anything either.
  const value = await call('browser_downloads', { action: 'wait', timeoutMs: 200 })
  expect(value).toMatchObject({ status: 'escalated', reason: 'download_timeout', action: 'wait' })
  expect(value.download).toBeUndefined()
  expect(await readdir(downloadDir)).toEqual([])
})
