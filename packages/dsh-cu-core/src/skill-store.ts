import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { verifiedSkillSchema } from './skills.ts'
import type { VerifiedSkill } from './skills.ts'


export const verificationEvidenceSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['passed', 'failed']),
  independent: z.literal(true),
  at: z.string().min(1),
  summary: z.string().min(1),
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

export class SkillStore {
  constructor(private readonly path: string) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const path = resolve(this.path)
    const result = (queues.get(path) ?? Promise.resolve()).then(operation)
    queues.set(path, result.then(() => undefined, () => undefined))
    return result
  }

  private async read(): Promise<z.infer<typeof skillFileSchema>> {
    try {
      return skillFileSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { version: 1, skills: [] }
      }
      throw error
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

  async recordVerification(id: string, evidence: Omit<VerificationEvidence, 'id'>): Promise<SkillRecord> {
    return this.enqueue(async () => {
    const file = await this.read()
    const record = file.skills.find(skill => skill.id === id)
    if (record === undefined) throw new Error(`Unknown skill candidate: ${id}`)
    if (record.state === 'verified') throw new Error('Verified skills are immutable; create a new version')
    const complete: VerificationEvidence = { id: randomUUID(), ...evidence }
    record.history.push(complete)
    await this.write(file)
    return record
    })
  }

  async publish(id: string, evidenceId: string, approvedBy: 'user' | 'system'): Promise<SkillRecord> {
    return this.enqueue(async () => {
    if (approvedBy !== 'user') throw new Error('approval_required: explicit user approval is required')
    const file = await this.read()
    const record = file.skills.find(skill => skill.id === id)
    if (record === undefined) throw new Error(`Unknown skill candidate: ${id}`)
    if (record.state !== 'candidate') throw new Error(`Skill is not a candidate: ${record.state}`)
    assertPublishableShape(record)
    const latest = record.history.at(-1)
    if (latest === undefined || latest.id !== evidenceId || latest.status !== 'passed' || latest.independent !== true) {
      throw new Error('verification_required: latest independent verification must pass')
    }
    record.state = 'verified'
    record.verifiedAt = latest.at
    await this.write(file)
    return record
    })
  }

  async reject(id: string, reason: string): Promise<SkillRecord> {
    return this.enqueue(async () => {
    const file = await this.read()
    const record = file.skills.find(skill => skill.id === id)
    if (record === undefined) throw new Error(`Unknown skill candidate: ${id}`)
    record.state = 'rejected'
    record.history.push({ id: randomUUID(), status: 'failed', independent: true, at: new Date().toISOString(), summary: reason })
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
