import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'


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

export class ApprovalGateway {
  constructor(private readonly ctx: Context) {}

  async request(agent: Agent, request: ApprovalRequest, signal: AbortSignal): Promise<{ approved: boolean; reason?: string }> {
    const questions = this.ctx.get('userQuestions')
    if (questions === undefined) return { approved: false, reason: 'approval_unavailable' }
    const result = await questions.ask({
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
    const answer = (result.answers as Array<{ id: string; custom?: string; selected: string[] }>).find(answer => answer.id === request.id)
    if (answer && !answer.custom?.trim() && answer.selected.includes(request.approve)) return { approved: true }
    return { approved: false, reason: 'denied_by_user' }
  }

  /** Asks the user to choose one option, for example one of several native windows. */
  async select(agent: Agent, request: SelectionRequest, signal: AbortSignal): Promise<SelectionResult> {
    const questions = this.ctx.get('userQuestions')
    if (questions === undefined) return { reason: 'selection_unavailable' }
    const result = await questions.ask({
      agent,
      signal,
      questions: [{
        id: request.id,
        question: request.question,
        detail: request.detail,
        options: request.options.map(label => ({ label })),
      }],
    })
    const answer = (result.answers as Array<{ id: string; custom?: string; selected: string[] }>).find(answer => answer.id === request.id)
    const selected = answer?.selected.find(label => request.options.includes(label))
    if (selected === undefined) return { reason: 'selection_cancelled' }
    return { selected }
  }
}
