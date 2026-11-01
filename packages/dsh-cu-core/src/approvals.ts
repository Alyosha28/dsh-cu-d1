import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'


export interface ApprovalRequest {
  id: string
  question: string
  detail: string
  approve: string
  reject: string
}

export interface SelectionRequest {
  id: string
  question: string
  detail: string
  options: string[]
}

export interface SelectionResult {
  selected?: string
  reason?: string
}

/**
 * Runtime shape of one host answer. The host schema is validated here instead
 * of cast, so a non-array `selected`, a mismatched id, or a collided label can
 * never approve anything (CR-11).
 */
const answerSchema = z.object({
  id: z.string(),
  selected: z.array(z.string()),
  custom: z.string().optional(),
}).passthrough()

export class ApprovalGateway {
  constructor(private readonly ctx: Context) {}

  async request(agent: Agent, request: ApprovalRequest, signal: AbortSignal): Promise<{ approved: boolean; reason?: string }> {
    if (request.approve === request.reject) return { approved: false, reason: 'approval_malformed' }
    const questions = this.ctx.get('userQuestions')
    if (questions === undefined) return { approved: false, reason: 'approval_unavailable' }
    let raw: unknown
    try {
      raw = await questions.ask({
        agent,
        signal,
        questions: [{
          id: request.id,
          question: request.question,
          detail: request.detail,
          options: [{ label: request.approve }, { label: request.reject }],
          intent: { kind: 'approval', approve: request.approve, reject: request.reject },
        }],
      })
    } catch {
      return { approved: false, reason: 'approval_cancelled' }
    }
    const answers = z.array(answerSchema).safeParse((raw as { answers?: unknown } | undefined)?.answers)
    if (!answers.success) return { approved: false, reason: 'approval_malformed' }
    const answer = answers.data.find(candidate => candidate.id === request.id)
    if (answer === undefined) return { approved: false, reason: 'approval_malformed' }
    const custom = answer.custom?.trim() ?? ''
    if (custom !== '') return { approved: false, reason: 'denied_by_user' }
    // Only an exact, single, verbatim selection of the approve label approves;
    // anything else that is not a clean rejection is a malformed answer.
    if (answer.selected.length === 1 && answer.selected[0] === request.approve) return { approved: true }
    if (answer.selected.length === 1 && answer.selected[0] === request.reject) return { approved: false, reason: 'denied_by_user' }
    return { approved: false, reason: 'approval_malformed' }
  }

  /** Asks the user to choose one option, for example one of several native windows. */
  async select(agent: Agent, request: SelectionRequest, signal: AbortSignal): Promise<SelectionResult> {
    const questions = this.ctx.get('userQuestions')
    if (questions === undefined) return { reason: 'selection_unavailable' }
    let raw: unknown
    try {
      raw = await questions.ask({
        agent,
        signal,
        questions: [{
          id: request.id,
          question: request.question,
          detail: request.detail,
          options: request.options.map(label => ({ label })),
        }],
      })
    } catch {
      return { reason: 'selection_cancelled' }
    }
    const answers = z.array(answerSchema).safeParse((raw as { answers?: unknown } | undefined)?.answers)
    if (!answers.success) return { reason: 'selection_cancelled' }
    const answer = answers.data.find(candidate => candidate.id === request.id)
    const selected = answer?.selected.find(label => request.options.includes(label))
    if (selected === undefined) return { reason: 'selection_cancelled' }
    return { selected }
  }
}
