/**
 * BR-03 — Skill replay executes with no approval at all.
 *
 * `runBrowserSkill` (skill-runner.ts) imports checkPagePolicy/checkTargetAmbiguity
 * but nothing from policy-approvals: the `policy` it builds from `skill.risk` is
 * only used for the credential-field check. A published Skill with
 * `risk: 'consequential'` therefore replays clicks (and typed values) with zero
 * approval, even with no approval gateway wired at all, while the same action on
 * the D1 path stops with `confirmation_required`.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser } from 'playwright'
import { runBrowserSubgoal } from '../../../packages/dsh-browser-use-d1/src/controller.ts'
import type { D1DecisionClient } from '../../../packages/dsh-browser-use-d1/src/decision.ts'
import { SkillStore } from '../../../packages/dsh-cu-core/src/skill-store.ts'
import { evidenceFromRun } from '../../../packages/dsh-cu-core/src/skill-builder.ts'
import { approvalSpy, config, execution, htmlRoute, launch, newPage, serve } from './harness.ts'

let browser: Browser
let root: string
beforeAll(async () => {
  browser = await launch()
  root = await mkdtemp(join(tmpdir(), 'br03-skills-'))
})
afterAll(async () => {
  await browser.close()
  await rm(root, { recursive: true, force: true })
})

const PAGE = `
  <h1>Account settings</h1>
  <button id="delete" type="button">Delete account</button>
  <div id="status" role="status">Account active</div>
  <script>
    window.__deleted = 0;
    document.getElementById('delete').addEventListener('click', () => {
      window.__deleted += 1;
      document.getElementById('status').textContent = 'Account deleted';
    });
  </script>`

function deadClient() {
  return { async decide() { throw new Error('D1 must not be consulted for a Skill replay') } } as unknown as D1DecisionClient
}

async function publishDestructiveSkill(origin: string): Promise<SkillStore> {
  const store = new SkillStore(join(root, 'skills.json'))
  const candidate = await store.createCandidate({
    match: { urlPath: '/account.html', origin },
    fallback: 'd1',
    risk: 'consequential',
    verify: [{ type: 'text_visible', text: 'Account deleted' }],
    steps: [{ type: 'click', target: 'Delete account' }],
  })
  await store.recordVerification(candidate.id, evidenceFromRun('success', 'independently_verified', 0, true, 1))
  const latest = (await store.get(candidate.id))!.history.at(-1)!
  await store.publish(candidate.id, latest.id, 'user')
  return store
}

it('replays a consequential Skill with no approval gateway at all', async () => {
  const page = await newPage(browser)
  const served = await serve(PAGE, { '/account.html': htmlRoute(PAGE) })
  try {
    await page.goto(`${served.url}account.html`)
    const store = await publishDestructiveSkill(new URL(served.url).origin)
    const skill = (await store.list('verified'))[0]!
    expect(skill.risk).toBe('consequential')

    // No ExecutionHandle and no ApprovalGateway: on the D1 path that alone
    // forces confirmation_required/approval_unavailable. Here it just runs.
    const result = await runBrowserSubgoal(
      page, deadClient(), config(), {
        goal: 'Delete the account.', verify: [{ type: 'text_visible', text: 'Account deleted' }],
        skillId: skill.id,
      }, new AbortController().signal, store,
    )
    expect(result).toMatchObject({ route: 'skill', status: 'success', actionsExecuted: 1 })
    expect(await page.evaluate(() => (window as unknown as { __deleted: number }).__deleted)).toBe(1)
  } finally {
    await served.close()
    await page.context().close()
  }
})

it('auto-selects the published Skill from the URL and still asks for nothing', async () => {
  const page = await newPage(browser)
  const served = await serve(PAGE, { '/account.html': htmlRoute(PAGE) })
  try {
    await page.goto(`${served.url}account.html`)
    const store = await publishDestructiveSkill(new URL(served.url).origin)
    const approvals = approvalSpy(true)

    // No skillId: selectSkill() matches on origin+path and runs it implicitly.
    const result = await runBrowserSubgoal(
      page, deadClient(), config(), {
        goal: 'Delete the account.', url: `${served.url}account.html`,
        verify: [{ type: 'text_visible', text: 'Account deleted' }],
      }, new AbortController().signal, store, execution(), approvals as never,
    )
    expect(result).toMatchObject({ route: 'skill', status: 'success', actionsExecuted: 1 })
    expect(approvals.calls).toEqual([])
  } finally {
    await served.close()
    await page.context().close()
  }
})

it('control: the identical destructive action on the D1 path needs approval', async () => {
  const page = await newPage(browser)
  try {
    await page.setContent(PAGE)
    const approvals = approvalSpy(true)
    const client = {
      async decide(_goal: string, observation: { elements: Array<{ id: string; name: string }> }) {
        const target = observation.elements.find(element => element.name === 'Delete account')
        return {
          decision: { operation: 'CLICK' as const, target: target?.id ?? null },
          usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
        }
      },
    } as unknown as D1DecisionClient
    const result = await runBrowserSubgoal(
      page, client, config(), {
        goal: 'Delete the account.', policy: { risk: 'consequential' },
        verify: [{ type: 'text_visible', text: 'Account deleted' }],
      }, new AbortController().signal, undefined, execution(), approvals as never,
    )
    expect(result.status).toBe('success')
    expect(approvals.calls).toHaveLength(1)
  } finally {
    await page.context().close()
  }
})
