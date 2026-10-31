import type { Decision, Observation } from './types.ts'


const TARGET_OPERATIONS: Record<string, string> = {
  CLICK: 'click', TYPE_TEXT: 'type', PASTE_TEXT: 'paste', INCREMENT: 'increment', DECREMENT: 'decrement',
}

export function validateDecision(observation: Observation, decision: Decision): void {
  const action = TARGET_OPERATIONS[decision.operation]
  if (action === undefined) {
    if (decision.operation === 'SCROLL_UP' && !observation.can_scroll_up) throw new Error('SCROLL_UP unavailable')
    if (decision.operation === 'SCROLL_DOWN' && !observation.can_scroll_down) throw new Error('SCROLL_DOWN unavailable')
    if (!['WAIT', 'DONE', 'BLOCKED', 'SCROLL_UP', 'SCROLL_DOWN'].includes(decision.operation)) {
      throw new Error(`Operation ${decision.operation} unavailable`)
    }
    return
  }
  const candidates = observation.elements.filter(element => element.enabled && element.actions.includes(action))
  if (decision.target === null && observation.screenshot !== undefined && decision.box !== undefined) {
    if (['TYPE_TEXT', 'PASTE_TEXT'].includes(decision.operation) && (!decision.text || decision.text.length === 0)) {
      throw new Error(`${decision.operation} requires extracted literal text`)
    }
    return
  }
  if (!candidates.some(element => element.id === decision.target)) {
    throw new Error(`Target ${decision.target} is not valid for ${decision.operation}`)
  }
  if (['TYPE_TEXT', 'PASTE_TEXT'].includes(decision.operation) && (!decision.text || decision.text.length === 0)) {
    throw new Error(`${decision.operation} requires extracted literal text`)
  }
}
