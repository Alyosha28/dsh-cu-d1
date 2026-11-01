import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { verifiedSkillSchema, SkillError } from './skills.ts'
import type { VerifiedSkill } from './skills.ts'


/**
 * Evidence produced by a store-minted rerun. `independent`, `id` and `at` are
 * store-generated, so a caller can no longer assert them (CR-02).
 */
export const verificationEvidenceSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['passed', 'failed']),
  independent: z.literal(true),
  at: z.string().min(1),
  summary: z.string().min(1).regex(/^[a-z][a-z0-9_.:-]{0,99}$/u),
  /** Verification session that minted this evidence. */
  token: z.string().min(1).optional(),
}).strict()
export type VerificationEvidence = z.infer<typeof verificationEvidenceSchema>

const skillRecordSchema = verifiedSkillSchema.extend({
  state: z.enum(['candidate', 'verified', 'rejected']),
  candidateHash: z.string().regex(/^[a-f0-9]{64}$/u),
  history: z.array(verificationEvidenceSchema),
})
export type SkillRecord = z.infer<typeof skillRecordSchema>

const skillFileSchema = z.object({
  version: z.literal(1),
  skills: z.array(skillRecordSchema),
})

const queues = new Map<string, Promise<void>>()

/** A verification rerun must finish within this window. */
export const VERIFICATION_TOKEN_TTL_MS = 15 * 60 * 1000

export interface VerificationSession {
  token: string
  skillId: string
  expiresAt: string
}

interface PendingVerification {
  skillId: string
  expiresAt: number
}

interface PendingApproval {
  skillId: string
}

function assertPublishableShape(skill: Pick<VerifiedSkill, 'match' | 'verify'>): void {
  const locations = [skill.match.urlPath !== undefined, skill.match.windowTitle !== undefined, skill.match.appBundleId !== undefined]
  if (locations.filter(Boolean).length !== 1 || (skill.match.urlPath === undefined && skill.match.origin !== undefined)) {
    throw new Error('match_required: specify exactly one Skill location')
  }
  if (skill.match.urlPath !== undefined && skill.match.origin === undefined) {
    throw new Error('origin_required: URL Skills must be pinned to an exact origin')
  }
  if (skill.verify === undefined || skill.verify.length === 0) {
    throw new Error('verification_required: Skill must carry independent postconditions')
  }
}

export interface SkillStoreOptions {
  now?: () => Date
}

export class SkillStore {
  /** Records dropped by the tolerant reader and copied to `<path>.corrupt` (CR-08). */
  quarantinedRecords = 0
  private readonly now: () => Date
  private readonly verificationTokens = new Map<string, PendingVerification>()
  private readonly approvalNonces = new Map<string, PendingApproval>()

  constructor(private readonly path: string, options: SkillStoreOptions = {}) {
    this.now = options.now ?? (() => new Date())
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const path = resolve(this.path)
    const result = (queues.get(path) ?? Promise.resolve()).then(operation)
    queues.set(path, result.then(() => undefined, () => undefined))
    return result
  }

  /**
   * Tolerant read (CR-08): an unknown field, a future version, or a corrupt
   * record is quarantined instead of making the whole store unusable - one bad
   * record used to break `list()`/`get()`, and with them every browser subgoal.
   */
  private async read(): Promise<z.infer<typeof skillFileSchema>> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { version: 1, skills: [] }
      }
      throw error
    }
    if (text.trim() === '') return { version: 1, skills: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      await this.quarantine([text])
      return { version: 1, skills: [] }
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { skills?: unknown }).skills)) {
      await this.quarantine([text])
      return { version: 1, skills: [] }
    }
    const record = parsed as { version?: unknown; skills?: unknown }
    const records = Array.isArray(record?.skills) ? record.skills : []
    const skills: SkillRecord[] = []
    const corrupt: unknown[] = []
    for (const entry of records) {
      const result = skillRecordSchema.safeParse(entry)
      if (result.success) skills.push(result.data)
      else corrupt.push(entry)
    }
    if (corrupt.length > 0) {
      this.quarantinedRecords += corrupt.length
      await this.quarantineSkillRecords(corrupt)
    }
    return { version: 1, skills }
  }

  private async quarantineSkillRecords(records: unknown[]): Promise<void> {
    try {
      const existing = await readFile(`${this.path}.corrupt`, 'utf8').catch(() => '')
      await writeFile(`${this.path}.corrupt`, existing + records.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 })
    } catch {
      // Quarantine is best effort; readable records still load.
    }
  }

  private async quarantine(lines: string[]): Promise<void> {
    try {
      await writeFile(`${this.path}.corrupt`, lines.join('\n') + '\n', { mode: 0o600 })
    } catch {
      // Quarantine is best effort.
    }
  }

  private async write(value: z.infer<typeof skillFileSchema>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    await rename(temporary, this.path)
  }

  async get(id: string): Promise<SkillRecord | undefined> {
    return (await this.read()).skills.find(skill => skill.id === id)
  }

  async list(state?: SkillRecord['state']): Promise<SkillRecord[]> {
    const skills = (await this.read()).skills
    return (state === undefined ? skills : skills.filter(skill => skill.state === state))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  async createCandidate(
    input: Omit<VerifiedSkill, 'id' | 'version' | 'verifiedAt'>,
    options?: { evolveFrom?: string },
  ): Promise<SkillRecord> {
    return this.enqueue(async () => {
      assertPublishableShape(input)
    const file = await this.read()
    let version = 1
    if (options?.evolveFrom !== undefined) {
      const parent = file.skills.find(skill => skill.id === options.evolveFrom)
      if (parent === undefined) throw new Error(`Unknown skill to evolve: ${options.evolveFrom}`)
      version = parent.version + 1
    }
    const candidateInput = {
      ...input,
      ...options?.evolveFrom === undefined ? {} : { evolvedFrom: options.evolveFrom },
    }
    const candidateHash = createHash('sha256').update(JSON.stringify(candidateInput)).digest('hex')
    const id = `skill_${candidateHash.slice(0, 16)}`
    const existing = file.skills.find(skill => skill.id === id)
    if (existing !== undefined) return existing
    const record: SkillRecord = {
      id, version, verifiedAt: 'unverified', state: 'candidate', candidateHash,
      match: input.match, fallback: input.fallback, risk: input.risk, verify: input.verify, steps: input.steps,
      ...options?.evolveFrom === undefined ? {} : { evolvedFrom: options.evolveFrom },
      history: [],
    }
    file.skills.push(record)
    await this.write(file)
    return record
    })
  }

  /**
   * Starts a verification rerun. The returned token is the only way to record
   * evidence for this skill, is single-use, and expires (CR-02).
   */
  async beginVerification(skillId: string): Promise<VerificationSession> {
    return this.enqueue(async () => {
      const file = await this.read()
      const record = file.skills.find(skill => skill.id === skillId)
      if (record === undefined) throw new Error(`Unknown skill candidate: ${skillId}`)
      const token = randomBytes(32).toString('hex')
      const expiresAt = this.now().getTime() + VERIFICATION_TOKEN_TTL_MS
      this.verificationTokens.set(token, { skillId, expiresAt })
      return { token, skillId, expiresAt: new Date(expiresAt).toISOString() }
    })
  }

  /**
   * Records the outcome of a rerun started with {@link beginVerification}. The
   * timestamp, id and `independent` flag come from the store, never the caller.
   */
  async finishVerification(
    token: string,
    result: { status: 'passed' | 'failed'; summary: string; skillId?: string },
  ): Promise<VerificationEvidence> {
    return this.enqueue(async () => {
      const pending = this.verificationTokens.get(token)
      if (pending === undefined) throw new SkillError('verification_token_invalid', 'Verification token is unknown or already used')
      this.verificationTokens.delete(token)
      if (pending.expiresAt < this.now().getTime()) {
        throw new SkillError('verification_token_invalid', 'Verification token has expired')
      }
      if (result.skillId !== undefined && result.skillId !== pending.skillId) {
        throw new SkillError('verification_token_invalid', 'Verification token belongs to another Skill')
      }
      const summary = /^[a-z][a-z0-9_.:-]{0,99}$/u.test(result.summary) ? result.summary : 'verification_summary_invalid'
      const evidence: VerificationEvidence = {
        id: randomUUID(),
        status: result.status,
        independent: true,
        at: this.now().toISOString(),
        summary,
        token: token.slice(0, 16),
      }
      const file = await this.read()
      const record = file.skills.find(skill => skill.id === pending.skillId)
      if (record === undefined) throw new Error(`Unknown skill candidate: ${pending.skillId}`)
      record.history.push(evidence)
      await this.write(file)
      return evidence
    })
  }

  /**
   * Refused. Evidence can only be produced by a store-minted verification
   * session, so caller-authored evidence (including any `at` timestamp) is
   * rejected with a stable code (CR-02).
   */
  async recordVerification(id: string, _evidence?: unknown): Promise<SkillRecord> {
    const record = await this.get(id)
    if (record === undefined) throw new Error(`Unknown skill candidate: ${id}`)
    if (record.state === 'verified') throw new Error('Verified skills are immutable; create a new version')
    throw new SkillError('verification_token_required', 'Record verification through beginVerification/finishVerification')
  }

  /**
   * Mints a one-shot publish nonce from a real ApprovalGateway answer (CR-02).
   * Returns undefined when the user did not approve, so the caller keeps
   * reporting `confirmation_required`.
   */
  mintPublishNonce(skillId: string, approval: { approved: boolean; reason?: string }): string | undefined {
    if (approval.approved !== true) return undefined
    const nonce = randomUUID()
    this.approvalNonces.set(nonce, { skillId })
    return nonce
  }

  /** Test-only shim for call sites that cannot run a real gateway. */
  approvalNonceForTest(approval: { approved: boolean }, skillId: string): string | undefined {
    return this.mintPublishNonce(skillId, approval)
  }

  /**
   * Publishes a candidate. `approvalNonce` must have been minted by
   * {@link mintPublishNonce} for this exact skill. The legacy `(id, evidenceId,
   * approvedBy)` shape stays accepted by the type checker only so the two
   * providers keep compiling; at runtime it is refused with `approval_required`
   * because a string literal is not an approval.
   */
  async publish(id: string, approvalNonce: unknown, ...legacy: unknown[]): Promise<SkillRecord> {
    return this.enqueue(async () => {
      void legacy
      const pending = typeof approvalNonce === 'string' ? this.approvalNonces.get(approvalNonce) : undefined
      if (pending === undefined || pending.skillId !== id) {
        throw new SkillError('approval_required', 'approval_required: explicit user approval is required')
      }
      this.approvalNonces.delete(pending ? String(approvalNonce) : '')
      const file = await this.read()
      const record = file.skills.find(skill => skill.id === id)
      if (record === undefined) throw new Error(`Unknown skill candidate: ${id}`)
      if (record.state !== 'candidate') throw new Error(`Skill is not a candidate: ${record.state}`)
      assertPublishableShape(record)
      const latest = record.history.at(-1)
      if (latest === undefined || latest.status !== 'passed' || latest.independent !== true) {
        throw new Error('verification_required: latest independent verification must pass')
      }
      record.state = 'verified'
      record.verifiedAt = latest.at
      await this.write(file)
      return record
    })
  }

  /** Rejects a candidate. Published Skills are immutable; only `remove` retires them (CR-08). */
  async reject(id: string, reason: string): Promise<SkillRecord> {
    return this.enqueue(async () => {
    const file = await this.read()
    const record = file.skills.find(skill => skill.id === id)
    if (record === undefined) throw new Error(`Unknown skill candidate: ${id}`)
    if (record.state === 'verified') throw new SkillError('skill_immutable', 'Published Skills are immutable; remove the Skill instead')
    if (record.state !== 'candidate') throw new Error(`Skill is not a candidate: ${record.state}`)
    record.state = 'rejected'
    record.history.push({
      id: randomUUID(), status: 'failed', independent: true, at: this.now().toISOString(),
      summary: /^[a-z][a-z0-9_.:-]{0,99}$/u.test(reason) ? reason : 'rejected_by_user',
    })
    await this.write(file)
    return record
    })
  }

  /** Removes one record after an explicit user action. Published files are never overwritten in place. */
  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const file = await this.read()
      const index = file.skills.findIndex(skill => skill.id === id)
      if (index < 0) return false
      file.skills.splice(index, 1)
      await this.write(file)
      return true
    })
  }
}
