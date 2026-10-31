export interface RunBudgetLimits {
  maxWallClockMs: number
  maxInputTokens: number
  maxOutputTokens: number
}

export interface BudgetStop {
  status: 'escalated'
  reason: 'wall_clock_budget_exhausted' | 'input_token_budget_exhausted' | 'output_token_budget_exhausted'
}

function assertLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
}

/** Synchronous checks are made before model calls and input, after usage accounting, and during waits. */
export class RunBudget {
  private readonly startedAt: number
  private input = 0
  private output = 0
  private paused = 0

  constructor(readonly limits: RunBudgetLimits, private readonly now: () => number = Date.now) {
    assertLimit(limits.maxWallClockMs, 'maxWallClockMs')
    assertLimit(limits.maxInputTokens, 'maxInputTokens')
    assertLimit(limits.maxOutputTokens, 'maxOutputTokens')
    this.startedAt = now()
  }

  private elapsed(): number {
    return Math.max(0, this.now() - this.startedAt - this.paused)
  }

  /** Excludes user-initiated pause time from the wall-clock budget. */
  creditPaused(totalMs: number): void {
    if (Number.isFinite(totalMs) && totalMs > this.paused) this.paused = totalMs
  }

  checkClock(): BudgetStop | null {
    return this.elapsed() >= this.limits.maxWallClockMs
      ? { status: 'escalated', reason: 'wall_clock_budget_exhausted' }
      : null
  }

  checkBeforeDecision(): BudgetStop | null {
    const clock = this.checkClock()
    if (clock !== null) return clock
    if (this.input >= this.limits.maxInputTokens) return { status: 'escalated', reason: 'input_token_budget_exhausted' }
    if (this.output >= this.limits.maxOutputTokens) return { status: 'escalated', reason: 'output_token_budget_exhausted' }
    return null
  }

  consume(inputTokens: number, outputTokens: number): BudgetStop | null {
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
      throw new Error('model token usage must contain non-negative safe integers')
    }
    this.input += inputTokens
    this.output += outputTokens
    if (this.input > this.limits.maxInputTokens) return { status: 'escalated', reason: 'input_token_budget_exhausted' }
    if (this.output > this.limits.maxOutputTokens) return { status: 'escalated', reason: 'output_token_budget_exhausted' }
    return this.checkClock()
  }

  remainingWallClockMs(): number {
    return Math.max(0, this.limits.maxWallClockMs - this.elapsed())
  }

  usage(): { inputTokens: number; outputTokens: number; elapsedMs: number } {
    return { inputTokens: this.input, outputTokens: this.output, elapsedMs: this.elapsed() }
  }
}
