import type { SkillStore, VerificationEvidence } from './skill-store.ts'
import { isWellFormedJson, sanitizeSkillVerifications } from './skills.ts'
import type { SkillStep } from './skills.ts'


export interface TrajectoryStep {
  operation: string
  targetName?: string
  targetIdentifier?: string
  target?: string | null
  [key: string]: unknown
}

export interface CapturedInput {
  targetName: string
  value: string
}

export interface SkillTrajectory {
  route: string
  status: string
  trace: TrajectoryStep[]
  verify: unknown
  inputs?: Record<string, string>
  /** Ordered, in-memory values used for redaction; never persisted directly. */
  capturedValues?: CapturedInput[]
  match: { urlPath?: string; origin?: string; windowTitle?: string; appBundleId?: string }
  risk?: 'read_only' | 'reversible' | 'consequential'
  /** Published Skill this trajectory repaired; produces a new versioned candidate. */
  evolveFrom?: string
}

function inputKey(target: string, occurrence: number): string {
  return occurrence === 1 ? target : `${target}#${occurrence}`
}

function inputKeysFromTrajectory(trace: TrajectoryStep[]): string[] {
  const keys: string[] = []
  const occurrences = new Map<string, number>()
  const used = new Set<string>()
  for (const step of trace) {
    if (step.operation !== 'TYPE_TEXT' && step.operation !== 'PASTE_TEXT') continue
    const target = step.targetName?.trim() ?? ''
    const occurrence = (occurrences.get(target) ?? 0) + 1
    occurrences.set(target, occurrence)
    const base = inputKey(target, occurrence)
    let key = base
    let suffix = 2
    while (used.has(key)) {
      key = `${base}#${suffix}`
      suffix += 1
    }
    used.add(key)
    keys.push(key)
  }
  return keys
}

export function stepsFromTrajectory(trace: TrajectoryStep[]): SkillStep[] | null {
  const steps: SkillStep[] = []
  const inputKeys = inputKeysFromTrajectory(trace)
  let inputIndex = 0
  for (const step of trace) {
    if (step.dispatched === false) return null
    const target = step.targetIdentifier?.trim() || step.targetName?.trim()
    if (!target) return null
    if (step.operation === 'CLICK') steps.push({ type: 'click', target })
    else if (step.operation === 'INCREMENT') steps.push({ type: 'increment', target })
    else if (step.operation === 'DECREMENT') steps.push({ type: 'decrement', target })
    else if (step.operation === 'TYPE_TEXT' || step.operation === 'PASTE_TEXT') {
      steps.push({ type: step.operation === 'PASTE_TEXT' ? 'paste' : 'type', target, input: inputKeys[inputIndex] })
      inputIndex += 1
    } else return null
  }
  return steps.length > 0 ? steps : null
}

function isInputStep(step: TrajectoryStep): boolean {
  return step.operation === 'TYPE_TEXT' || step.operation === 'PASTE_TEXT'
}

/**
 * Values that must never be persisted in a Skill. The builder collects every
 * text it dispatched (TYPE_TEXT *and* PASTE_TEXT) plus the caller's structured
 * inputs, so a value that never made it into `capturedValues` still has to be
 * replaced by a placeholder before the candidate is written (CR-09).
 */
function secretsInTrajectory(trajectory: SkillTrajectory): string[] {
  const secrets: string[] = []
  for (const step of trajectory.trace) {
    if (!isInputStep(step) || step.dispatched === false) continue
    if (typeof step.text === 'string' && step.text !== '') secrets.push(step.text)
  }
  for (const value of Object.values(trajectory.inputs ?? {})) {
    if (value !== '') secrets.push(value)
  }
  return secrets
}

function capturedInputsForTrajectory(trajectory: SkillTrajectory): Record<string, string> | null {
  const inputs = Object.create(null) as Record<string, string>
  const inputKeys = inputKeysFromTrajectory(trajectory.trace)
  let captureIndex = 0
  for (const step of trajectory.trace) {
    if (!isInputStep(step)) continue
    const target = step.targetName?.trim()
    const key = inputKeys[captureIndex]
    const captured = trajectory.capturedValues?.[captureIndex]
    captureIndex += 1
    if (!target) return null
    if (captured === undefined) continue
    if (captured.targetName !== target) return null
    inputs[key] = captured.value
  }
  if (captureIndex !== trajectory.capturedValues?.length && trajectory.capturedValues !== undefined) return null
  return inputs
}

export async function createCandidateFromTrajectory(
  store: SkillStore,
  trajectory: SkillTrajectory,
) {
  if (trajectory.route !== 'd1' || trajectory.status !== 'success' || !isWellFormedJson(trajectory)) return undefined
  const steps = stepsFromTrajectory(trajectory.trace)
  if (steps === null) return undefined
  const captured = capturedInputsForTrajectory(trajectory)
  if (captured === null) return undefined
  for (const [key, value] of Object.entries(captured)) {
    if (Object.hasOwn(trajectory.inputs ?? {}, key) && trajectory.inputs![key] !== value) return undefined
  }
  const inputs = Object.assign(Object.create(null), trajectory.inputs, captured) as Record<string, string>
  const storedMetadata = [
    trajectory.match.urlPath, trajectory.match.origin, trajectory.match.windowTitle, trajectory.match.appBundleId,
    ...steps.map(step => step.type === 'wait' ? undefined : step.target),
  ]
  const containsRawInput = Object.values(inputs).some(value => {
    if (value === '') return false
    const encoded = encodeURIComponent(value)
    return storedMetadata.some(text => text?.includes(value) || (encoded !== value && text?.includes(encoded)))
  })
  if (containsRawInput) return undefined
  const secrets = [...new Set([...Object.values(inputs), ...secretsInTrajectory(trajectory)].filter(value => value !== ''))]
  const verify = sanitizeSkillVerifications(trajectory.verify, inputs, secrets)
  if (verify === null) return undefined
  // Refuse to persist a candidate while any dispatched value survives in the
  // assertions: it would be written to skills.json in clear text (CR-09).
  if (containsVerbatim(verify, [...secrets, ...Object.values(inputs)])) return undefined
  return store.createCandidate({
    match: trajectory.match,
    fallback: 'd1',
    risk: trajectory.risk ?? 'reversible',
    verify,
    steps,
  }, trajectory.evolveFrom === undefined ? undefined : { evolveFrom: trajectory.evolveFrom })
}

function containsVerbatim(value: unknown, secrets: string[]): boolean {
  if (secrets.length === 0) return false
  const text = JSON.stringify(value)
  return secrets.some(secret => secret !== '' && text.includes(secret))
}

/**
 * @deprecated Evidence can no longer be asserted by a caller: mint it through
 * `SkillStore.beginVerification` / `finishVerification` (CR-02). This helper
 * only classifies an already-observed rerun outcome for tests and logs.
 */
export function evidenceFromRun(
  status: string,
  reason: string,
  modelForwardCalls: number,
  independent: boolean,
  actionsExecuted: number,
): Omit<VerificationEvidence, 'id'> {
  return {
    status: status === 'success' && modelForwardCalls === 0 && independent && actionsExecuted > 0 ? 'passed' : 'failed',
    independent: true,
    at: new Date().toISOString(),
    summary: /^[a-z][a-z0-9_.:-]{0,99}$/u.test(reason) ? reason : 'verification_summary_invalid',
  }
}
