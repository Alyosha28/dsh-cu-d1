import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'


export const auditEventSchema = z.object({
  id: z.string().min(1),
  at: z.string().datetime(),
  agentId: z.string().min(1),
  runId: z.string().optional(),
  kind: z.string().regex(/^[a-z][a-z0-9_.:-]{0,99}$/u),
  detail: z.record(z.string(), z.json()).optional(),
}).strict()
export type AuditEvent = z.infer<typeof auditEventSchema>

export interface AuditStoreOptions {
  retentionDays?: number
  now?: () => Date
}

const DEFAULT_RETENTION_DAYS = 30
const MAX_DETAIL_STRING_LENGTH = 200
const queues = new Map<string, Promise<void>>()
const SAFE_DETAIL_KEYS = new Set([
  'kind', 'status', 'reason', 'route', 'action', 'operation',
  'decisionRequests', 'modelForwardCalls', 'actionsExecuted',
  'inputTokens', 'outputTokens', 'elapsedMs', 'limit',
])

function safeString(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[^\s,;]+/giu, '$1[redacted]')
    .replace(/\b(password|passwd|token|secret|credential|cookie)(\s*[:=]\s*)[^\s,;]+/giu, '$1$2[redacted]')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .slice(0, MAX_DETAIL_STRING_LENGTH)
}

/** Only stable operational fields are persisted. Page goals, inputs, URLs and screenshots are never allowlisted. */
export function sanitizeAuditDetail(detail: Record<string, unknown> | undefined): Record<string, string | number | boolean> | undefined {
  if (detail === undefined) return undefined
  const safe: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(detail)) {
    if (!SAFE_DETAIL_KEYS.has(key)) continue
    if (typeof value === 'string') safe[key] = safeString(value)
    else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value
    else if (typeof value === 'boolean') safe[key] = value
  }
  return Object.keys(safe).length === 0 ? undefined : safe
}

export class AuditStore {
  private readonly retentionDays: number
  private readonly now: () => Date

  constructor(private readonly path: string, options: AuditStoreOptions = {}) {
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS
    if (!Number.isFinite(this.retentionDays) || this.retentionDays <= 0) {
      throw new Error('audit retentionDays must be a positive finite number')
    }
    this.now = options.now ?? (() => new Date())
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const path = resolve(this.path)
    const result = (queues.get(path) ?? Promise.resolve()).then(operation)
    queues.set(path, result.then(() => undefined, () => undefined))
    return result
  }

  private async read(): Promise<AuditEvent[]> {
    try {
      const text = await readFile(this.path, 'utf8')
      return text.trim() === '' ? [] : text.trim().split('\n').map(line => auditEventSchema.parse(JSON.parse(line)))
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
  }

  private retained(events: AuditEvent[]): AuditEvent[] {
    const cutoff = this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000
    return events.filter(event => Date.parse(event.at) >= cutoff)
  }

  private async write(events: AuditEvent[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = join(dirname(this.path), `.${randomUUID()}.tmp`)
    await writeFile(temporary, events.map(event => JSON.stringify(event) + '\n').join(''), { mode: 0o600 })
    await rename(temporary, this.path)
  }

  async append(event: Omit<AuditEvent, 'id' | 'at'>): Promise<AuditEvent> {
    return this.enqueue(async () => {
      const complete = auditEventSchema.parse({
        id: randomUUID(),
        at: this.now().toISOString(),
        ...event,
        detail: sanitizeAuditDetail(event.detail),
      })
      const events = this.retained([...await this.read(), complete])
      await this.write(events)
      return complete
    })
  }

  async list(limit = 50): Promise<AuditEvent[]> {
    if (!Number.isInteger(limit) || limit < 0) throw new Error('audit list limit must be a non-negative integer')
    const events = await this.enqueue(async () => {
      const retained = this.retained(await this.read())
      await this.write(retained)
      return retained
    })
    return events.slice(-limit).reverse()
  }
}
