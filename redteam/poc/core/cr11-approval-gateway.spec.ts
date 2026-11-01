/**
 * CR-11 — ApprovalGateway: the answer object is trusted without validation.
 *
 * The gateway casts the host's reply to `Array<{ id, custom?, selected: string[] }>`
 * and then asks `answer.selected.includes(request.approve)`.
 *   - a malformed `selected` (a single string instead of an array) *approves*,
 *     because `String.prototype.includes` also answers true;
 *   - a rejected `ask()` (host cancel / abort) propagates as an exception, so the
 *     run cannot report `confirmation_required` — it fails as a tool error;
 *   - nothing asserts `approve !== reject`, so a locale where both labels collide
 *     would turn "Deny" into an approval.
 *
 * The failures below are fail-closed by construction and are recorded as controls.
 */
import { describe, expect, it } from 'vitest'
import { ApprovalGateway } from '../../../packages/dsh-cu-core/src/approvals.ts'
import { needsConsequentialApproval, requestConsequentialApproval } from '../../../packages/dsh-cu-core/src/policy-approvals.ts'
import { uiStrings } from '../../../packages/dsh-cu-core/src/locale.ts'

const agent = { id: 'agent-1' } as any
const labels = uiStrings('en').approvals
const signal = new AbortController().signal

function gateway(ask: (payload: any) => Promise<any>): ApprovalGateway {
  const ctx = { get: (name: string) => name === 'userQuestions' ? { ask } : undefined } as any
  return new ApprovalGateway(ctx)
}

describe('CR-11 approval gateway answer handling', () => {
  it('fails closed when the host reports no userQuestions service', async () => {
    const g = new ApprovalGateway({ get: () => undefined } as any)
    expect(await g.request(agent, { id: 'q', question: '?', detail: '', approve: 'OK', reject: 'No' }, signal))
      .toEqual({ approved: false, reason: 'approval_unavailable' })
  })

  it('fails closed on empty answers, unknown ids and custom text', async () => {
    expect((await gateway(async () => ({ answers: [] })).request(agent,
      { id: 'q', question: '?', detail: '', approve: 'OK', reject: 'No' }, signal)).approved).toBe(false)
    expect((await gateway(async () => ({ answers: [{ id: 'other', selected: ['OK'] }] })).request(agent,
      { id: 'q', question: '?', detail: '', approve: 'OK', reject: 'No' }, signal)).approved).toBe(false)
    expect((await gateway(async () => ({ answers: [{ id: 'q', selected: ['OK'], custom: 'do it' }] })).request(agent,
      { id: 'q', question: '?', detail: '', approve: 'OK', reject: 'No' }, signal)).approved).toBe(false)
  })

  it('a non-array `selected` is treated as an approval', async () => {
    // Host/shape drift: `selected` arrives as a single string.
    const g = gateway(async () => ({ answers: [{ id: 'q', selected: 'Allow once' }] }))
    const result = await g.request(agent, {
      id: 'q', question: '?', detail: '', approve: labels.allowOnce, reject: labels.deny,
    }, signal)
    expect(result).toEqual({ approved: true })      // a string, not an array, still answers includes()
    // Any string that merely *contains* the approve label also approves.
    const contains = gateway(async () => ({ answers: [{ id: 'q', selected: `x${labels.allowOnce}x` }] }))
    expect((await contains.request(agent, {
      id: 'q', question: '?', detail: '', approve: labels.allowOnce, reject: labels.deny,
    }, signal)).approved).toBe(true)
  })

  it('a cancelled host question becomes an exception, not confirmation_required', async () => {
    const g = gateway(async () => { throw new Error('aborted') })
    await expect(requestConsequentialApproval(agent, g, { operation: 'CLICK', target: 'Pay now', scope: 'shop' }, labels, signal))
      .rejects.toThrow('aborted')
  })

  it('identical approve/reject labels would make Deny an approval', async () => {
    const g = gateway(async (payload: any) => ({ answers: [{ id: 'q', selected: [payload.questions[0].options[1].label] }] }))
    const result = await g.request(agent, { id: 'q', question: '?', detail: '', approve: 'Same', reject: 'Same' }, signal)
    expect(result.approved).toBe(true)              // the second option ("reject") approved the action
  })

  it('the two gates are the only approval call sites and both read the same policy object', () => {
    expect(needsConsequentialApproval({ risk: 'consequential' })).toBe(true)
    expect(needsConsequentialApproval({ risk: 'reversible' })).toBe(false)
  })
})
