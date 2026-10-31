import { executeToolFixture } from '@dsh-cu/testkit'
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
import { createCandidateFromTrajectory, evidenceFromRun } from '@dsh-cu/core/skill-builder'
import { SkillStore } from '@dsh-cu/core/skill-store'
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
  await store.recordVerification(candidate!.id, evidenceFromRun('success', 'independently_verified_after_skill', 0, true, 1))
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
  expect(published.isError).toBe(false)
  expect((await store.get(candidate!.id))?.state).toBe('verified')

  const status = await executeToolFixture(ctx, {
    agent, name: 'computer_control', arguments: { action: 'status' },
    callId: ToolCallId('native-control-status'), signal: new AbortController().signal,
  })
  expect(status.isError).toBe(false)
  const value = JSON.parse((status.content[0] as { text: string }).text) as Record<string, unknown>
  const page = await fetch(value.controlUrl as string)
  expect(page.status).toBe(200)
  expect(await page.text()).toContain('接管')
})
