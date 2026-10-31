import { z } from 'zod'
import { verificationSchema } from './contract.ts'
import type { Verification } from './contract.ts'
import type { Decision, Observation } from './types.ts'
import type { SkillStore } from './skill-store.ts'


export const skillStepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), target: z.string().min(1) }).strict(),
  z.object({ type: z.literal('type'), target: z.string().min(1), input: z.string().min(1) }).strict(),
  z.object({ type: z.literal('paste'), target: z.string().min(1), input: z.string().min(1) }).strict(),
  z.object({ type: z.literal('increment'), target: z.string().min(1) }).strict(),
  z.object({ type: z.literal('decrement'), target: z.string().min(1) }).strict(),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(60000) }).strict(),
])
export type SkillStep = z.infer<typeof skillStepSchema>

const originSchema = z.string().refine(value => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value && !url.username && !url.password
  } catch {
    return false
  }
}, 'match.origin must be a canonical HTTP(S) origin')

export const verifiedSkillSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  verifiedAt: z.string().min(1),
  /** Identifies the published Skill this candidate repairs, when produced by evolution. */
  evolvedFrom: z.string().min(1).optional(),
  match: z.object({
    urlPath: z.string().optional(),
    origin: originSchema.optional(),
    windowTitle: z.string().optional(),
    appBundleId: z.string().min(1).optional(),
  }).strict().superRefine((match, context) => {
    const locations = [match.urlPath !== undefined, match.windowTitle !== undefined, match.appBundleId !== undefined]
    if (locations.filter(Boolean).length !== 1) {
      context.addIssue({ code: 'custom', message: 'match_required: specify exactly one of urlPath, windowTitle or appBundleId' })
    }
    if (match.urlPath === undefined && match.origin !== undefined) {
      context.addIssue({ code: 'custom', message: 'origin_requires_urlPath' })
    }
  }),
  fallback: z.enum(['d1', 'human']),
  risk: z.enum(['read_only', 'reversible', 'consequential']),
  /** Optional only so legacy records can load; publication and replay require it. */
  verify: z.array(verificationSchema).max(12).optional(),
  steps: z.array(skillStepSchema).min(1),
}).strict()
export type VerifiedSkill = z.infer<typeof verifiedSkillSchema>

export class SkillError extends Error {
  constructor(readonly code: string, message: string, readonly allowD1Fallback = false) {
    super(message)
    this.name = 'SkillError'
  }
}

export const fixtureSkills: VerifiedSkill[] = [
  {
    id: 'fixture.filters', version: 1, verifiedAt: '2026-10-28',
    match: { urlPath: '/filters.html' }, fallback: 'd1', risk: 'reversible',
    verify: [{ type: 'text_visible', text: '3 adults · Nonstop only' }],
    steps: [
      { type: 'increment', target: 'Adults' },
      { type: 'click', target: 'Nonstop only' },
      { type: 'click', target: 'Apply filters' },
    ],
  },
  {
    id: 'fixture.flights', version: 1, verifiedAt: '2026-10-28',
    match: { urlPath: '/flights.html' }, fallback: 'd1', risk: 'reversible',
    verify: [{ type: 'text_visible', text: '{{inputs:From}} to {{inputs:To}} · {{inputs:Departure%20date}}' }],
    steps: [
      { type: 'type', target: 'From', input: 'From' },
      { type: 'type', target: 'To', input: 'To' },
      { type: 'type', target: 'Departure date', input: 'Departure date' },
      { type: 'click', target: 'Search flights' },
    ],
  },
  {
    id: 'fixture.delayed-results', version: 1, verifiedAt: '2026-10-28',
    match: { urlPath: '/delayed-results.html' }, fallback: 'd1', risk: 'reversible',
    verify: [{ type: 'text_visible', text: 'Delayed results are ready' }],
    steps: [{ type: 'click', target: 'Load results' }],
  },
  {
    id: 'fixture.native-csv-import', version: 1, verifiedAt: '2026-10-28',
    match: { windowTitle: 'DSH Workflow Fixture' }, fallback: 'd1', risk: 'reversible',
    verify: [
      { type: 'text_visible', text: 'Import complete' },
      { type: 'text_visible', text: 'Rows: 2 · Total: 300' },
    ],
    steps: [
      { type: 'type', target: 'Report path', input: 'Report path' },
      { type: 'click', target: 'Import report' },
    ],
  },
]

export function isWellFormedJson(value: unknown): boolean {
  const validString = (text: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)
  if (typeof value === 'string') return validString(value)
  if (Array.isArray(value)) return value.every(isWellFormedJson)
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).every(([key, item]) => validString(key) && isWellFormedJson(item))
  }
  return true
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === 'string') return map(value)
  if (Array.isArray(value)) return value.map(item => mapStrings(item, map))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [map(key), mapStrings(item, map)]))
  }
  return value
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function placeholder(key: string): string {
  return `{{inputs:${encodeURIComponent(key)}}}`
}

/** Replaces captured input values with placeholders before anything is persisted. */
export function sanitizeSkillVerifications(
  rawVerify: unknown,
  inputs: Record<string, string> = {},
): Verification[] | null {
  const assertions = z.array(verificationSchema).min(1).max(12).parse(rawVerify)
  if (!isWellFormedJson(assertions) || !isWellFormedJson(inputs)) return null
  const strings: string[] = []
  mapStrings(assertions, text => {
    strings.push(text)
    return text
  })
  if (strings.some(text => text.includes('{{inputs:'))) return null
  const replacements = new Map<string, string>()
  for (const [key, value] of Object.entries(inputs)) {
    if (value === '') continue
    const encoded = encodeURIComponent(value)
    if (encoded !== value && strings.some(text => text.includes(encoded))) return null
    if (!strings.some(text => text.includes(value))) continue
    const existing = replacements.get(value)
    if (existing !== undefined && existing !== key) return null
    replacements.set(value, key)
  }
  if (replacements.size === 0) return assertions
  const values = [...replacements.keys()].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(values.map(escapeRegExp).join('|'), 'gu')
  const sanitized = mapStrings(assertions, text => text.replace(pattern, value => placeholder(replacements.get(value)!)))
  return z.array(verificationSchema).min(1).max(12).parse(sanitized)
}

function structuredInput(inputs: Record<string, string> | undefined, key: string): string | undefined {
  if (inputs === undefined || !Object.hasOwn(inputs, key)) return undefined
  return inputs[key]
}

/** Hydrates a Skill's own assertions and also retains the caller's postconditions. */
export function verificationForSkill(
  skill: VerifiedSkill,
  inputs: Record<string, string> | undefined,
  callerVerify: Verification[],
): Verification[] {
  if (skill.verify === undefined || skill.verify.length === 0) {
    throw new SkillError('skill_verification_required', `Skill has no persisted postconditions: ${skill.id}`)
  }
  const hydrated = mapStrings(skill.verify, text => text.replace(/\{\{inputs:([^{}]+)\}\}/gu, (_match, encoded: string) => {
    let key: string
    try {
      key = decodeURIComponent(encoded)
    } catch {
      throw new SkillError('skill_verification_invalid', `Invalid input placeholder in Skill: ${skill.id}`)
    }
    const value = structuredInput(inputs, key)
    if (value === undefined) {
      throw new SkillError('missing_skill_input', `Missing structured input: ${key}`, true)
    }
    return value
  }))
  return [
    ...z.array(verificationSchema).min(1).max(12).parse(hydrated),
    ...callerVerify,
  ]
}

export function decisionForSkillStep(
  step: SkillStep,
  observation: Observation,
  inputs: Record<string, string> | undefined,
): Decision {
  if (step.type === 'wait') throw new SkillError('unsupported_skill_step', 'wait has no element target')
  const target = observation.elements.find(element => element.name === step.target || element.identifier === step.target)
  if (target === undefined) throw new SkillError('skill_target_missing', `Skill target is unavailable: ${step.target}`, true)
  if (step.type === 'click') return { operation: 'CLICK', target: target.id }
  if (step.type === 'increment') return { operation: 'INCREMENT', target: target.id }
  if (step.type === 'decrement') return { operation: 'DECREMENT', target: target.id }
  if (step.type === 'type' || step.type === 'paste') {
    const text = structuredInput(inputs, step.input)
    if (text === undefined) throw new SkillError('missing_skill_input', `Missing structured input: ${step.input}`, true)
    return { operation: step.type === 'paste' ? 'PASTE_TEXT' : 'TYPE_TEXT', target: target.id, text }
  }
  throw new SkillError('unsupported_skill_step', 'Unsupported skill step')
}

function isFixture(skill: VerifiedSkill): boolean {
  return fixtureSkills.includes(skill)
}

function isLoopback(url: URL): boolean {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
}

function matchesUrl(skill: VerifiedSkill, url: URL): boolean {
  if (skill.match.urlPath === undefined || url.pathname !== skill.match.urlPath) return false
  if (skill.match.origin !== undefined) return url.origin === skill.match.origin
  // Built-in fixtures are path-only for random loopback test ports. Custom
  // legacy records without an origin never match implicitly.
  return isFixture(skill) && isLoopback(url)
}

export function assertSkillOrigin(skill: VerifiedSkill, argsUrl: string | undefined): void {
  if (skill.match.urlPath === undefined) return
  if (argsUrl === undefined) {
    throw new SkillError('skill_location_required', `URL Skill requires a current page URL: ${skill.id}`)
  }
  const url = new URL(argsUrl)
  if (skill.match.origin !== undefined) {
    if (url.origin === skill.match.origin) return
  } else if (isFixture(skill) && isLoopback(url)) {
    return
  } else if (!isFixture(skill)) {
    throw new SkillError('skill_origin_required', `Legacy URL Skill has no origin and cannot be replayed: ${skill.id}`)
  }
  throw new SkillError('skill_origin_mismatch', `Skill origin does not match the current page: ${skill.id}`)
}

export function assertSkillScope(
  skill: VerifiedSkill,
  scope: { windowTitle?: string; appBundleId?: string },
): void {
  if (skill.match.windowTitle !== undefined && skill.match.windowTitle !== scope.windowTitle) {
    throw new SkillError('skill_window_mismatch', `Skill window does not match the selected window: ${skill.id}`)
  }
  if (skill.match.appBundleId !== undefined) {
    if (scope.appBundleId === undefined) {
      throw new SkillError('skill_application_required', `Application identity is required for Skill: ${skill.id}`)
    }
    if (skill.match.appBundleId !== scope.appBundleId) {
      throw new SkillError('skill_application_mismatch', `Skill application does not match the selected application: ${skill.id}`)
    }
  }
}

function assertReplayable(skill: VerifiedSkill, args: { url?: string }): void {
  if (skill.verify === undefined || skill.verify.length === 0) {
    throw new SkillError('skill_verification_required', `Skill has no persisted postconditions: ${skill.id}`)
  }
  if (skill.match.urlPath === undefined) return
  if (args.url === undefined) {
    throw new SkillError('skill_location_required', `URL Skill requires a current page URL: ${skill.id}`)
  }
  const url = new URL(args.url)
  if (matchesUrl(skill, url)) return
  if (!isFixture(skill) && skill.match.origin === undefined) {
    throw new SkillError('skill_origin_required', `Legacy URL Skill has no origin and cannot be replayed: ${skill.id}`)
  }
  throw new SkillError('skill_origin_mismatch', `Skill origin does not match the current page: ${skill.id}`)
}

export async function selectSkill(args: { skillId?: string; url?: string; app?: string }, store?: SkillStore): Promise<VerifiedSkill | null> {
  const customSkills = store === undefined ? [] : await store.list('verified')
  const skills = [...customSkills, ...fixtureSkills]
  if (args.skillId !== undefined) {
    const skill = skills.find(skill => skill.id === args.skillId)
    if (skill === undefined) throw new SkillError('unknown_skill', `Unknown verified skill: ${args.skillId}`)
    assertReplayable(skill, args)
    return skill
  }
  if (args.url === undefined) return null
  const url = new URL(args.url)
  const replayable = (skill: VerifiedSkill) => skill.verify !== undefined && skill.verify.length > 0 && matchesUrl(skill, url)
  const customCandidates = customSkills.filter(replayable)
  if (customCandidates.length === 1) return customCandidates[0]
  return null
}
