import type { ActivityPhase } from './activity.ts'

export type Locale = 'zh' | 'en'

export interface PanelLabels {
  browserTitle: string
  nativeTitle: string
  controllingBrowser: string
  controllingNative: string
  preparing: string
  observing: string
  deciding: string
  awaitingApproval: string
  paused: string
  stopped: string
  takeover: string
  completed: string
  blocked: string
  failed: string
  pause: string
  resume: string
  stop: string
  takeoverAction: string
  dismiss: string
  tabMark: string
  routeSkill: string
  routeD1: string
  step: string
  elapsed: string
  budget: string
  close: string
}

export interface ControlLabels {
  title: string
  subtitle: string
  statusTitle: string
  controlsTitle: string
  active: string
  last: string
  none: string
  status: string
  route: string
  reason: string
  step: string
  elapsed: string
  permissionsTitle: string
  permissionsBody: string
  accessibility: string
  screenRecording: string
  granted: string
  notGranted: string
  unknown: string
  requestPermission: string
  openSettings: string
  retry: string
  skillsTitle: string
  skillsEmpty: string
  skillScope: string
  skillRisk: string
  skillSteps: string
  skillVerified: string
  deleteSkill: string
  auditTitle: string
  auditEmpty: string
  refresh: string
  pause: string
  resume: string
  stop: string
  takeover: string
  token: string
  tokenHint: string
  connected: string
  unauthorized: string
  loadFailed: string
  dismiss: string
}

export interface ApprovalLabels {
  consequentialQuestion: string
  consequentialDetail: string
  loginQuestion: string
  loginDetail: string
  allowOnce: string
  allowLogin: string
  deny: string
  uploadQuestion: string
  uploadDetail: string
  upload: string
  windowQuestion: string
  windowDetail: string
  publishQuestion: string
  publishDetail: string
  publish: string
  rejectPublish: string
}

export interface UiStrings {
  panel: PanelLabels
  phases: Record<ActivityPhase, string>
  operations: Record<string, string>
  control: ControlLabels
  approvals: ApprovalLabels
}

export type PanelStrings = Pick<UiStrings, 'panel' | 'phases' | 'operations'>

const zhPanel: PanelLabels = {
  browserTitle: 'DSH-CU 浏览器控制',
  nativeTitle: 'DSH-CU 原生控制',
  controllingBrowser: 'DSH-CU 正在控制此标签页',
  controllingNative: 'DSH-CU 正在控制',
  preparing: '准备执行',
  observing: '正在读取界面',
  deciding: '正在决策下一步',
  awaitingApproval: '等待你的批准',
  paused: '已暂停，等待继续',
  stopped: '已停止',
  takeover: '已由你接管',
  completed: '任务完成',
  blocked: '任务被阻止',
  failed: '任务失败',
  pause: '暂停',
  resume: '继续',
  stop: '停止',
  takeoverAction: '接管',
  dismiss: '关闭',
  tabMark: 'DSH-CU 控制中',
  routeSkill: '已验证技能',
  routeD1: '本地决策',
  step: '步骤',
  elapsed: '用时',
  budget: '剩余预算',
  close: '关闭',
}

const enPanel: PanelLabels = {
  browserTitle: 'DSH-CU Browser Control',
  nativeTitle: 'DSH-CU Computer Control',
  controllingBrowser: 'DSH-CU is controlling this tab',
  controllingNative: 'DSH-CU is controlling',
  preparing: 'Preparing',
  observing: 'Reading the interface',
  deciding: 'Deciding the next action',
  awaitingApproval: 'Waiting for your approval',
  paused: 'Paused. Resume when ready.',
  stopped: 'Stopped',
  takeover: 'Taken over by you',
  completed: 'Task complete',
  blocked: 'Task blocked',
  failed: 'Task failed',
  pause: 'Pause',
  resume: 'Resume',
  stop: 'Stop',
  takeoverAction: 'Take over',
  dismiss: 'Dismiss',
  tabMark: 'DSH-CU controlling',
  routeSkill: 'Verified Skill',
  routeD1: 'Local decision',
  step: 'Step',
  elapsed: 'Elapsed',
  budget: 'Budget left',
  close: 'Close',
}

const zhPhases: Record<ActivityPhase, string> = {
  running: '准备执行',
  observing: '正在读取界面',
  deciding: '正在决策下一步',
  awaiting_approval: '等待你的批准',
  skill: '正在回放已验证技能',
  acting: '正在执行动作',
  waiting: '正在等待界面更新',
  verifying: '正在独立验证结果',
  paused: '已暂停',
  stopped: '已停止',
  takeover: '已由你接管',
  blocked: '任务被阻止',
  completed: '任务完成',
  failed: '任务失败',
}

const enPhases: Record<ActivityPhase, string> = {
  running: 'Preparing',
  observing: 'Reading the interface',
  deciding: 'Deciding the next action',
  awaiting_approval: 'Waiting for your approval',
  skill: 'Replaying a verified Skill',
  acting: 'Performing the action',
  waiting: 'Waiting for the interface',
  verifying: 'Verifying independently',
  paused: 'Paused',
  stopped: 'Stopped',
  takeover: 'Taken over by you',
  blocked: 'Task blocked',
  completed: 'Task complete',
  failed: 'Task failed',
}

const zhOperations: Record<string, string> = {
  CLICK: '点击', TYPE_TEXT: '输入', PASTE_TEXT: '粘贴', INCREMENT: '增加',
  DECREMENT: '减少', SCROLL_UP: '向上滚动', SCROLL_DOWN: '向下滚动', WAIT: '等待',
}

const enOperations: Record<string, string> = {
  CLICK: 'clicking', TYPE_TEXT: 'typing', PASTE_TEXT: 'pasting', INCREMENT: 'incrementing',
  DECREMENT: 'decrementing', SCROLL_UP: 'scrolling up', SCROLL_DOWN: 'scrolling down', WAIT: 'waiting',
}

const zhControl: ControlLabels = {
  title: 'DSH-CU 运行控制',
  subtitle: '状态、审批、权限、技能和审计集中在这里。',
  statusTitle: '运行状态',
  controlsTitle: '控制',
  active: '当前运行',
  last: '上次运行',
  none: '暂无运行',
  status: '状态',
  route: '路径',
  reason: '原因',
  step: '步骤',
  elapsed: '用时',
  permissionsTitle: '系统权限',
  permissionsBody: '原生操作需要辅助功能权限，截图回退还需要屏幕录制权限。',
  accessibility: '辅助功能',
  screenRecording: '屏幕录制',
  granted: '已授权',
  notGranted: '未授权',
  unknown: '未知',
  requestPermission: '请求权限',
  openSettings: '打开系统设置',
  retry: '重试',
  skillsTitle: '已验证技能',
  skillsEmpty: '还没有可用的技能。',
  skillScope: '适用范围',
  skillRisk: '风险等级',
  skillSteps: '步骤',
  skillVerified: '验证时间',
  deleteSkill: '删除',
  auditTitle: '审计时间线',
  auditEmpty: '还没有审计事件。',
  refresh: '刷新',
  pause: '暂停',
  resume: '继续',
  stop: '停止',
  takeover: '接管',
  token: '控制令牌',
  tokenHint: '令牌只保存在本标签页的会话存储中。',
  connected: '已连接',
  unauthorized: '令牌无效或缺失',
  loadFailed: '读取失败',
  dismiss: '关闭',
}

const enControl: ControlLabels = {
  title: 'DSH-CU Run Control',
  subtitle: 'Status, approvals, permissions, Skills, and audit in one place.',
  statusTitle: 'Run status',
  controlsTitle: 'Controls',
  active: 'Active run',
  last: 'Last run',
  none: 'No run yet',
  status: 'Status',
  route: 'Route',
  reason: 'Reason',
  step: 'Step',
  elapsed: 'Elapsed',
  permissionsTitle: 'System permissions',
  permissionsBody: 'Computer Use needs Accessibility. Screenshot fallback also needs Screen Recording.',
  accessibility: 'Accessibility',
  screenRecording: 'Screen Recording',
  granted: 'Allowed',
  notGranted: 'Not allowed',
  unknown: 'Unknown',
  requestPermission: 'Request permission',
  openSettings: 'Open System Settings',
  retry: 'Retry',
  skillsTitle: 'Verified Skills',
  skillsEmpty: 'No Skills available yet.',
  skillScope: 'Scope',
  skillRisk: 'Risk',
  skillSteps: 'Steps',
  skillVerified: 'Verified',
  deleteSkill: 'Delete',
  auditTitle: 'Audit timeline',
  auditEmpty: 'No audit events yet.',
  refresh: 'Refresh',
  pause: 'Pause',
  resume: 'Resume',
  stop: 'Stop',
  takeover: 'Take over',
  token: 'Control token',
  tokenHint: 'The token stays in this tab’s session storage.',
  connected: 'Connected',
  unauthorized: 'Missing or invalid token',
  loadFailed: 'Could not load',
  dismiss: 'Dismiss',
}

const zhApprovals: ApprovalLabels = {
  consequentialQuestion: '允许这次会产生外部影响的操作吗？',
  consequentialDetail: '动作：{operation}\n目标：{target}\n范围：{scope}\n这次批准只覆盖当前动作。',
  loginQuestion: '允许在这里登录或提交凭据吗？',
  loginDetail: '动作：{operation}\n目标：{target}\n范围：{scope}\n这次批准只覆盖当前动作。',
  allowOnce: '允许这一次',
  uploadQuestion: '允许把本地文件上传到这个页面吗？',
  uploadDetail: '{files} → {target} · {scope}',
  upload: '允许上传',
  allowLogin: '允许登录',
  deny: '拒绝',
  windowQuestion: '要控制哪一个窗口？',
  windowDetail: '这个应用有多个窗口。选择一个窗口后，本次运行只操作该窗口。',
  publishQuestion: '把 {skillId} 发布为可复用技能吗？',
  publishDetail: '{summary}\n发布后该版本不可修改。',
  publish: '发布技能',
  rejectPublish: '暂不发布',
}

const enApprovals: ApprovalLabels = {
  consequentialQuestion: 'Allow this consequential action?',
  consequentialDetail: 'Action: {operation}\nTarget: {target}\nScope: {scope}\nThis approval covers only this action.',
  loginQuestion: 'Allow signing in or submitting credentials here?',
  loginDetail: 'Action: {operation}\nTarget: {target}\nScope: {scope}\nThis approval covers only this action.',
  allowOnce: 'Allow once',
  uploadQuestion: 'Allow uploading local files to this page?',
  uploadDetail: '{files} → {target} · {scope}',
  upload: 'Allow upload',
  allowLogin: 'Allow sign-in',
  deny: 'Deny',
  windowQuestion: 'Which window should be controlled?',
  windowDetail: 'This application has multiple windows. The run will use only the selected window.',
  publishQuestion: 'Publish {skillId} as a reusable Skill?',
  publishDetail: '{summary}\nThis version is immutable after publication.',
  publish: 'Publish Skill',
  rejectPublish: 'Do not publish',
}

export const LOCALES: readonly Locale[] = ['zh', 'en']

export function resolveLocale(value: string | undefined): Locale {
  return value === 'en' ? 'en' : 'zh'
}

export function uiStrings(locale: Locale): UiStrings {
  return locale === 'en'
    ? { panel: enPanel, phases: enPhases, operations: enOperations, control: enControl, approvals: enApprovals }
    : { panel: zhPanel, phases: zhPhases, operations: zhOperations, control: zhControl, approvals: zhApprovals }
}

export function formatTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([a-z][a-z0-9_]*)\}/giu, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match)
}
