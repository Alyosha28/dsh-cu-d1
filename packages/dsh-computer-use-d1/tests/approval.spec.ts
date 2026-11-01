import { executeToolFixture } from '@albaincompleta/dsh-cu-testkit'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import * as Provider from '../src/index.ts'
import { createCandidateFromTrajectory } from '@albaincompleta/dsh-cu-core/skill-builder'
import { SkillStore } from '@albaincompleta/dsh-cu-core/skill-store'
import { HELPER, pathGrant, REPORT_PATH, ROOT } from './fixtures.ts'
import { FakeUserQuestions } from './approval-fixtures.ts'

class IndependentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('native approval test called the Session model') }
}

let ctx: Context
let agent: Agent
let fixture: ChildProcess
let fixturePath: string
let tempRoot: string
let storePath: string

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-native-approval-'))
  storePath = join(tempRoot, 'skills.json')
  await writeFile(REPORT_PATH, 'city,amount\nZürich,100\nLondon,200\n')
  fixturePath = join(tempRoot, 'workflow-fixture')
  const compile = spawn('swiftc', [join(ROOT, 'fixtures/native/WorkflowFixture.swift'), '-o', fixturePath], { stdio: 'inherit' })
  await new Promise<void>((resolve, reject) => {
    compile.once('exit', code => code === 0 ? resolve() : reject(new Error(`swiftc exited ${code}`)))
    compile.once('error', reject)
  })
  fixture = spawn(fixturePath, [join(tempRoot, 'state.json')], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((resolve, reject) => {
    fixture.stdout!.once('data', () => resolve())
    fixture.once('error', reject)
    fixture.once('exit', code => reject(new Error(`fixture exited ${code}`)))
  })
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(ComputerUseRegistry)
  ctx.llm.registerAdapter(['fixture'], new IndependentSessionModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  agent = await harness.create(SessionId('native-approval'), { provider: 'fixture', model: 'structured' })
})

afterEach(async () => {
  fixture.kill('SIGTERM')
  await ctx.fiber.dispose()
  await rm(tempRoot, { recursive: true, force: true })
  await rm(REPORT_PATH, { force: true })
})

it('publishes a Skill through DSH user approval and exposes native control', async () => {
  const store = new SkillStore(storePath)
  const candidate = await createCandidateFromTrajectory(store, {
    route: 'd1', status: 'success', match: { windowTitle: 'DSH Workflow Fixture' },
    verify: [{ type: 'text_visible', text: 'Import complete' }],
    trace: [{ operation: 'CLICK', targetName: 'Import report', target: '2' }],
  })
  // CR-02: evidence can only be minted by the store, through a single-use session token.
  const session = await store.beginVerification(candidate!.id)
  await store.finishVerification(session.token, { status: 'passed', summary: 'independently_verified_after_skill' })
  const approved = new FakeUserQuestions(true)
  ctx.provide('userQuestions', approved)
  await ctx.plugin(Provider, {
    helperPath: HELPER,
    allowedApps: [pathGrant(fixturePath)],
    decisionEndpoint: 'http://127.0.0.1:8765', decisionToken: 'unused',
    skillStorePath: storePath, captureSkills: true, controlToken: 'native-control',
  })
  const published = await executeToolFixture(ctx, {
    agent, name: 'computer_skill_publish', arguments: { skillId: candidate!.id },
    callId: ToolCallId('native-publish'), signal: new AbortController().signal,
  })
  expect(published.isError, JSON.stringify(published.content)).toBe(false)
  expect((await store.get(candidate!.id))?.state).toBe('verified')

  const status = await executeToolFixture(ctx, {
    agent, name: 'computer_control', arguments: { action: 'status' },
    callId: ToolCallId('native-control-status'), signal: new AbortController().signal,
  })
  expect(status.isError).toBe(false)
  const value = JSON.parse((status.content[0] as { text: string }).text) as Record<string, unknown>
  // The page shell is public; every /api route is authenticated by the token in
  // the URL fragment, which the page script turns into an Authorization header.
  const controlUrl = new URL(value.controlUrl as string)
  const pageToken = new URLSearchParams(controlUrl.hash.replace(/^#/, '')).get('token')
  expect(pageToken).toBeTruthy()
  const page = await fetch(`${controlUrl.origin}/`)
  expect(page.status).toBe(200)
  const anonymousApi = await fetch(`${controlUrl.origin}/api/status`)
  expect(anonymousApi.status).toBe(401)
  const authorizedApi = await fetch(`${controlUrl.origin}/api/status`, {
    headers: { authorization: `Bearer ${pageToken}` },
  })
  expect(authorizedApi.status).toBe(200)
  const apiStatus = await authorizedApi.json() as { active?: unknown }
  expect(apiStatus).toBeTypeOf('object')
  expect(await page.text()).toContain('接管')
})
