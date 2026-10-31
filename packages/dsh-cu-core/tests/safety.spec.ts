import { expect, it } from 'vitest'
import { ConsequentialActionGuard, resolveDuplicateActionApproval } from '../src/action-guard.ts'
import { RunBudget } from '../src/budget.ts'


it('enforces wall-clock and token budgets before further actions', () => {
  let now = 1000
  const budget = new RunBudget({ maxWallClockMs: 100, maxInputTokens: 10, maxOutputTokens: 5 }, () => now)
  expect(budget.checkClock()).toBeNull()
  expect(budget.consume(9, 4)).toBeNull()
  expect(budget.consume(1, 0)).toBeNull()
  expect(budget.checkBeforeDecision()).toEqual({ status: 'escalated', reason: 'input_token_budget_exhausted' })
  expect(budget.consume(1, 0)).toEqual({ status: 'escalated', reason: 'input_token_budget_exhausted' })
  now = 1100
  expect(budget.checkClock()).toEqual({ status: 'escalated', reason: 'wall_clock_budget_exhausted' })
  expect(budget.remainingWallClockMs()).toBe(0)
})

it('excludes user pause time from the wall clock budget', () => {
  let now = 1000
  const budget = new RunBudget({ maxWallClockMs: 100, maxInputTokens: 10, maxOutputTokens: 5 }, () => now)
  now = 1050
  expect(budget.checkClock()).toBeNull()
  budget.creditPaused(40)
  expect(budget.checkClock()).toBeNull()
  now = 1141
  expect(budget.checkClock()).toEqual({ status: 'escalated', reason: 'wall_clock_budget_exhausted' })
})

it('requires one fresh approval for a repeated consequential action without retaining raw input', () => {
  let now = 1000
  const guard = new ConsequentialActionGuard(1000, () => now)
  const action = {
    scope: 'https://example.test/form', goal: 'Delete the draft', operation: 'CLICK', target: '7',
    text: 'sensitive-user-input', risk: 'consequential' as const,
  }
  const first = guard.check(action)
  expect(first.requiresConfirmation).toBe(false)
  guard.recordDispatched(first.fingerprint)
  const duplicate = guard.check(action)
  expect(duplicate).toMatchObject({ requiresConfirmation: true, reason: 'duplicate_consequential_action_requires_approval' })
  guard.approveOnce(duplicate.fingerprint)
  expect(guard.check(action).requiresConfirmation).toBe(false)
  guard.recordDispatched(duplicate.fingerprint)
  expect(guard.check(action).requiresConfirmation).toBe(true)
  now = 2001
  expect(guard.check(action).requiresConfirmation).toBe(false)
  expect(JSON.stringify(guard)).not.toContain(action.text)
  expect(JSON.stringify(guard)).not.toContain(action.goal)
})

it('reserves a consequential action before dispatch to close concurrent duplicate checks', () => {
  const guard = new ConsequentialActionGuard()
  const action = { scope: 'app://1/2', goal: 'Send once', operation: 'CLICK', target: '3', risk: 'consequential' as const }
  const first = guard.check(action)
  expect(first.requiresConfirmation).toBe(false)
  expect(guard.check(action).requiresConfirmation).toBe(true)
  guard.releaseBeforeDispatch(first.fingerprint)
  expect(guard.check(action).requiresConfirmation).toBe(false)
})

it('does not impose consequential confirmation on reversible actions', () => {
  const guard = new ConsequentialActionGuard()
  const action = { scope: 'app://1/2', goal: 'Edit local draft', operation: 'TYPE_TEXT', target: '3', risk: 'reversible' as const }
  const first = guard.check(action)
  guard.recordDispatched(first.fingerprint)
  expect(guard.check(action).requiresConfirmation).toBe(false)
})
