# DSH-CU 核心对抗审计 — 策略 / 审批 / Skill 生命周期 / 控制面 / 审计

- 目标：`/Users/albaincompleta/DSH_CU`，审计对象 `packages/dsh-cu-core/src/` + 两个 provider 的 `skill-runner.ts` / `index.ts` / `controller.ts`
- 契约基准：`SKILL.md`（硬规则 1–10）、`ARCHITECTURE_PLAN.md` §6.3 / §7.1 / §7.2 / §8
- 阶段：红队只读；未修改 `packages/**`、`src/**`、`scripts/**`、`package.json`、lockfile；无 commit / push / install / kill
- PoC 位置：`redteam/poc/core/`（vitest，直接 import `packages/**/src/*.ts`，无构建步骤）
- 复现命令（仓库根目录）：

```bash
./node_modules/.bin/vitest run --config redteam/poc/core/vitest.config.ts
```

实际输出（2026-11-01）：

```
 ✓ redteam/poc/core/cr01-skill-replay-no-approval.spec.ts (4 tests)
 ✓ redteam/poc/core/cr02-evidence-chain.spec.ts (5 tests)
 ✓ redteam/poc/core/cr03-skill-scope-cross-provider.spec.ts (4 tests)
 ✓ redteam/poc/core/cr04-policy-self-authorization.spec.ts (5 tests)
 ✓ redteam/poc/core/cr05-audit-redaction.spec.ts (6 tests)
 ✓ redteam/poc/core/cr06-run-controller.spec.ts (5 tests)
 ✓ redteam/poc/core/cr07-control-server.spec.ts (5 tests)
 ✓ redteam/poc/core/cr08-store-integrity.spec.ts (7 tests)
 ✓ redteam/poc/core/cr09-skill-sanitise-hydrate.spec.ts (6 tests)
 ✓ redteam/poc/core/cr10-boundaries.spec.ts (5 tests)
 ✓ redteam/poc/core/cr11-approval-gateway.spec.ts (6 tests)

 Test Files  11 passed (11)
      Tests  58 passed (58)
```

契约标记约定：**[契约]** = 与 `SKILL.md` / `ARCHITECTURE_PLAN.md` 明示条款矛盾（优先项）；**[设计]** = 与文档一致、仅暴露面过大；**[缺陷]** = 与自身代码/注释/测试声明矛盾。

| ID | 级别 | 标题 | 契约 |
| --- | --- | --- | --- |
| CR-01 | High | Skill 回放全程零审批，且 `skill.risk` 覆盖调用方更严格的策略 | 契约 |
| CR-02 | High | Skill 证据链无生产者、`independent` 是字面量、`approvedBy` 是字符串比较 | 契约 |
| CR-03 | High | 浏览器回放不校验 Skill 的 `windowTitle` / `appBundleId` 作用域 | 契约 |
| CR-04 | High | 模型通过 `policy.{allowConsequential,allowLogin}` 给自己预授权 | 契约 |
| CR-05 | Medium | 审计脱敏可绕过（`access_token`、全角冒号、分隔符） | 缺陷 |
| CR-06 | Medium | 一次审计写失败永久毒化审计链；`resume` 可撤销用户的 `stop` | 缺陷 |
| CR-07 | Medium | 控制面：页面无鉴权、无 Host 校验、特权变更不入审计、错误回显、超限即断连 | 契约/缺陷 |
| CR-08 | Medium | 存储全有或全无：一条坏记录瘫痪整个 Store；跨实例丢写；`reject` 改写已发布 Skill | 契约 |
| CR-09 | Medium | 未进入 captures 的值明文落盘；合并断言集不受 `max(12)` 约束；含 PASTE 的轨迹永不可捕获 | 缺陷 |
| CR-11 | Low | 审批应答不做形状校验：非数组 `selected` 直接放行；取消变成异常 | 缺陷 |
| CR-10 | — | 攻不破的边界（3 条，含证据） | — |

---

## CR-01 · High · Skill 回放全程零审批，且 `skill.risk` 覆盖调用方更严格的策略

**证据**

- `packages/dsh-browser-use-d1/src/skill-runner.ts:17-27` — `runBrowserSkill` 的形参表里**没有** approvals/gateway 参数（`runBrowserSkill.length === 9`）。
- `packages/dsh-browser-use-d1/src/skill-runner.ts:29` — `taskPolicySchema.parse({ ...args.policy, risk: skill.risk })`：右侧 `skill.risk` 后写，覆盖调用方 `args.policy.risk`。
- `packages/dsh-computer-use-d1/src/skill-runner.ts:28,30` — 原生侧完全同构。
- `skill-runner.ts:46-146` 回放主循环只调用 `checkPagePolicy`（仅 `credentialsAvailable === false` 时阻断，`:83`），**从不**调用 `needsConsequentialApproval` / `needsLoginApproval` / `requestConsequentialApproval` / `requestLoginApproval`；对照 D1 路径 `packages/dsh-browser-use-d1/src/controller.ts:226-256` 四个都有。
- 契约：`SKILL.md` 硬规则 5「Consequential actions and login require explicit user approval」；`ARCHITECTURE_PLAN.md:205`「后果性动作与凭据提交在动作选定后按单次动作请求批准」；`README.md:210`「Runtime controls include credential/login gates, consequential-action confirmation… Action approvals name the operation, target, and scope, and cover one action」。

**攻击步骤**

1. 攻击者（或被注入的模型）用 `d1_browser_subgoal` 完成一次"点 Pay now"的轨迹；`risk` 由调用方自己声明为 `reversible`（默认值，见 `policy.ts:8`），本次 D1 运行本就不触发审批。
2. `controller.ts:346-356` 把该轨迹捕获为候选，`risk: args.policy?.risk`（`:355`）写进候选 —— 仍是 `reversible`。
3. 用户批准发布（CR-02 指出这一步的提示只显示 `Steps: 3`，不显示步骤内容）。
4. 之后任何一次 `d1_browser_subgoal` 命中该 Skill（或直接传 `skillId`），`runBrowserSkill` 零审批完成支付/登录；即便 Skill 自己标了 `risk: 'consequential'` 也一样，因为回放路径没有任何消费 `needsConsequentialApproval` 的代码。
5. 反向也成立：调用方声明 `policy:{risk:'read_only'}` 要求只读，`skill-runner.ts:29` 会把它改写成 Skill 自己的 `reversible`/`consequential` —— 更严格的策略被静默放宽。

**影响**

已发布 Skill 成为一次批准、永久免审批的高权限动作通道，正是 `ARCHITECTURE_PLAN.md:206` 明令排除的「无人值守的支付/凭据提交」。同时 `risk` 只由声明者填写，`read_only` 语义在回放路径不存在。

**复现**：`redteam/poc/core/cr01-skill-replay-no-approval.spec.ts`

- 用假 `Page` 直接跑生产 `runBrowserSkill`，`risk:'consequential'` 的 Skill 点击 "Pay now"：`page.clicked === ['Pay now']`，`state.status === 'success'`，全过程无任何审批对象存在。
- `read_only` 被覆盖：`taskPolicySchema.parse({...{risk:'read_only'}, risk:'reversible'}).risk === 'reversible'`，且该 Skill 仍然点下了 "Pay now"。
- 凭据步骤：`type` 进 password 字段 + 点 "Sign in"，无登录审批。
- 源码断言：两个 `skill-runner.ts` 均不含 `needsConsequentialApproval|requestLoginApproval|ApprovalGateway`；D1 循环含。

**修复方向**（不写实现）：回放循环必须在 `dom.execute` 前复用 D1 路径的两个 gate；`risk` 必须取 `max(callerRisk, skillRisk)` 而不是赋值覆盖；`risk: 'read_only'` 的 Skill 应禁止回放任何 `click/type/paste` 步骤。

**回归测试建议**：把本 PoC 的三条断言固化进 `packages/dsh-browser-use-d1/tests/approval.spec.ts`：`risk=consequential` Skill 回放必须产生 1 次审批请求，拒绝时状态为 `confirmation_required` 且 `actionsExecuted === 0`。

---

## CR-02 · High · Skill 证据链无生产者、`independent` 是字面量、`approvedBy` 是字符串比较

**证据**

- `packages/dsh-cu-core/src/skill-builder.ts:139-143` — `evidenceFromRun(status, reason, modelForwardCalls, independent, actionsExecuted)` 的返回体里 `independent: true` 是**硬编码字面量**；第 4 个参数只参与 `status` 计算，不参与 `independent` 字段。
- `packages/dsh-cu-core/src/skill-store.ts:116-127` — `recordVerification` 接受任意调用方写入的 `{status:'passed', independent:true, at, summary}`；无签名、无 runId、无 session 绑定、不校验 `at` 时效。
- `skill-store.ts:129-146` — `publish(id, evidenceId, approvedBy: 'user'|'system')`，`:131` 的唯一检查是 `approvedBy !== 'user'` 字符串比较；`:142` `verifiedAt = latest.at` 取自证据作者填的字符串。
- 生产代码**没有**任何一处调用 `recordVerification`（全仓 grep 仅测试与 e2e）：`packages/dsh-browser-use-d1/src/{index,controller,skill-runner}.ts`、`packages/dsh-computer-use-d1/src/*` 均未调用。
- `packages/dsh-browser-use-d1/src/index.ts:233-244` — 发布审批弹窗的 detail 只有 `Scope / Risk / Steps: N / Verification assertions: N / Latest evidence`，不含任何步骤名或目标名。
- 契约：`ARCHITECTURE_PLAN.md:177-184`（成功轨迹 → 新上下文独立复跑 → 用户批准该候选 → 不可变发布）、`:205`（外部审批，不由模型批准自己）、`SKILL.md` 硬规则 7；`README.md:210`「P3 adds candidate generation, **independent rerun verification**, explicit user approval, **immutable publication**」。

**攻击步骤**

1. 正常路径：`browser_skill_publish` 里 `candidate.history.at(-1)?.id` 为空（`index.ts:646-648`）→ 直接 `verification_required: no independent evidence exists`。**文档描述的发布流程在发布代码里走不通**（没有"独立复跑"的证据生产者）。
2. 一旦有任何进程内调用方写入证据（导出的公开 API），`publish(..., 'user')` 即可发布：`independent` 字段永远为 `true`，`publish` 的独立性检查因此恒真。
3. 证据时间戳可被写成 `1999-01-01`，并通过 `verifiedAt` 成为已发布 Skill 的"验证时间"，在控制面板展示。

**影响**

`§7.1` 的"最新独立验证证据"在实现上是自证：`independent` 不可信、证据无来源、发布时间可伪造。发布是唯一剩余的审批点（因为 CR-01 让回放零审批），而它的输入全部由调用方写入。

**复现**：`redteam/poc/core/cr02-evidence-chain.spec.ts`

- `evidenceFromRun('success','model_says_done',0,false,1).independent === true`。
- 用 `createCandidateFromTrajectory` 造候选 → `recordVerification({status:'passed',independent:true,summary:'trust_me'})` → `publish(id, latestId, 'user')` 成功，落盘 `state: "verified"`。
- `publish(...,'system')` 抛 `approval_required`；`'user'` 通过 —— 差别只是一个字符串。
- `verifiedAt === '1999-01-01T00:00:00.000Z'`。
- `skillDetail` 源码断言：`Steps: ${summary.steps}`（计数），`not.toMatch(/step\.target|\.steps\.map/)`。

**修复方向**：证据必须由 runner 在进程内产出并携带 `{runId, skillId, candidateHash, assertionsHash}`，`independent` 由"新上下文/零模型调用"事实推导而非入参；`publish` 需要 runner 签发的不可伪造令牌而非字符串；弹窗必须列出步骤与目标。

**回归测试建议**：`evidenceFromRun(..., independent=false, ...)` 必须产生 `independent:false` 且 `publish` 拒绝；`recordVerification` 写入 `at` 超出窗口的证据时 `publish` 拒绝。

---

## CR-03 · High · 浏览器回放不校验 Skill 的 `windowTitle` / `appBundleId` 作用域

**证据**

- `packages/dsh-cu-core/src/skills.ts:229-230` — `assertSkillOrigin` 第一行 `if (skill.match.urlPath === undefined) return`：非 URL Skill 直接放行，不做任何位置校验。
- `skills.ts:245-260` — `assertSkillScope` **只**被原生 runner 调用（`packages/dsh-computer-use-d1/src/skill-runner.ts:28`）；浏览器 runner 从不调用（源码断言：`skill-runner.ts` 不含 `assertSkillScope`）。
- `skills.ts:262-276` `assertReplayable` + `:278-292` `selectSkill`：显式传 `skillId` 时也只对 `urlPath` 型做校验。
- `skills.ts:90-101` — 内置 fixture `fixture.native-csv-import` 的 `match` 是 `{ windowTitle: 'DSH Workflow Fixture' }`，它对浏览器 provider 同样可见。
- 契约：`ARCHITECTURE_PLAN.md:186-188`「Skill 必须绑定：明确的 origin、应用或窗口适用范围」；`SKILL.md` 硬规则 4。

**攻击步骤**

1. 用户为某个原生应用批准了一个 `windowTitle`/`appBundleId` Skill（例如"导入报表"，步骤 `type Report path` + `click Import report`）。
2. 同一台机器上，浏览器 provider 用同一个 `skillStorePath`（或直接请求内置 fixture）调 `d1_browser_subgoal({skillId:'fixture.native-csv-import'})`。
3. `assertReplayable` 因 `urlPath === undefined` 立即返回；`assertSkillOrigin` 同；`assertSkillScope` 从未被调用。
4. 步骤按元素名在**任意网页**上匹配并执行：`type` 把调用方给的值写进网页表单，`click` 点上同名按钮。
5. 页面可控性加成：`windowTitle` 由 `document.title` 决定，网页能自行改名。

**影响**

作用域声明形同虚设：一个"只属于 Finder 窗口"的 Skill 会在任意 `https://` 页面上执行写操作。跨 provider 的 Skill 混淆让"用户批准的是 A 场景"变成"B 场景可复用"。

**复现**：`redteam/poc/core/cr03-skill-scope-cross-provider.spec.ts`

- `assertSkillOrigin(nativeSkill, 'https://evil.example/account')` 不抛。
- `appBundleId: 'com.apple.finder'` 的 Skill 在 `https://evil.example/account` 上回放：`page.typed === [{target:'Report path', text:'/etc/passwd'}]`、`page.clicked === ['Import report']`、`status === 'success'`。
- `selectSkill({skillId:'fixture.native-csv-import', url:'https://evil.example/x'})` 返回该 fixture。

**修复方向**：浏览器 runner 必须在首个步骤前拒绝 `urlPath === undefined` 的 Skill（或强制 `assertSkillScope` + 显式 `appBundleId`）；fixture 需要按 provider 分区。

**回归测试建议**：`runBrowserSkill` 收到 `windowTitle`/`appBundleId` Skill 必须抛 `skill_scope_unavailable`，且 `actionsExecuted === 0`。

---

## CR-04 · High · 模型通过 `policy.{allowConsequential,allowLogin}` 给自己预授权

**证据**

- `packages/dsh-cu-core/src/contract.ts:19` — `policy: taskPolicySchema` 是 `subgoalInput` 的字段。
- `packages/dsh-browser-use-d1/src/index.ts:316-319` — 工具 `inputSchema` 直接由 `z.toJSONSchema(subgoalInput)` 生成，`policy` 因此是模型可填的工具参数；`:48` 的 GUIDANCE 明确告诉模型「policy accepts risk=…, allowLogin, allowConsequential, and credentialsAvailable」。
- `packages/dsh-cu-core/src/policy.ts:7,9` — 字段描述原文：`True pre-authorizes credential submission and sign-in clicks for this run.` / `True pre-authorizes consequential actions for this run.`
- `packages/dsh-cu-core/src/policy-approvals.ts:24-31` — 两个 gate 的唯一判据就是这两个布尔值。
- `packages/dsh-cu-core/src/policy.ts:43-56` — 凭据/登录识别只看 `inputType === 'password'` 与"页面存在 password 字段时按钮名含 sign in/login"。
- 契约：`ARCHITECTURE_PLAN.md:205`「高风险操作、登录和 Skill 发布使用外部审批，**不由模型批准自己**」、`:161`「信心不能替代审批」；`README.md:285`「D1 is not a permission or completion authority」。

**攻击步骤**

1. 页面注入文本诱导模型调用 `d1_browser_subgoal`，`policy:{risk:'consequential', allowConsequential:true}`（或直接 `risk:'reversible'`）→ `needsConsequentialApproval` 返回 `false`，支付点击无审批。
2. 登录：`policy:{allowLogin:true}` → `needsLoginApproval` 返回 `false`，密码提交无审批。
3. 无 `allowLogin` 也能过：邮箱优先登录页（无 password 字段）先 `type` 邮箱再点 "Sign in"，`isSignInAction` 要求页面已存在 password 字段，故返回 `false`；下一步页面的密码框仍可 `options.allowLogin` 或 `risk=reversible` 绕过。
4. 支付/OTP 同理：`isCredentialInput` 只认 `inputType === 'password'`，`Card number` / `CVV` / `OTP` 字段一律不算凭据。

**影响**

审批边界的判据由被约束方提供。文档里"外部审批"在实现上是模型自填的一个 JSON 字段；同时信用卡/OTP 输入不属于"凭据"，可无审批写入（与 `§8`「凭证、支付…不属于无人值守能力范围」冲突）。

**复现**：`redteam/poc/core/cr04-policy-self-authorization.spec.ts`

- `z.toJSONSchema(subgoalInput).properties.policy.properties` 含 `risk/allowConsequential/allowLogin/credentialsAvailable`，且 schema 文本含 "pre-authorizes consequential actions"。
- `needsConsequentialApproval({risk:'consequential', allowConsequential:true}) === false`。
- `needsLoginApproval(passwordPage, submit, {allowLogin:true}) === false`。
- 卡号/CVV 页面：`isCredentialInput(...) === false`、`needsLoginApproval(...) === false`；邮箱优先页：`isSignInAction(...) === false`。
- `checkPagePolicy(observation, {risk:'reversible'})`（未声明 `credentialsAvailable`）返回 `null`。

**修复方向**：`risk` 与两个 `allow*` 必须来自工具参数之外（宿主配置 / 用户会话设置 / 每次动作的审批结果），模型参数里只保留"请求更高审批"的方向；凭据识别扩展到 `card/cc-number/cvc/otp/one-time-code/autocomplete="current-password|cc-number|one-time-code"`。

**回归测试建议**：断言工具 schema 的 `policy` 不含 `allowConsequential`/`allowLogin`；断言卡号与 OTP 输入在 `risk=reversible` 下必须产生审批。

---

## CR-05 · Medium · 审计脱敏可绕过

**证据**

- `packages/dsh-cu-core/src/audit.ts:31-37` — `safeString` 只有两条正则：`\b(Bearer\s+)[^\s,;]+` 与 `\b(password|passwd|token|secret|credential|cookie)(\s*[:=]\s*)[^\s,;]+`。
- `audit.ts:25-29` — 白名单键含 `reason`、`action`、`operation`、`status`，均为自由字符串入口。
- `packages/dsh-cu-core/tests/audit.spec.ts:18-37` — 仓库自己的回归测试声称"redacts credential-like values"。

**攻击步骤 / 具体绕过**

| 输入 | 结果 |
| --- | --- |
| `access_token=sk-live-…` | 原样落盘（`_` 不是 `\b`，`token` 前无词边界） |
| `client_secret=…` / `refresh_token:…` | 原样落盘 |
| `token：sk-live-…`（全角冒号） | 原样落盘 |
| `password=abc,retry=1` | `password=[redacted],retry=1`，逗号后内容不受保护 |
| `token=abc def` | `token=[redacted] def`，空格后内容泄漏 |

**影响**

脱敏层是审计文件唯一的敏感信息防线；一旦有任何调用方把自由文本放进白名单键，令牌与口令就会明文进入 `audit.jsonl`（跨进程可读、30 天保留）。当前唯一生产者 `RunController.finish` 用 `^[a-z][a-z0-9_:-]{0,99}$` 把 `reason` 限制成操作码（`run-controller.ts:233`），所以本缺陷属**控制本身失效**而非已可达的数据泄漏 —— 但 `AuditStore.append` 是导出的公开 API，任何第二个调用方都会踩中。

**复现**：`redteam/poc/core/cr05-audit-redaction.spec.ts`（6 条，含对照组 `password=hunter2` → `password=[redacted]`；端到端 `append` 后文件里能 grep 到 secret）

**修复方向**：白名单键值改为闭集枚举（状态/原因码白名单），自由文本一律不落盘；若必须落盘，按"整值丢弃"而非"部分替换"处理，并对 `*_token`、`*_secret`、全角标点、`;`、`,`、空白分隔做归一化。

**回归测试建议**：把上表 5 个绕过样例加入 `audit.spec.ts`，断言持久化文本不含 secret 子串。

---

## CR-06 · Medium · 一次审计写失败永久毒化审计链；`resume` 可撤销用户的 `stop`

**证据**

- `packages/dsh-cu-core/src/run-controller.ts:89-92` — `this.pending = this.pending.then(() => this.audit!.append(event).then(...))`，无 `.catch()`。任一 `append` 拒绝 → `this.pending` 变为永久 rejected → 后续所有 `record()` 静默丢失，`auditEvents()`（`:256-259` `await this.pending`）永久抛错 → `/api/audit` 500。
- `run-controller.ts:228-232` — `finish()` 在 `state.active === undefined` 时直接 `return`，终态事件（`blocked`/`escalated`）可能完全不留痕。
- `run-controller.ts:199-209` 与 `:211-226` — `stop()` 设 `stopped=true`，`resume()` 无条件清 `stopped/takeover/stopReason`。
- `packages/dsh-browser-use-d1/src/index.ts:615`（原生 `:152` 同）— `browser_control` 工具的 action 枚举含 `resume`，即**模型可调用**。
- 契约：`ARCHITECTURE_PLAN.md:208`「审计只保存白名单操作字段，并具有明确保留期限」+ `:210`「支持暂停、继续、停止和人工接管」。

**攻击步骤**

1. 磁盘满 / `EACCES` / 并发写坏的 `audit.jsonl` → 一次 `append` 失败。
2. 之后整场会话的审计静默停止：`auditEvents()` 永久抛错，控制面板"审计时间线"持续报错，而运行本身照常进行 —— **审计失败不阻断执行**（fail-open）。
3. 用户在控制面板点"停止" → `admit()` 返回 `stopped`；被注入的模型调用 `browser_control({action:'resume'})` → `stopped` 被清除，新一轮 `start()` 拿到真实 run，用户的中止被撤销，且 `run_resumed` 事件还写不出来（第 1 步已毒化）。

**影响**

审计可被一次瞬时 IO 故障永久关闭（且无告警）；用户的中止不是终止性状态，模型可自行恢复。

**复现**：`redteam/poc/core/cr06-run-controller.spec.ts`

- 注入一次性失败的 `AuditStore`：`auditEvents()` rejects `EACCES`，`audit.events.length === 0`（后续 3 次 `record` 全丢），并产生未处理 Promise 拒绝。
- `stop()` → `admit() === {status:'stopped'}`；`resume()` → `admit() === null`；`start()` 返回非空 id。
- `takeover` → `resume` 同样被撤销。
- `finish()` 无活动 run 时 `audit.events.length === 0`。

**修复方向**：`record()` 用 `.catch()` 隔离并降级（写失败计数 + 面板告警 + 阻止新 run 启动）；`stop`/`takeover` 应为 terminate-only 状态，只能由用户在宿主侧清除，模型工具不得暴露 `resume` 对 `stopped` 的清除（或 `resume` 需一次审批）。

**回归测试建议**：注入失败 AuditStore 后断言"新 run 被拒绝启动"；断言模型侧 `resume` 无法清除 `stopped`。

---

## CR-07 · Medium · 控制面：页面无鉴权、无 Host 校验、特权变更不入审计、错误回显、超限即断连

**证据**

- `packages/dsh-cu-core/src/control-server.ts:208-212` — `request.url === '/' && GET` 在鉴权（`:217`）之前，任何人可读整页。
- `control-server.ts:217` — `request.headers.authorization !== \`Bearer ${this.token}\`` 用 `!==`（非常量时间）；且**不校验 `Host`**（`:206` 起无任何 host/origin 检查）→ DNS rebinding 可命中。
- `control-server.ts:253-265` — `POST /api/skills/remove` 接受 `{id}` 直接删除（含已发布 Skill），**不写任何审计事件**。
- `control-server.ts:279-281` — `catch` 把 `error.message` 原样 500 回显。
- `control-server.ts:161-185` — 超限调用 `request.destroy()` 后仍试图 `json(500)`。
- `control-server.ts:272-277` — 路由用 `request.url` 全等匹配，`/api/status?x=1` → 404。
- `packages/dsh-browser-use-d1/src/index.ts:94` — `ensureControlUrl` 返回 `${url}#token=${pageToken}`：控制凭据以 URL fragment 形式进入工具结果（模型上下文 / 会话日志 / 浏览器历史）。
- 契约：`ARCHITECTURE_PLAN.md:208`（审计白名单与保留期）+ `control-server.ts:188` 的注释"the configured control token never enters a tool result URL"。

**攻击步骤 / 实测结果**

| 请求 | 结果 |
| --- | --- |
| `GET /`（无 token） | 200 返回整页 |
| `GET /` + `Host: attacker.example` | 200（无 Host 校验，rebinding 面） |
| `GET /api/status`（无 token） | 401，且响应无 `access-control-allow-origin` |
| `GET /api/status` + 正确 token + 伪造 Host | 200 |
| `POST /api/skills/remove` + token，`removeSkill` 抛错 | 500，body 含 `ENOENT … /Users/alice/.dsh-cu/skills.json` |
| `POST /api/skills/remove` + token，body > 8192B | 客户端 `ECONNRESET`（无状态码），服务端存活 |
| `POST /api/skills/remove` 成功 | 200，`controller.auditEvents() === []` |

**影响**

控制面的**变更有两类完全不留审计**：Skill 删除、权限面板打开；页面本身可被任意来源读取（配合未来任何 Cookie/会话式鉴权即成 CSRF/rebinding 跳板）；内部路径与错误串回显给持有 token 的一方；超限请求不给任何状态码。

**复现**：`redteam/poc/core/cr07-control-server.spec.ts`（5 条，全部实测通过）

**修复方向**：`/` 也要鉴权（或返回不含控制入口的静态壳）；校验 `Host` 属于 `127.0.0.1|localhost` 白名单；`timingSafeEqual` 比较 token；控制面每个变更调用 `AuditStore.append`；错误只回显稳定码；超限时返回 413 再 `end()`（不 destroy）；`#token=` 改为 POST 一次性交换或 8 位短码。

**回归测试建议**：断言 `removeSkill` 成功后有 1 条审计；断言 `Host: evil.example` 返回 403；断言超限 body 返回 413。

---

## CR-08 · Medium · 存储全有或全无；跨实例丢写；`reject` 改写已发布 Skill

**证据**

- `packages/dsh-cu-core/src/audit.ts:71-79` — `read()` 对每一行 `JSON.parse` + schema，任一行坏 → 整表抛错；`append`（`:93-105`）因此永久失败。
- `packages/dsh-cu-core/src/skill-store.ts:55-64` — 同理；`skillFileSchema` 是 `version: z.literal(1)` 且 `verifiedSkillSchema` 全部 `.strict()`，且**逐条不隔离**：一条记录的未知字段/未来版本即让整个文件不可读。
- `audit.ts:64-69` / `skill-store.ts:48-53` — 写锁是**模块级** `Map<string, Promise>`，按 `resolve(path)` 键，只在本模块实例内串行；两个进程（或同进程两份模块实例 src/dist）仍会互相 `read → modify → write 全文件` 覆盖。
- `skill-store.ts:148-158` — `reject()` 无状态检查：对已 `verified` 记录直接改写 `state` 并追加 `failed` 证据；而 `:121` 的 `recordVerification` 明确拒绝"Verified skills are immutable"。
- 契约：`ARCHITECTURE_PLAN.md:191`「最新独立验证证据与**不可变版本**」；`README.md:210`「immutable publication」；`skill-store.ts:160` 注释「Published files are never overwritten in place」。

**攻击步骤**

1. 让 `audit.jsonl` 出现一行截断 JSON（外部编辑、另一进程覆盖、磁盘故障遗留）→ 从此**再也不会产生任何审计事件**，且 `/api/audit` 永久 500（与 CR-06 叠加）。
2. 在 `skills.json` 里留下一条带未知字段的记录（例如未来版本写入，或手工导入）→ `list()`/`get()` 全抛 → `selectSkill` 抛 → `browser_subgoal` 整个工具失败（不只是 Skill 路径）。
3. 两个会话/两份模块实例同时 `createCandidate`/`append` → 后写覆盖先写，静默丢一条 Skill 或一条审计。
4. `reject(verifiedId, reason)` 把已发布版本改成 `rejected` —— 已发布版本的不可变性被绕过。

**影响**

单点损坏 = 全功能瘫痪（审计永久失效 + 所有浏览器子目标失败）；跨进程丢写使审计与 Skill 集合不可信；已发布 Skill 可被就地改写。

**复现**：`redteam/poc/core/cr08-store-integrity.spec.ts`（7 条）

- 坏行 → `append`/`list` 均抛 `JSON`，再次 `append` 仍抛。
- 一条 `unknownField` 记录 → `get`/`list` 抛；`{version:2}` → `list` 抛。
- `src` 与 `dist` 两个 `AuditStore` 并发 `append` → 文件只有 **1** 行（另一条被覆盖）。
- 两个 `SkillStore` 实例并发 `createCandidate` → 文件只有 **1** 个 Skill。
- `reject()` 已发布记录后 `state === 'rejected'`；而同对象 `recordVerification` 抛 `immutable`。
- 权限：文件 `0o600`、目录 `0o700`（该控制成立）。

**修复方向**：`read()` 逐条容错（坏行跳过 + 计数 + 告警），迁移旧版本而非硬失败；写入改为追加式 + O_APPEND/单写者（或真实文件锁），审计用 append-only 日志而非整表重写；`reject` 增加 `state !== 'verified'` 守卫，已发布版本只能 `remove`（有审计）或新版本。

**回归测试建议**：坏行/坏记录的容错用例；两进程并发 `append` 后行数守恒；`reject` 对 verified 抛错。

---

## CR-09 · Medium · 未进入 captures 的值明文落盘；合并断言集不受 `max(12)` 约束；含 PASTE 的轨迹永不可捕获

**证据**

- `packages/dsh-cu-core/src/skills.ts:132-159` — `sanitizeSkillVerifications` 只替换 `inputs` 里出现的值；`inputs` 之外的值原样保留。
- `packages/dsh-cu-core/src/skill-builder.ts:104-121` — `captured = capturedInputsForTrajectory(trajectory)`；`trajectory.capturedValues` 为 `undefined` 时返回 `{}`，随后 `sanitizeSkillVerifications(verify, {})` 等于不脱敏，`containsRawInput` 也无值可查 → 原样持久化。
- `packages/dsh-browser-use-d1/src/controller.ts:296` — D1 只对 `TYPE_TEXT` 记录 `capturedValues`；`PASTE_TEXT` 不记录。
- `skill-builder.ts:78-95` — `capturedInputsForTrajectory` 对 TYPE/PASTE 都递增下标，与上一条叠加后任何含 PASTE 的轨迹 `targetName` 对不上 → `return null`（整个候选被丢弃）。
- `skills.ts:188-191` — 返回 `[...z.array(...).max(12).parse(hydrated), ...callerVerify]`：只校验 Skill 自身 12 条，调用方断言在数组外拼接，**合并结果没有再次校验**。
- 契约：`ARCHITECTURE_PLAN.md:207`「输入、截图、Cookie、页面文本和目标描述不得无策略写入审计或 Skill」；`contract.ts:17` `verify max 12`。

**攻击步骤**

1. 任意调用方（`createCandidateFromTrajectory` 是导出 API）在未提供 `capturedValues` 时，`verify` 里出现的口令/OTP 明文写入 `skills.json`（示例：`Signed in as hunter2-0TP`）。
2. 依赖 PASTE 的流程（`SKILL.md` 规则 10 建议的登录态复用路径）永远无法生成候选 —— 功能静默缺失，用户以为"捕获开不了"。
3. 合并断言集可以超过文档承诺的 12 条（12 + 1 = 13 实测通过校验），调用方断言不受 `verificationSchema` 约束。

**影响**

Skill 文件是长期持久化资产，明文口令会永久留存（并在控制面板/审批弹窗中被引用）；同时"粘贴型"流程的捕获能力实际不可用。

可达性说明：随仓库发布的 `controller.ts` 恒传 `capturedValues`（`:352`，`captureInputs.set(state, [])` 于 `:96`），因此“未提供 captures”这一条需经导出的 `createCandidateFromTrajectory` API 触发 —— 记为 API 级缺陷，不宣称现网可直接利用；PASTE 轨迹不可捕获（第 2 条）与合并集超限（第 3 条）则在现网路径上成立。

**复现**：`redteam/poc/core/cr09-skill-sanitise-hydrate.spec.ts`（6 条）

- `sanitizeSkillVerifications([{text:'Signed in as hunter2-0TP'}], {Password:'hunter2-0TP'})` → `{{inputs:Password}}`（对照组成立）。
- 未给 `capturedValues` 时同一轨迹落盘文件 `toContain('hunter2-0TP')` 且**不含**占位符。
- `{{inputs:` 预注入与百分号编码重复 → 返回 `null`（该控制成立）。
- 水合单遍：`inputs:{A:'{{inputs:B}}'}` → 结果文本仍是 `{{inputs:B}}`（不可二次展开，控制成立）。
- `verificationForSkill(skill12, undefined, [caller])` 返回 **13** 条不报错。
- 纯 PASTE 与 TYPE+PASTE 轨迹的 `createCandidateFromTrajectory` 均 `undefined`。

**修复方向**：脱敏必须覆盖"调用方断言 + 轨迹中所有已派发的 `text`"，而不是只覆盖 `capturedValues`（可对 `decision.text` 全量收集，包括 PASTE）；`capturedInputsForTrajectory` 的下标必须与捕获侧使用同一过滤器；合并后再做一次 `max(12)` 校验或明确放开上限。

**回归测试建议**：`capturedValues: undefined` 时含口令的轨迹必须返回 `undefined`；PASTE 轨迹必须能生成候选；`verificationForSkill` 合并后长度 > 12 必须抛错。

---

## CR-11 · Low · 审批应答不做形状校验

**证据**

- `packages/dsh-cu-core/src/approvals.ts:42-44` — `const answer = (result.answers as Array<{id, custom?, selected: string[]}>).find(...)`；`if (answer && !answer.custom?.trim() && answer.selected.includes(request.approve)) return { approved: true }`。只有 `as` 断言，没有运行时形状校验。
- `approvals.ts:33-40` — 选项只有 `{label}`，`approve`/`reject` 标签来自 locale，**未断言二者不相等**。
- `packages/dsh-cu-core/src/policy-approvals.ts:33-48` — `ask()` 抛错直接向上传播，调用方（`controller.ts:235-243`）没有 try/catch。
- 宿主侧真实 schema（`node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.host.js:192`）把 `selected` 定为 `z.array(z.string())`，所以"字符串形态"目前是类型漂移而非现存行为。

**攻击步骤 / 实测**

- `selected: 'Allow once'`（字符串而非数组）→ `approved: true`（`String.prototype.includes` 命中）。任何包含标签的子串 `x Allow once x` 同样放行。
- `approve === reject`（如未来 locale 或自定义标签碰撞）→ 用户点"拒绝"（第二项）也被判为批准。
- `ask()` 因取消/abort 抛错 → `requestConsequentialApproval` rejects → 整轮以工具异常结束，而不是 `confirmation_required`。
- 反例（fail-closed 成立）：无 `userQuestions` 服务、`answers: []`、id 不匹配、`custom` 有任何非空文本 → 一律拒绝。

**影响**

审批判据依赖上游返回值的形状与标签唯一性；宿主返回结构变化或标签碰撞时静默放行。取消路径把"用户拒绝"变成"工具失败"，`RunState` 无法如实报告 `confirmation_required`。

**复现**：`redteam/poc/core/cr11-approval-gateway.spec.ts`（6 条）

**修复方向**：用 zod 校验 `answers`（`selected: string[]`、`custom?: string`）；显式断言 `approve !== reject`；`ask()` 的异常在 `policy-approvals.ts` 内转成 `{approved:false, reason:'approval_cancelled'}`；单次审批用一次性 questionId（当前恒为 `dsh-cu-consequential` / `dsh-cu-login`）。

**回归测试建议**：非数组 `selected`、标签碰撞、`ask` 抛错三条必须 `approved === false` 且 reason 为 `approval_cancelled`。

---

## 攻不破的边界（复核后仍然成立）

1. **origin 规范化固定**（`skills.ts:18-25`，证据 `cr10-boundaries.spec.ts`）
   `url.origin === value` 的规范形校验拒绝了 `https://SHOP.example`、`https://shop.example:443`、`https://user:pw@shop.example`、`https://shop.example/x`、`ftp://...`；`assertSkillOrigin` 拒绝 `https://shop.example.evil.example/x`、`https://shop.example.`（尾点）、`https://shop.example:8443/x`。**URL 型 Skill 的 origin 固定本身没有被绕过** —— CR-03 的问题在"非 URL 型完全没有检查"，不是这里失守。

2. **同名歧义升级**（`policy.ts:58-87`，证据同上）
   两个同名同角色且无上下文区分的按钮 → `{status:'escalated', reason:'ambiguous_target'}`；`contexts` 去重后只有一个值时同样升级；只有"上下文互异 + goal 恰好只包含目标那一处上下文"才放行。页面无法通过复制同名按钮来悄悄换目标。

3. **控制面无 CORS 授权 + header-only bearer**（证据 `cr07-control-server.spec.ts`）
   所有响应都不带 `access-control-allow-origin`，鉴权只认 `Authorization` 头。浏览器发出的跨站 `fetch`（含 DNS rebinding 后的同域名请求）无法附加该头，预检 `OPTIONS` 也不带凭据 → 即使 URL fragment 泄漏了 `pageToken`，网页侧仍无法代发特权请求。CR-07 的结论因此限定在"页面可读 + 变更无审计 + 错误回显"，不是"网页可直接控制运行"。

---

## 未证实（明确不作为结论）

- **常量时间比较缺失的实际可利用性**：`control-server.ts:217` 用 `!==`，但 Node 的字符串比较耗时在本机噪声内无法稳定区分，未构造出可复现 PoC。
- **审批应答按 question id 重放**：consequential/login 的 questionId 是固定常量（`dsh-cu-consequential` / `dsh-cu-login`）。宿主是否按 id 缓存 durable answer 无法在本仓验证（`userQuestions` 实现不在本仓库），故不宣称可重放。
- **多问题并发共用同一 gateway**：`approvals.ts:34` 每次只提交 1 个问题，是否因共享 id 在宿主侧串答案无法复现。
- **DNS rebinding 读 API**：需要攻击者同时持有一个有效 bearer，本仓库内不存在把 token 送到攻击者网页的链路（fragment 不随请求发出），未验证成功路径。
- **控制页 XSS**：`renderSkills`/`renderAudit` 全部走 `textContent`，`escapeJson` 转义 `<`/`>`，`labels` 来自静态 locale，未找到注入点。

## 附：证据索引

| 文件 | 行 | 内容 |
| --- | --- | --- |
| `packages/dsh-browser-use-d1/src/skill-runner.ts` | 17-27, 29, 46-146 | 无 approvals 形参；risk 覆盖；回放循环零审批 |
| `packages/dsh-computer-use-d1/src/skill-runner.ts` | 28, 30 | 同构缺陷 + `assertSkillScope` 仅此处调用 |
| `packages/dsh-browser-use-d1/src/controller.ts` | 226-256, 296, 346-356 | D1 路径有四个审批调用；只捕获 TYPE_TEXT；候选 risk 来自调用方声明 |
| `packages/dsh-cu-core/src/policy.ts` | 5-10, 43-56, 58-87 | 策略字段、凭据识别、歧义升级 |
| `packages/dsh-cu-core/src/policy-approvals.ts` | 24-31, 33-64 | 两个 gate 的唯一判据 |
| `packages/dsh-cu-core/src/approvals.ts` | 28-45 | 应答形状信任 |
| `packages/dsh-cu-core/src/skills.ts` | 18-25, 132-159, 167-192, 229-243, 245-292 | origin/脱敏/水合/作用域/选择 |
| `packages/dsh-cu-core/src/skill-store.ts` | 48-71, 116-170 | 模块级写锁、read 全有或全无、证据与发布、reject |
| `packages/dsh-cu-core/src/skill-builder.ts` | 78-95, 97-129, 131-144 | 捕获下标、候选构造、`independent: true` 字面量 |
| `packages/dsh-cu-core/src/audit.ts` | 25-50, 64-115 | 白名单与脱敏、模块级写锁、read 全有或全无 |
| `packages/dsh-cu-core/src/run-controller.ts` | 89-92, 199-243, 256-259 | 审计链毒化、stop/resume、finish 早退 |
| `packages/dsh-cu-core/src/control-server.ts` | 161-217, 253-281 | 无鉴权页面、Host、路由全等、错误回显、超限断连 |
| `packages/dsh-browser-use-d1/src/index.ts` | 48, 94, 233-244, 316-319, 615, 646-660 | GUIDANCE 暴露 policy、fragment 令牌、发布弹窗、控制工具 action、publish 调用 |
