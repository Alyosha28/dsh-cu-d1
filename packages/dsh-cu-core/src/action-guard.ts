import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalGateway } from './approvals.ts'


export interface ActionFingerprintInput {
  scope: string
  goal: string
  operation: string
  target: string | null
  text?: string
  risk: 'read_only' | 'reversible' | 'consequential'
}

export interface ActionGuardCheck {
  fingerprint: string
  requiresConfirmation: boolean
  reason?: 'duplicate_consequential_action_requires_approval'
}

interface GuardEntry {
  dispatchedAt: number
  approvedOnce: boolean
  pending: boolean
  everDispatched: boolean
}

/** In-memory duplicate-side-effect guard. It deliberately does not claim exactly-once UI execution. */
export class ConsequentialActionGuard {
  private readonly entries = new Map<string, GuardEntry>()

  constructor(private readonly windowMs = 5 * 60 * 1000, private readonly now: () => number = Date.now) {
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error('duplicate action window must be a positive safe integer')
  }

  check(input: ActionFingerprintInput): ActionGuardCheck {
    const fingerprint = createHash('sha256').update(JSON.stringify([
      input.scope, input.goal, input.operation, input.target, input.text ?? null,
    ])).digest('hex')
    if (input.risk !== 'consequential') return { fingerprint, requiresConfirmation: false }
    this.purge()
    const previous = this.entries.get(fingerprint)
    if (previous === undefined) {
      this.entries.set(fingerprint, { dispatchedAt: this.now(), approvedOnce: false, pending: true, everDispatched: false })
      return { fingerprint, requiresConfirmation: false }
    }
    if (previous.approvedOnce) {
      previous.approvedOnce = false
      previous.pending = true
      return { fingerprint, requiresConfirmation: false }
    }
    return { fingerprint, requiresConfirmation: true, reason: 'duplicate_consequential_action_requires_approval' }
  }

  approveOnce(fingerprint: string): void {
    const previous = this.entries.get(fingerprint)
    if (previous === undefined) throw new Error('cannot approve an action that has not been dispatched')
    previous.approvedOnce = true
  }

  recordDispatched(fingerprint: string): void {
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error('invalid action fingerprint')
    this.entries.set(fingerprint, { dispatchedAt: this.now(), approvedOnce: false, pending: false, everDispatched: true })
  }

  releaseBeforeDispatch(fingerprint: string): void {
    const previous = this.entries.get(fingerprint)
    if (previous === undefined || !previous.pending) return
    previous.pending = false
    if (!previous.everDispatched) this.entries.delete(fingerprint)
  }

  private purge(): void {
    const cutoff = this.now() - this.windowMs
    for (const [fingerprint, entry] of this.entries) {
      if (entry.dispatchedAt <= cutoff) this.entries.delete(fingerprint)
    }
  }
}

export async function resolveDuplicateActionApproval(
  guard: ConsequentialActionGuard,
  check: ActionGuardCheck,
  agent: Agent,
  gateway: ApprovalGateway | undefined,
  signal: AbortSignal,
): Promise<{ status: 'confirmation_required'; reason: string } | null> {
  if (!check.requiresConfirmation) return null
  if (gateway === undefined) return { status: 'confirmation_required', reason: 'duplicate_consequential_action_requires_approval' }
  const approval = await gateway.request(agent, {
    id: 'dsh-cu-duplicate-consequential',
    question: 'Allow a repeated consequential UI action?',
    detail: 'The same scoped goal, operation, target, and input was already dispatched recently. Confirm only if repeating it is intentional.',
    approve: 'Repeat once',
    reject: 'Do not repeat',
  }, signal)
  if (!approval.approved) return { status: 'confirmation_required', reason: approval.reason ?? 'duplicate_consequential_action_requires_approval' }
  guard.approveOnce(check.fingerprint)
  return null
}
