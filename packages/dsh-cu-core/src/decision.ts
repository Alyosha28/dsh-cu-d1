import { z } from 'zod'
export interface DecisionClientConfig {
  decisionEndpoint: string
  decisionToken: string
  decisionTimeoutMs: number
  textStrategy: 'speculative' | 'on-demand'
}


const decisionSchema = z.object({
  operation: z.enum(['CLICK', 'TYPE_TEXT', 'PASTE_TEXT', 'INCREMENT', 'DECREMENT', 'SCROLL_UP', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED']),
  target: z.string().nullable(),
  confidence: z.number().optional(),
  text: z.string().optional(),
  box: z.object({
    top: z.number().finite().min(0).max(1),
    bottom: z.number().finite().min(0).max(1),
    left: z.number().finite().min(0).max(1),
    right: z.number().finite().min(0).max(1),
  }).refine(box => box.left < box.right && box.top < box.bottom, {
    message: 'box must have positive area and ordered normalized edges',
  }).optional(),
  found: z.number().optional(),
}).passthrough()

const responseSchema = z.object({
  decision: decisionSchema,
  usage: z.object({
    input_tokens: z.number().int().nonnegative().safe(),
    output_tokens: z.number().int().nonnegative().safe(),
  }).passthrough(),
  latencyMs: z.number().nonnegative(),
  textExtractionCalls: z.number().int().nonnegative(),
})

export type Decision = z.infer<typeof decisionSchema>
export type DecisionResult = z.infer<typeof responseSchema>

export class D1DecisionClient {
  private readonly decideUrl: string
  constructor(private readonly config: DecisionClientConfig) {
    const endpoint = new URL(config.decisionEndpoint)
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname)) {
      throw new Error('decisionEndpoint must be a loopback HTTP URL')
    }
    if (endpoint.username || endpoint.password) throw new Error('decisionEndpoint must not contain credentials')
    this.decideUrl = new URL('/decide', endpoint).toString()
  }

  async decide(
    goal: string,
    observation: unknown,
    signal: AbortSignal,
    inputs?: Record<string, string>,
    screenshot?: { data: string; mimeType: string },
  ): Promise<DecisionResult> {
    if (process.env.DEBUG_D1 === '1') {
      const elements = typeof observation === 'object' && observation !== null && 'elements' in observation && Array.isArray(observation.elements)
        ? observation.elements.length : undefined
      console.error('D1_REQUEST', JSON.stringify({ textStrategy: this.config.textStrategy, elements, hasScreenshot: screenshot !== undefined }))
    }
    const response = await fetch(this.decideUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.decisionToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ goal, observation, textStrategy: this.config.textStrategy, inputs, screenshot }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.decisionTimeoutMs)]),
    })
    const text = await response.text()
    if (process.env.DEBUG_D1 === '1') console.error('D1_RESPONSE', JSON.stringify({ status: response.status, bytes: text.length }))
    if (text.length > 2_000_000) throw new Error('D1 decision response exceeded size limit')
    if (!response.ok) {
      let detail = text.slice(0, 500)
      try {
        const parsed = JSON.parse(text) as { message?: unknown }
        if (typeof parsed.message === 'string') detail = parsed.message.slice(0, 500)
      } catch { /* retain bounded response text */ }
      throw new Error(`D1 decision service returned ${response.status}: ${detail}`)
    }
    return responseSchema.parse(JSON.parse(text))
  }
}
