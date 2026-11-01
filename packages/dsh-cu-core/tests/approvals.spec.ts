/**
 * CR-11 — an approval answer must be validated, not cast.
 *
 * A non-array `selected`, a label collision (approve === reject), or a throwing
 * question service must all resolve to "denied", never "approved".
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ApprovalGateway } from '../src/approvals.ts'

type Answer = { id: string; selected?: unknown; custom?: string }

function gatewayWith(answers: Answer[] | (() => Promise<never>)) {
  const ctx = {
    get: (name: string) => name === 'userQuestions'
      ? {
        ask: async () => (typeof answers === 'function' ? answers() : { answers }),
      }
      : undefined,
  } as any
  return new ApprovalGateway(ctx)
}

const request = { id: 'q1', question: 'Allow?', detail: 'detail', approve: 'Allow once', reject: 'Deny' }
const controller = new AbortController()
afterEach(() => controller.abort())

describe('ApprovalGateway.request', () => {
  it('approves only an exact array selection of the approve label', async () => {
    await expect(gatewayWith([{ id: 'q1', selected: ['Allow once'] }]).request({} as any, request, controller.signal))
      .resolves.toMatchObject({ approved: true })
  })

  it('fails closed on a non-array selected value', async () => {
    const result = await gatewayWith([{ id: 'q1', selected: 'Allow once' }]).request({} as any, request, controller.signal)
    expect(result.approved).toBe(false)
    expect(result.reason).toBe('approval_malformed')
    const padded = await gatewayWith([{ id: 'q1', selected: ['x Allow once x'] }]).request({} as any, request, controller.signal)
    expect(padded).toMatchObject({ approved: false, reason: 'approval_malformed' })
  })

  it('fails closed when the answer id does not match the question', async () => {
    await expect(gatewayWith([{ id: 'other', selected: ['Allow once'] }]).request({} as any, request, controller.signal))
      .resolves.toMatchObject({ approved: false, reason: 'approval_malformed' })
    await expect(gatewayWith([]).request({} as any, request, controller.signal))
      .resolves.toMatchObject({ approved: false, reason: 'approval_malformed' })
  })

  it('denies a free-text answer even when the label is selected', async () => {
    await expect(gatewayWith([{ id: 'q1', selected: ['Allow once'], custom: 'yes' }]).request({} as any, request, controller.signal))
      .resolves.toMatchObject({ approved: false, reason: 'denied_by_user' })
  })

  it('fails closed on a label collision', async () => {
    const collide = { ...request, approve: 'Deny', reject: 'Deny' }
    const result = await gatewayWith([{ id: 'q1', selected: ['Deny'] }]).request({} as any, collide, controller.signal)
    expect(result).toMatchObject({ approved: false, reason: 'approval_malformed' })
  })

  it('turns a throwing question service into a denial', async () => {
    const gateway = gatewayWith(async () => { throw new Error('cancelled by host') })
    await expect(gateway.request({} as any, request, controller.signal))
      .resolves.toMatchObject({ approved: false, reason: 'approval_cancelled' })
  })

  it('reports approval_unavailable without a question service', async () => {
    const gateway = new ApprovalGateway({ get: () => undefined } as any)
    await expect(gateway.request({} as any, request, controller.signal))
      .resolves.toMatchObject({ approved: false, reason: 'approval_unavailable' })
  })
})

describe('ApprovalGateway.select', () => {
  it('ignores a malformed selection', async () => {
    const ask = { id: 'q2', question: 'Which window?', detail: '', options: ['A', 'B'] }
    await expect(gatewayWith([{ id: 'q2', selected: 'A' }]).select({} as any, ask, controller.signal))
      .resolves.toEqual({ reason: 'selection_cancelled' })
    await expect(gatewayWith([{ id: 'q2', selected: ['B'] }]).select({} as any, ask, controller.signal))
      .resolves.toEqual({ selected: 'B' })
  })
})
