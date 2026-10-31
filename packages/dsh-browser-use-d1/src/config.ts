import Schema from '@deepseek-ai/schemastery'
import type { Locale } from '@albaincompleta/dsh-cu-core/locale'


export interface Config {
  mode: 'launch' | 'attach'
  cdpEndpoint?: string
  executablePath?: string
  /** Page to control in attach mode. At most one selector may be set. */
  tabUrl?: string
  tabTitle?: string
  locale?: Locale
  indicatorHelperPath?: string
  headless?: boolean
  decisionEndpoint: string
  decisionToken: string
  /** Prefix for extraction, observation, run-control, and Skill-publication tools. */
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
  /** Directory for files a controlled page downloads. Defaults to a private temp directory. */
  downloadDir?: string
  skillStorePath?: string
  captureSkills?: boolean
  auditDir?: string
  auditRetentionDays?: number
  controlToken?: string
  controlPort?: number
}

export type ResolvedConfig = Config & Required<Pick<Config,
  'headless' | 'locale' | 'decisionTimeoutMs' | 'textStrategy' | 'maxSteps' | 'maxWallClockMs' | 'maxInputTokens' | 'maxOutputTokens' | 'operationTimeoutMs' | 'verificationTimeoutMs' | 'asyncTimeoutMs' | 'captureSkills' | 'toolPrefix' | 'auditRetentionDays'
>>

export const Config: Schema<Config, ResolvedConfig> = Schema.object({
  mode: Schema.union(['launch', 'attach']).default('launch'),
  cdpEndpoint: Schema.string(),
  executablePath: Schema.string().pattern(/\S/u),
  tabUrl: Schema.string().pattern(/\S/u),
  tabTitle: Schema.string().pattern(/\S/u),
  locale: Schema.union(['zh', 'en']).default('zh'),
  indicatorHelperPath: Schema.string().pattern(/\S/u),
  headless: Schema.boolean().default(false),
  decisionEndpoint: Schema.string().default('http://127.0.0.1:8765'),
  decisionToken: Schema.string().role('secret').pattern(/\S/u).required(),
  toolPrefix: Schema.string().pattern(/^[a-z][a-z0-9_]{0,31}$/u).default('browser'),
  decisionTimeoutMs: Schema.number().step(1).min(1).max(120000).default(10000),
  textStrategy: Schema.union(['speculative', 'on-demand']).default('speculative'),
  maxSteps: Schema.number().step(1).min(1).max(50).default(12),
  maxWallClockMs: Schema.number().step(1).min(1).max(3600000).default(120000),
  maxInputTokens: Schema.number().step(1).min(1).max(10000000).default(100000),
  maxOutputTokens: Schema.number().step(1).min(1).max(10000000).default(10000),
  operationTimeoutMs: Schema.number().step(1).min(1).max(120000).default(5000),
  verificationTimeoutMs: Schema.number().step(0).min(0).max(10000).default(500),
  asyncTimeoutMs: Schema.number().step(1).min(1).max(60000).default(5000),
  downloadDir: Schema.string().pattern(/\S/u),
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
  if (config.mode === 'attach' && config.cdpEndpoint === undefined) {
    throw new Error('D1 Browser Use attach mode requires cdpEndpoint')
  }
  if (config.mode === 'launch' && config.cdpEndpoint !== undefined) {
    throw new Error('D1 Browser Use cdpEndpoint requires attach mode')
  }
  if (config.mode === 'attach' && config.executablePath !== undefined) {
    throw new Error('D1 Browser Use executablePath requires launch mode')
  }
  if (config.mode === 'launch' && (config.tabUrl !== undefined || config.tabTitle !== undefined)) {
    throw new Error('D1 Browser Use tabUrl and tabTitle require attach mode')
  }
  if (config.tabUrl !== undefined && config.tabTitle !== undefined) {
    throw new Error('D1 Browser Use accepts tabUrl or tabTitle, not both')
  }
  if (config.cdpEndpoint !== undefined) {
    let endpoint: URL
    try { endpoint = new URL(config.cdpEndpoint) } catch (error) {
      throw new Error('cdpEndpoint must be an HTTP(S) or WS(S) URL', { cause: error })
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol)) {
      throw new Error('cdpEndpoint must be an HTTP(S) or WS(S) URL')
    }
  }
}
