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
  'kind', 'status', 'reason', 'route', 'action', 'operation', 'removed',
  'decisionRequests', 'modelForwardCalls', 'actionsExecuted',
  'inputTokens', 'outputTokens', 'elapsedMs', 'limit',
])

/**
 * Key names that introduce a secret. Written as an alternation of *substrings*
 * (not word-anchored) so `access_token`, `refreshToken` and `client_secret` all
 * match, and paired with `:`/`=`/full-width `：`/`＝` as separators (CR-05).
 */
const SECRET_KEY = String.raw`(?:[a-z0-9_.-]*(?:password|passwd|passphrase|secret|token|apikey|credential|cookie|authorization|auth|privatekey|sessionkey)[a-z0-9_.-]*|api[_-]?key|private[_-]?key|session[_-]?key|x-auth[a-z-]*)`
const SECRET_SEPARATOR = String.raw`\s*[:=\uff1a\uff1d]\s*`
/**
 * After the separator, consume the whole value: no `,`/`;`/space boundary is
 * trusted, because `token=abc def` and `password=abc,retry=1` both used to leak
 * the tail of the secret.
 */
const SECRET_VALUE = String.raw`[^\n\r]*`

const SEPARATOR_PATTERN = /[:=\uff1a\uff1d]/u

function redactSecrets(value: string): string {
  return value
    .replace(/\b(Bearer|Basic|Digest|Token)\s+[^\s,;]+/giu, '$1 [redacted]')
    .replace(new RegExp(`${SECRET_KEY}${SECRET_SEPARATOR}${SECRET_VALUE}`, 'giu'), match => {
      const index = match.search(SEPARATOR_PATTERN)
      return `${match.slice(0, index)}${match[index]}[redacted]`
    })
}

function safeString(value: string): string {
  return redactSecrets(value)
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
  /** Count of lines dropped by the tolerant reader (CR-08). */
  quarantinedLines = 0
  private quarantined = 0

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

  /**
   * Tolerant read (CR-08): an unparseable or schema-invalid line is quarantined
   * - copied aside and dropped from the live file - so one bad line can never
   * make the whole audit chain permanently unreadable.
   */
  private async read(): Promise<AuditEvent[]> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    if (text.trim() === '') return []
    const events: AuditEvent[] = []
    const corrupt: string[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        events.push(auditEventSchema.parse(JSON.parse(line)))
      } catch {
        corrupt.push(line)
      }
    }
    if (corrupt.length > 0) {
      this.quarantined = this.quarantined + corrupt.length
    this.quarantinedLines = this.quarantined
      await this.quarantine(corrupt)
    }
    return events
  }

  private async quarantine(lines: string[]): Promise<void> {
    try {
      await writeFile(`${this.path}.corrupt`, lines.join('\n') + '\n', { mode: 0o600 })
      // The live file is rewritten from the records that parsed; `read()`
      // already holds them, and `append()` rewrites the file right after.
      const kept: AuditEvent[] = []
      for (const line of (await readFile(this.path, 'utf8')).split('\n')) {
        if (line.trim() === '' || lines.includes(line)) continue
        try {
          kept.push(auditEventSchema.parse(JSON.parse(line)))
        } catch { /* already quarantined */ }
      }
      await this.write(kept)
    } catch {
      // Quarantine is best effort; the readable records still go out.
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

  /** Number of lines dropped by the tolerant reader. */
  get quarantinedLineCount(): number {
    return this.quarantined
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
