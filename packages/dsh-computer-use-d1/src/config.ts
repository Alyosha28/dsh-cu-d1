import Schema from '@deepseek-ai/schemastery'
import type { Locale } from '@dsh-cu/core/locale'


export interface Config {
  helperPath?: string
  indicatorHelperPath?: string
  locale?: Locale
  /** Show the macOS privacy prompt once when a run needs a missing permission. */
  promptPermissions?: boolean
  allowedApps?: Array<{ id: string; name: string; executablePath: string }>
  decisionEndpoint: string
  decisionToken: string
  /** Prefix for run-control and Skill-publication tools. */
  toolPrefix?: string
  decisionTimeoutMs?: number
  textStrategy?: 'speculative' | 'on-demand'
  maxSteps?: number
  maxWallClockMs?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  operationTimeoutMs?: number
  verificationTimeoutMs?: number
  asyncTimeoutMs?: number
  skillStorePath?: string
  captureSkills?: boolean
  auditDir?: string
  auditRetentionDays?: number
  controlToken?: string
  controlPort?: number
}

export type ResolvedConfig = Config & Required<Pick<Config,
  'allowedApps' | 'locale' | 'promptPermissions' | 'decisionTimeoutMs' | 'textStrategy' | 'maxSteps' | 'maxWallClockMs' | 'maxInputTokens' | 'maxOutputTokens' | 'operationTimeoutMs' | 'verificationTimeoutMs' | 'asyncTimeoutMs' | 'captureSkills' | 'toolPrefix' | 'auditRetentionDays'
>>

export const Config: Schema<Config, ResolvedConfig> = Schema.object({
  helperPath: Schema.string(),
  indicatorHelperPath: Schema.string(),
  locale: Schema.union(['zh', 'en']).default('zh'),
  promptPermissions: Schema.boolean().default(true),
  allowedApps: Schema.array(Schema.object({
    id: Schema.string().pattern(/^[a-f0-9]{64}$/u).required(),
    name: Schema.string().required(),
    executablePath: Schema.string().min(1),
  })).default([]),
  decisionEndpoint: Schema.string().default('http://127.0.0.1:8765'),
  decisionToken: Schema.string().role('secret').pattern(/\S/u).required(),
  toolPrefix: Schema.string().pattern(/^[a-z][a-z0-9_]{0,31}$/u).default('computer'),
  decisionTimeoutMs: Schema.number().step(1).min(1).max(120000).default(10000),
  textStrategy: Schema.union(['speculative', 'on-demand']).default('speculative'),
  maxSteps: Schema.number().step(1).min(1).max(50).default(12),
  maxWallClockMs: Schema.number().step(1).min(1).max(3600000).default(120000),
  maxInputTokens: Schema.number().step(1).min(1).max(10000000).default(100000),
  maxOutputTokens: Schema.number().step(1).min(1).max(10000000).default(10000),
  operationTimeoutMs: Schema.number().step(1).min(1).max(120000).default(5000),
  verificationTimeoutMs: Schema.number().step(1).min(0).max(10000).default(500),
  asyncTimeoutMs: Schema.number().step(1).min(1).max(60000).default(5000),
  skillStorePath: Schema.string(),
  captureSkills: Schema.boolean().default(false),
  auditDir: Schema.string(),
  auditRetentionDays: Schema.number().min(0.001).max(3650).default(30),
  controlToken: Schema.string().role('secret').pattern(/\S/u),
  controlPort: Schema.number().step(1).min(0).max(65535),
})

export function validateConfig(config: ResolvedConfig): void {
  if (config.captureSkills && config.skillStorePath === undefined) {
    throw new Error('captureSkills requires skillStorePath')
  }
}
