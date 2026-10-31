import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

export interface ToolFixtureInput {
  agent?: Agent
  name: string
  arguments: unknown
  callId: ToolCallId
  signal: AbortSignal
}

/**
 * Executes one tool through the production registry, as the agent loop does.
 *
 * The DSH 0.2.2 test kit is a separate package that pins the 0.2.2 runtime; the
 * registry in 0.2.1 already exposes `execute`, so tests call it directly and
 * stay on the same package versions as the running Harness.
 */
export function executeToolFixture(ctx: Context, input: ToolFixtureInput): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: input.callId,
    name: input.name,
    arguments: input.arguments,
    ...input.agent === undefined ? {} : { agent: input.agent },
    signal: input.signal,
  })
}
