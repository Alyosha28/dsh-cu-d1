import { executeToolFixture } from '@albaincompleta/dsh-cu-testkit'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Provider from '../src/index.ts'
import { CHROME, close, fixtureServer, listen } from './fixtures.ts'
import { FakeUserQuestions } from './approval-fixtures.ts'

class UnusedSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('upload tests must not call the Session model') }
}

let ctx: Context
let agent: Agent
let fixtures: ReturnType<typeof fixtureServer>
let fixtureUrl: string
let tempRoot: string

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-upload-'))
  await writeFile(join(tempRoot, 'note.txt'), 'upload fixture')
  fixtures = fixtureServer()
  fixtureUrl = await listen(fixtures)
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(BrowserUseRegistry)
  ctx.llm.registerAdapter(['fixture'], new UnusedSessionModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  agent = await harness.create(SessionId('upload-run'), { provider: 'fixture', model: 'structured' })
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
  })
  const opened = await call('browser_navigate', { url: `${fixtureUrl}/upload.html` })
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

const documentInput = { kind: 'label', text: 'Document' }

it('uploads an approved file and the page receives it', async () => {
  const questions = await mount(true)
  const result = await call('browser_upload', {
    locator: documentInput,
    files: [join(tempRoot, 'note.txt')],
  })
  expect(result).toMatchObject({
    status: 'success', reason: 'uploaded', field: 'doc', files: ['note.txt'], trusted: false,
  })
  expect(questions.calls).toHaveLength(1)
  const detail = (questions.calls[0]!.questions[0] as { detail: string }).detail
  expect(detail).toContain('note.txt')

  const extract = await call('browser_extract', {
    fields: [{ name: 'picked', locator: { kind: 'css', selector: '#picked' } }],
  })
  expect(extract.data.picked).toBe('selected: note.txt')
})

it('stops without uploading when the user denies the request', async () => {
  await mount(false)
  const result = await call('browser_upload', {
    locator: documentInput,
    files: [join(tempRoot, 'note.txt')],
  })
  expect(result).toMatchObject({ status: 'confirmation_required', reason: 'denied_by_user', field: 'doc' })
  const extract = await call('browser_extract', {
    fields: [{ name: 'picked', required: false, locator: { kind: 'css', selector: '#picked' } }],
  })
  expect(extract.data?.picked ?? '').toBe('')
})

it('refuses relative paths, directories, and non-file inputs before asking', async () => {
  const questions = await mount(true)
  expect(await call('browser_upload', { locator: documentInput, files: ['note.txt'] }))
    .toMatchObject({ status: 'blocked', reason: 'upload_requires_absolute_paths' })
  expect(await call('browser_upload', { locator: documentInput, files: [tempRoot] }))
    .toMatchObject({ status: 'blocked', reason: 'upload_target_is_not_a_file' })
  expect(await call('browser_upload', { locator: documentInput, files: [join(tempRoot, 'missing.txt')] }))
    .toMatchObject({ status: 'blocked', reason: 'upload_file_not_found' })
  expect(await call('browser_upload', {
    locator: { kind: 'role', role: 'heading', name: 'Attach a document' },
    files: [join(tempRoot, 'note.txt')],
  })).toMatchObject({ status: 'blocked', reason: 'upload_target_not_a_file_input' })
  expect(questions.calls).toHaveLength(0)
})
