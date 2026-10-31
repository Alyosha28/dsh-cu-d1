# DSH_CU 能力对照与差距清单

> 目的：回答「主流的 Computer Use / Browser Use 能力都有什么，我们缺什么」。
> 方法：外部能力以官方文档/仓库为准（附链接），内部能力以本仓库源码为准（附文件行号），不用自评。
> 口径：只说有证据的能力；没有实现的一律标"未实现"，不用"实验性支持"这种模糊说法。

---

## 0. 先看这段

**一句话**：我们的**治理层**（强制独立验证、审批后不可变技能、动作空间物理约束、本地决策）在行业里是稀缺的；我们的**执行层**（iframe/tab/上传下载）仍落后于开源主力框架；定位式结构化提取已经补齐。

三个具体结论：

1. **验证器有洞，本轮已修，但教训要留住。** 浏览器侧 `custom` 断言曾是空操作，会直接返回"成功"（实测：`custom-only -> true`，page 一次都没被访问）。已改为 fail-closed + 入口拒绝，并有永久回归测试覆盖。真正的教训是：**未知断言必须默认不通过**——我们整套安全叙事押在"验证在模型之外独立完成"上，验证器一旦 fail-open，这层就变成纸面承诺。
2. **缺的是"能不能用在真站点"的那一层，不是"更聪明"。** `iframe`/shadow DOM、多标签页、上传下载、登录态复用仍未实现。`extract(schema)` 已补成显式定位 + 类型转换的确定性版本，但不是自由文本语义抽取。动作空间 5 类 vs 对方 10–27 个。
3. **领先的是"约束"而不是"能力"。** 商用四家文档里**一个内建后置验证都没有**；开源里只有 `cua` 的 `verified`/`effect` 协议和 Playwright MCP 的 opt-in `browser_verify_*` 与我们这一层对等。我们的技能发布模型（独立复跑 + 用户批准 + 不可变）没有找到对等物。但这些优势建立在一个 2B 模型 + 严格动作空间之上，不是模型更强。

推荐的 P6 顺序（详见第 5 节）：

```
正确性（custom 断言、工具重名、Skill origin 与自验证已完成；目标解析与演化待做）
   ↓
table stakes（extract 已完成；iframe/shadow、tab、上传下载待做）
   ↓
安全运维（脱敏留存、幂等键、预算）
   ↓
评测诚实性（≥3 次重复、成本表、held-out）
```

---

## 1. 盘点方法

- **内部**：逐文件读 `packages/*/src`，用关键词扫描确认缺项（`iframe` / `shadowRoot` / `download` / `upload` / `tabs` / `cookie` / `storageState` / `proxy` / `retry` / `idempot` / `checkpoint` / `redact` / `retention` 命中数均为 0）。
- **外部**：三条独立调研线（商用产品 / 开源框架 / 评测基准），每条要求给官方链接，未核实的标 `[未核实]`。
- **不对比营销口径**：厂商自报的 benchmark 数字单独标注，不与我们的本地 fixture 结果混在一张表里。

---

## 2. 我们实际有什么（源码为准）

### 2.1 执行模型

| 能力 | 现状 | 证据 |
|---|---|---|
| 工具面 | 两个子目标入口；浏览器另有 `browser_extract`；控制与发布按 Provider 分名：`browser_control` / `browser_skill_publish`、`computer_control` / `computer_skill_publish`，可用 `toolPrefix` 改前缀 | `packages/dsh-browser-use-d1/src/index.ts`、`packages/dsh-computer-use-d1/src/index.ts` |
| 任务边界 | 单一有界子目标：`goal` + `verify[]`(1–12) + `maxSteps`(≤50) + `policy` + `inputs` + `skillId`，`.strict()` 拒绝多余字段 | `packages/dsh-cu-core/src/contract.ts:14-22` |
| 步进循环 | 验证→快照→策略门→D1 决策→决策校验→歧义检查→去重→执行→后置等待 | `packages/dsh-browser-use-d1/src/controller.ts:105-213` |
| 路由 | Verified Skill（0 次模型调用）→ D1 → human；结果带 `route`/`skillId`/`fallbackReason` | `controller.ts:87-100` |
| 决策模型 | 本地 LiquidAI d1-2B（System 1），speculative / on-demand 两种取文策略 | `config.ts:36`、`results/TEXT_STRATEGY_AB.md` |
| 预算 | 步数上限 + 墙钟上限 + 输入/输出 Token 上限，浏览器与原生 D1 循环均在决策前、用量入账后、输入派发前检查 | `packages/dsh-cu-core/src/budget.ts`、两个 `config.ts`、两个 `controller.ts` |

**缺口（本级）**：没有 run 级 checkpoint 与断点续跑；`confidence` 只记录不参与门控（`controller.ts:159`）。

**结构化提取（已实现）**：`browser_extract` 接受 1–40 个字段，每个字段用 `label` / `role` / `text` / `css` 显式定位，返回 `string` / `number` / `boolean` / `url`；支持 `all` 数组、属性读取、可选字段和共享等待预算。缺失、歧义、类型转换失败均 fail closed；结果带页面 URL、标题与逐字段命中证据，页面内容标记为不可信。全程不调用 D1、不派发输入，也不写入快照标记。实现：`packages/dsh-cu-core/src/extract.ts`、`packages/dsh-browser-use-d1/src/extract.ts`。

### 2.2 观察表示与目标定位

| 能力 | 现状 | 证据 |
|---|---|---|
| 浏览器观察 | 剪枝 DOM → 元素表 `id/role/name/value/actions/enabled/context` + 页面标题/状态区 | `packages/dsh-browser-use-d1/src/dom.ts:25-106` |
| 浏览器定位 | 语义定位（role + accessible name + 上下文标题），坐标仅作兜底 | `dom.ts:41-71`、`actions.ts:18-27` |
| 原生观察 | 官方 CUA 的 AX 状态树；AX 缺失时走截图 | `packages/dsh-computer-use-d1/src/controller.ts`、`results/VISUAL_DECISION_REPORT.md` |
| 坐标映射 | 像素 ↔ 原生窗口 point，窗口尺寸变化使映射失效（`WINDOW_CHANGED` / `SCREENSHOT_REQUIRED`） | 官方 `@deepseek-ai/dsh-cua` 文档 |
| 陈旧快照 | 元素 id 失效后拒绝执行，不重放 | `dom.ts` 的 `StaleSnapshot`、`controller.ts:199-203` |

**缺口（本级）**：**单页单 frame**。`iframe`、shadow DOM、多标签页、下载、上传关键词命中数全为 0；浏览器资源只在 `open()` 时取 `context.pages()[0]` 或新建一个 page（`index.ts:79-84`），没有切换/新建 tab 的工具。

需要澄清一处容易误读的证据：P0 表里的 "Browser CSV download 741.3 ms" 是**原生 Playwright** 跑的（`workflow_e2e.py:58-62` 用 `page.expect_download()`），模型侧动作空间里并没有下载/上传，两者不能混为一谈。

### 2.3 安全与治理（这是我们相对扎实的一层）

| 能力 | 现状 | 证据 |
|---|---|---|
| 目标合法性 | 目标必须 `enabled` 且支持该动作，否则拒绝 | `packages/dsh-cu-core/src/actions.ts:18-30` |
| 凭据门 | 观察到 password 字段即拦截；需 `allowLogin` 或用户实时批准；`credentialsAvailable:false` 直接 blocked | `policy.ts:23-38`、`policy-approvals.ts:27-38` |
| 后果性动作门 | `risk: consequential` 需 `allowConsequential` 或一次性批准 | `policy.ts:24-26`、`policy-approvals.ts:12-25` |
| 歧义升级 | 同 role 同名目标 >1 且 goal 上下文无法唯一指向 → `escalated: ambiguous_target` | `policy.ts:38-76` |
| 无进展熔断 | 同一决策重复 2 次即停（`no_progress_same_decision_repeated`） | `controller.ts:178-186` |
| 审批通路 | 真实 DSH `userQuestions`（P4），非模拟 | `packages/dsh-cu-core/src/approvals.ts`、`results/P4_CONTROL.md` |
| 运行控制 | pause / resume / stop / takeover + 环回控制页 + JSONL 审计 | `packages/dsh-cu-core/src/run-controller.ts`、`control-server.ts`、`audit.ts` |
| 归属约束 | 资源绑定"精确存活 Agent"，非存活 Agent 调用直接报错 | `index.ts:209-219` |
| 取消语义 | 已交付输入不重放、不回滚 | README + `controller.ts` |
| 应用授权 | 官方 CUA 按会话 + 应用身份持久化授权 | `@deepseek-ai/dsh-cua` |

**缺口（本级）**：没有幂等 / exactly-once 语义（`idempot`、`exactly` 命中 0）；没有代理/隔离/stealth 配置。审计已通过白名单、凭据脱敏、私有文件权限和 `auditRetentionDays` 清理敏感数据；截图仅传给环回决策服务，审计与 Skill 不保存截图，决策和 CUA 调试日志只保留结构元数据。

### 2.4 Skill 生命周期（P3）

已实现：成功轨迹 → candidate（只留类型化操作 + 目标名，不落输入文本）→ 新上下文独立复跑 → 用户批准 → 不可变发布 → `verified` 才能被选中 → 重放 0 次模型调用。证据：`skill-store.ts`、`skill-builder.ts`、`skills.ts`、`results/P3_SKILLS.md`。

信任边界已补强：自定义 URL Skill 必须绑定精确 origin + path；内置 fixture 仅在 loopback 上按路径匹配。重放期间每个动作前和每次成功返回前都会重新校验当前 origin，同 origin 的路径跳转保持允许。发布和重放都要求 Skill 自带后置条件，旧的无 origin/无验证记录可读取但不可执行。断言中的真实输入值在落盘前替换为 `{{inputs:...}}` 占位符，重放时用当前输入水合，并同时检查 Skill 与调用方的断言；URL、窗口标题或步骤元数据含原始输入时拒绝生成候选。重复文本输入按顺序分配无冲突的逐步骤输入键，脱敏与重放不会因同名字段覆盖。

仍有两件事没做：

| 问题 | 具体表现 | 证据 |
|---|---|---|
| 目标解析过脆 | 按元素 `name` 精确相等找目标，找不到就整体回退 D1，不会按 role+context 重定位 | `skills.ts` 的 `decisionForSkillStep` |

Skill 演化已交付：已发布 Skill 重放失败并在副作用前回退 D1 后，修复成功的轨迹会生成 `version + 1`、带 `evolvedFrom` 的新候选，走标准独立复跑与用户批准门禁；原版本保持不可变。证据：`skill-store.ts` 的 `createCandidate(evolveFrom)`、两个 controller 的 `evolvedFromSkillId`、`skill-lifecycle.spec.ts` 的演化场景。

### 2.5 评测证据与已知失败

- 15 个场景（browser→native / 表单 / AX-less），负控、异步超时、多窗口守卫齐全：`benchmarks/scenarios.json`、`results/P5_EVALUATION.md`。
- 合成框定位 11/11、真实 Chrome 7/7：`results/d1-box-synthetic.json`、`results/d1-box-browser.json`。
- 测试：21 Python + 34 Browser + 7 Native + 16 core，本机复核 **78/78 全绿**（`pytest -q`、三个 workspace 的 `npm test`）。另有真实 D1 的 Browser e2e 2/2、Native e2e 2/2 通过。
- **诚实的负面结果**（P0 基线，`results/P0_BASELINE.md`）：D1 在明确"无凭据"时仍点 Sign in；两个同名 Save 时直接选一个而不是升级；异步任务重复点击 Load 两次。
- 无人类基线、无重复运行的方差统计、无成本核算。

### 2.6 代码级缺陷（已实测，不是推测）

**① 浏览器侧 `custom` 断言是空操作，直接造成"假成功"。**
`verifyAll` 只处理 `text_visible` / `url_contains` / `input_value` / `checkbox` 四种，没有 `custom` 分支，于是走到末尾 `return true`（`dom.ts:185-202`）。
实测（用拒绝任何属性访问的 page 代理对象 + 一个根本不存在的 handler 名）：

```
custom-only  -> true      # page 一次都没被碰过
url+custom   -> true
```

后果：一个只带 `custom` 断言的 browser 子目标，会在第 0 步的预检（`controller.ts:113`）就被判 `independently_verified`，**一个动作都不执行**。
原生侧语义相反——未知 handler 会抛 `Unknown native verification handler`（`packages/dsh-computer-use-d1/src/verification.ts:26-27`），而共享 schema 对两边都放行 `custom`（`contract.ts:10`）。现有测试只有原生侧的 custom 用例（`visual.spec.ts:96`），浏览器侧零覆盖。
这是**验证器可信度问题**，不是功能缺失：我们整套安全叙事的前提是"验证在模型之外独立完成"。

**已修（本轮）**：`verifyAll` 遇到无法求值的断言改为 `return false`（fail closed），并新增 `assertSupportedAssertions()` 在子目标入口显式拒绝 custom（`dom.ts:196-220`、`controller.ts:71`）；新增 `tests/assertions.spec.ts` 三条用例（含"page 不被触碰"的代理对象）。浏览器包 21/21 通过。**但这暴露的是一类问题而不是一个 bug**：验证器必须对"不认识的东西"默认不通过，而不是默认通过。

**② 两个包的模型侧工具重名，无法同时安装。**
`dsh-browser-use-d1` 和 `dsh-computer-use-d1` 都注册 `computer_control` 与 `skill_publish`（`browser/index.ts:144,170` vs `computer/index.ts:123,149`）。DSH 工具注册表对同 scope 重名直接抛错（`node_modules/@deepseek-ai/dsh-tools/lib/index.js:385`：`tool "<name>" is already registered`）。而"浏览器 + 原生都要"恰恰是主要用法。

**已修（本轮）**：两个 Provider 新增 `toolPrefix`，默认分别为 `browser` 和 `computer`；浏览器提取、运行控制、技能发布工具均按前缀命名，原生控制与发布同样按前缀命名。`tests/composition.spec.ts` 在同一个 DSH Context 中同时挂载两个 Provider，验证七类 Provider 工具全部注册且名称无重复。

---

## 3. 外部基准

三条独立调研线的完整报告在 `results/landscape/`：`COMMERCIAL_CU_BU.md`、`OSS_BROWSER_AGENT_LANDSCAPE.md`、`EVAL_LANDSCAPE.md`。下面是可用于对照的部分。

### 3.1 商用四家的能力骨架

| 维度 | OpenAI | Anthropic | Google | Microsoft |
|---|---|---|---|---|
| 动作空间 | 截图坐标；另一路径让模型写 Playwright/PyAutoGUI 代码 | 17 个原子工具（各键位点击、拖拽、hold_key、wait）；browser toolset 另有 27 个 | 坐标 0–999，含右键/中键/hotkey/scroll，移动环境另有 open_app | 虚拟键鼠，模型可换（OpenAI CUA / Claude） |
| 观察 | 截图为主；browser toolset 额外给控件/标签页 | computer use 仅截图；browser use 用 AX 树 + 元素 + tabs + 截图 | 截图 | 截图 |
| 人在环 | `confirm` 回调 + `allowed(action)` 白名单 + maxSteps | 后果动作确认；域名 allowlist | `require_confirmation` + `safety_acknowledgement` | 邮件审批（官方承认概率触发，不能当兜底） |
| 后置验证 | 无内建，示例由应用自己比对 | 无内建 | 无内建 | 无内建 |
| 隔离 | 要求隔离环境、凭证不得进截图 | 要求专用 VM/容器 | 客户侧执行 | Win11 VM |
| 计费 | 按图像 token | 按图 token（1000–1800/张） | 按调用 | 5 credits/步 |

### 3.2 开源框架：通用姿势与分化

- **几乎人人都有**：`act(instruction)` 单步入口；元素引用定位（index / ref / uid / element_token）；结构化观察为主、截图为辅；轨迹留存；**schema 化 `extract`**；登录态复用；多 tab；文件上传。
- **观察表示三分**：裁剪 DOM（browser-use、Agent-E）／纯 a11y（Playwright MCP、Chrome DevTools MCP）／截图为主（OmniParser、Skyvern、WebVoyager）。
- **失效处理**：只有 `cua` 把 `stale_element_token` / `effect` / `escalation` 做成协议字段；Nanobrowser 让旧元素 ID 直接失效；其余靠重拍快照。
- **重放三条路线**：轨迹逐条重放（browser-use，但 `extract` 与收尾仍调模型）／代码生成 + AI fallback（Skyvern）／Action 零推理（Stagehand，缓存依赖 Browserbase 托管）。
- **`iframe` / shadow DOM**：Stagehand 支持嵌套 iframe 与 closed shadow DOM，Agent-E、browser-use 也处理；这是分水岭能力。
- **验证**：`browser_verify_*`（Playwright MCP，需 `--caps=testing`）与 `cua` 的 `verified` 是仅有的显式后置条件；browser-use 文档自己承认 `is_successful` 只是自报。

### 3.3 评测口径：为什么"能跑通"不等于"可信"

| 基准 | 规模 | 判定方式 | 人类基线 |
|---|---|---|---|
| WebArena | 812 任务 / 6 自托管站 | 程序化 functional correctness | 78.24% |
| WebVoyager | 643 任务 / 15 真实站 | GPT-4V 看轨迹打二值（与人工一致率 85.3%） | — |
| OSWorld | 369 任务 / 真 VM | 逐任务 Python 脚本验最终状态 | 72.36% |
| WindowsAgentArena | 150+ / Win11 VM | 程序化检查 | 74.5% |
| AndroidWorld | 116 / 20 App | 系统状态（JSON/SQLite） | 80.0% |

两个必须记住的方法论事实：
1. **LLM judge 系统性高估**。Online-Mind2Web 对人工实测：GPT-4o（a11y）平均高估 8.1pp，rule-based 9.8pp，专用 WebJudge 仍差 5.9–10.5pp。
2. **单次最好成绩不可引用**。AndroidWorld 显示任务措辞改写就显著改分；多数榜单只报一次运行。

诚实的套件需要 12 条（独立后置验证、负控、≥3 次重复报方差、judge 校准、人类基线、成本记账、held-out 站点、防污染、可重置、轨迹留存、安全维度单列、公开失败清单），详见 `results/landscape/EVAL_LANDSCAPE.md`。

### 3.4 横向结论

- **table stakes（不做就没法用）**：`iframe`/shadow DOM、多 tab、上传下载、`extract(schema)`、登录态复用、人工确认闸门、allowlist、注入防护声明、隔离环境。
- **四家商用都没做的**：内建后置验证、公开基准分数（文档里一个都没有）、CAPTCHA/2FA 自动通过（Google 明确禁止）、高风险无人值守担保、完整审计回放。
- **开源侧也稀少的**：协议级的"效果确认"（仅 cua）、审批后才可发布的不可变技能（无）。

---

## 4. 差距矩阵

✅ 我们领先　🟰 对等　⚠️ 缺失　🚫 明确不做（附理由）

| # | 能力 | 我们 | 行业位置 | 依据 |
|---|---|---|---|---|
| 1 | 结构化观察（非纯截图） | 🟰 | browser-use / Agent-E 同一档 | `dom.ts:25-106` |
| 2 | 语义元素定位 | 🟰 | 与 a11y ref/uid 等价 | `dom.ts:41-71` |
| 3 | **强制独立后置验证** | ✅ | 商用全无内建；开源仅 cua / Playwright MCP(opt-in) | `contract.ts:17`、`dom.ts:185` |
| 4 | 陈旧快照拒绝 | 🟰 | 与 cua 协议级对等 | `StaleSnapshot` |
| 5 | 同名目标歧义升级 | ✅ | 未见对等实现 | `policy.ts:38-76` |
| 6 | 审批 + 暂停/停止/接管 + 审计 | 🟰 | 商用有 confirm，我们有真实 userQuestions + 环回页 | `run-controller.ts`、`control-server.ts` |
| 7 | **审批后才可发布的不可变技能** | ✅ | 开源只有"重放/缓存"，无审批与不可变性 | `skill-store.ts:88-99` |
| 8 | 动作空间广度 | ⚠️ | 我们 5 类 vs 对方 10–27 个原子动作 | `actions.ts:4-6` |
| 9 | `iframe` / shadow DOM | ⚠️ | Stagehand/Agent-E 已支持 | 关键词命中 0 |
| 10 | 多标签页 | ⚠️ | 普遍支持 | `index.ts:79-84` 单页 |
| 11 | 上传 / 下载 | ⚠️ | browser-use `upload_file`、Playwright MCP `file_upload` | 模型侧无动作 |
| 12 | `extract(schema)` 结构化读取 | 🟰 | 已实现显式定位 + 类型 schema，0 模型调用；不做自由文本语义抽取 | `core/extract.ts`、`browser/extract.ts` |
| 13 | 登录态复用（profile/cookie/storageState/2FA） | ⚠️ | 普遍；Skyvern 到 TOTP | 仅 CDP 附加 |
| 14 | 隔离（VM/容器） | ⚠️ | 商用强制，cua 到 VM 级 | 跑在用户会话 |
| 15 | 注入防护 | ⚠️ | 商用有分类器/消毒 | 仅散文声明 |
| 16 | 幂等 / 重复副作用保护 | ⚠️ | 商用靠 idempotency key 工程实践 | 关键词命中 0 |
| 17 | 成本核算与预算 | ⚠️ | 墙钟、输入 Token、输出 Token 预算已接入双端循环；成本核算未实现 | `core/budget.ts`、两个 `config.ts`、两个 `controller.ts` |
| 18 | 脱敏与留存策略 | 🟰 | 审计白名单、凭据脱敏、私有文件权限、可配置保留期限、Skill 输入占位符、调试日志元数据化 | `core/audit.ts`、`skill-store.ts`、`decision.ts`、`REAL_APP_ACCEPTANCE.md` |
| 19 | 评测诚实性（重复/方差/人类基线/held-out） | ⚠️ | 见 3.3 | 15 场景单次运行 |
| 20 | 多模型可插拔 | ⚠️ | 商用 2–4 个模型可选 | 仅 d1-2B |
| 21 | 通用 benchmark 分数 | 🚫 | 四家商用文档一个都不报 | 我们也不该刷 |
| 22 | CAPTCHA / 2FA 绕过 | 🚫 | Google 明确禁止；无一家声称 | 不做 |
| 23 | 工具数量竞赛（27 个） | 🚫 | 与我们定位无关 | 治理层才是价值 |

### 4.1 领先项为什么是真的（而不是自嗨）

1. **验证是强制项，不是选项**。`verify` 至少 1 条、最多 12 条，且判定读真实 DOM（`getByText`/`inputValue`/`isChecked`），模型说 DONE 不算数（`controller.ts:165-170` 明确记录 `premature_done_rejected_by_verifier`）。商用四家文档里都没有等价机制。
2. **技能发布是不可逆的审批动作**。证据必须"独立复跑通过"、批准者必须是 `user`（`skill-store.ts:88-99` 拒绝 `system`），发布后不可变。开源最接近的是 browser-use 的轨迹重放，但它自己承认 extract 仍调模型，且没有审批概念。
3. **模型能力被动作空间物理限制**。`validateDecision` 要求目标存在、`enabled`、且支持该动作（`actions.ts:18-30`）。即使页面注入成功，模型也只能产出"对某个合法元素的 5 类操作之一"，不能发任意 JS、不能改 URL、不能换端点。这比"提示词里写别听页面的"强得多——顺带这也是我们注入面的结构性缓解。
4. **决策在本地**。d1-2B 跑在本机（mps/cuda/cpu），截图和页面结构不出机器；商用四家全部上传云端。

### 4.2 领先项的前提曾被打破（本轮已修复）

第 3 条的前提是"验证器可信"。而 2.6① 证明浏览器侧 `custom` 断言会**静默通过**——在最需要它的场景（自定义业务后置条件），验证器会给假阳性。本轮已改为 fail-closed。
建议再加一道结构约束：浏览器包不该复用"含 custom"的共享 `subgoalInput`，而应派生一个去掉 custom 的 schema，让类型系统在调用前就拒绝，而不是靠运行时兜底。

---

## 5. 建议：P6 怎么排

### 第一档：正确性（先做，改动小，不做则前面所有结论不成立）

| 事项 | 具体做法 | 验收 |
|---|---|---|
| `custom` 断言 | ✅ **本轮已修**：`verifyAll` fail-closed + 入口 `assertSupportedAssertions`。后续可接与原生同构的 handler 注册表 | 已覆盖：`tests/assertions.spec.ts`（未注册 handler 被拒、page 不被触碰） |
| 工具重名 | ✅ **本轮已修**：默认前缀 `browser` / `computer`，并支持 `toolPrefix` 配置 | 已覆盖：`tests/composition.spec.ts` 同时挂载两个 Provider，工具名无重复 |
| 技能信任边界 | ✅ **本轮已修**：`match` 增加精确 `origin`，Skill 固化脱敏 `verify[]` 并在双端重放时水合执行；旧记录 fail closed | 跨 origin、隐私、旧记录、双端自带断言测试均覆盖 |
| 技能目标解析 | 按 name/identifier 精确匹配，后续可增加 role+context 消歧与安全归一化 | 重名与改名场景不能误点或静默猜测 |
| 技能可演化 | ✅ 已交付：重放失败后在有界 D1 修复成功时生成递增版本候选，走同一套复跑与审批 | 浏览器与原生回归均覆盖 `version: 2`、`evolvedFrom` 与原版本不可变 |

### 第二档：table stakes（决定"能不能用在真站点"）

1. **`iframe` / shadow DOM 递归遍历**——复用现有 `dom.ts` 的 role/name/context 规则，加 frame 前缀 ID。
2. **多标签页**——`open()` 时记录 context，增加 `switch`/`newPage` 动作；标签页 ID 进入快照。
3. **上传 / 下载**——上传走 `setInputFiles`（需要 file chooser 授权），下载走 `expect_download` 并落到受控目录 + 独立校验文件内容。
4. **`extract(schema)`**——✅ 本轮已实现 `browser_extract`：显式 locator、类型转换、多值数组、可选字段、属性读取、证据与 fail-closed 语义，零模型调用。自由文本语义抽取和跨 frame 提取不在本次实现范围内。

### 第三档：安全与可运维

5. 截图/审计脱敏与留存：✅ 已交付白名单、`auditRetentionDays`、私有文件权限和调试日志元数据化，并由真实应用三轮敏感标记检查覆盖。
6. 后果性动作的幂等键：同一 `(goal, target, action)` 在时间窗内重复提交需二次确认。
7. prompt injection：把"元素名/上下文"当作唯一不可信文本入口，加长度上限与可疑指令模式标记（不是拦，是标注给上层）。
8. 预算：✅ 已交付 `maxWallClockMs` / `maxInputTokens` / `maxOutputTokens`，超限返回对应结构化升级原因并阻止后续决策与输入。

### 第四档：评测诚实性

9. 每个场景 ≥3 次重复，报均值/标准差；只报一次的成绩不写进 README。
10. 成本表：$/task、token、步数、墙钟、人工介入次数。
11. held-out：至少留一组没参与调参的 fixture 站点/应用。
12. `results/` 里保留公开失败清单（延续 P0_BASELINE 的做法）。

### 明确不做

- 不刷通用 benchmark 分数（四家商用文档都不报，我们也缺可比环境）。
- 不做 CAPTCHA/2FA 绕过。
- 不追工具数量（27 个原子工具不是目标）；工具面窄、约束强正是我们的差异点。
- 在没有第三方应用矩阵之前，不声称"支持真实应用"。

---

## 6. 外部报告索引

- `results/landscape/COMMERCIAL_CU_BU.md` — 四家商用产品，逐项拆解 + 横向共性 + 明确未提供
- `results/landscape/OSS_BROWSER_AGENT_LANDSCAPE.md` — 11 个开源项目/13 个仓库
- `results/landscape/EVAL_LANDSCAPE.md` — 16 个基准 + 方法论问题 + 12 条诚实套件清单

> 版本细节（如 Anthropic 的 `computer_toolset_20260801`、OpenAI 的 GPT-6 Astra 推荐路径）来自子代理抓取的官方文档，未二次核验；结构性能力（有无内建验证、是否支持 iframe 等）在两个来源间一致，可用于决策。



