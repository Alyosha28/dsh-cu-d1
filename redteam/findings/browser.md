# 浏览器执行层红队审计报告（red-browser）

- 审计对象：`packages/dsh-browser-use-d1/src/**`（执行层本体），契约参考 `packages/dsh-cu-core/src/policy.ts` / `contract.ts` / `skills.ts` / `policy-approvals.ts`
- 审计方式：只读源码 + 真实 Chromium（Playwright 1.64.1 / Google Chrome）驱动**生产代码**复现，未修改任何被测文件
- 结论：**1 条 blocker、7 条 high、5 条 medium、3 条 low**，全部有可执行 PoC（`redteam/poc/browser/`，48 个断言用例全绿＝漏洞成立）
- 项目自带测试基线：`packages/dsh-browser-use-d1` **67/67 全绿**（见 §5），即下述缺陷在现有测试下完全不可见

---

## 0. 总览

| ID | 级别 | 一句话影响 | 主要证据 |
|---|---|---|---|
| BR-01 | **blocker** | 快照新鲜度由页面自己保管：一行 JS 即可让"批准的元素"与实际点击的元素不同 | `dom.ts:17-21`, `96-97`, `124-138`, `187-196` |
| BR-02 | high | 后果性动作没有任何分类，`risk` 由调用方自报且默认 `reversible` ⇒ 删除/付款默认零审批 | `controller.ts:225-243`, `policy-approvals.ts:24-26` |
| BR-03 | high | Skill 回放路径完全没有审批分支（连网关都不需要） | `skill-runner.ts`（全文无 `policy-approvals` 引入） |
| BR-04 | high | `text_visible` 是全文子串匹配："Not saved" 可通过断言 `Saved` | `dom.ts:206` |
| BR-05 | high | `input_value`/`checkbox` 按 label 全局定位且不校验可见性 ⇒ 隐藏诱饵元素即可满足断言 | `dom.ts:210-212` |
| BR-06 | medium | `url_contains` 裸 `includes`：`example.com.attacker.tld` 通过 `example.com` | `dom.ts:208` |
| BR-07 | high | 凭据闸门只认 `inputType==='password'`：`type=text` + `-webkit-text-security` 的 PIN 框零审批、连 `credentialsAvailable:false` 也不拦 | `policy.ts:25,44-47` |
| BR-08 | medium | 登录闸门是按钮文案正则：改名 `Continue`/`Weiter` 即绕过 | `policy.ts:50-56` |
| BR-09 | high | 上传审批与实际写入元素解耦（审批期间页面换 target）；提示只显示 basename；symlink 直接放行 | `upload.ts:70-111`, `31-47`, `92-96` |
| BR-10 | medium | 导航无目的地策略：任意 http(s)+跟随 302 直达 loopback/metadata，`extract` 回读正文 | `dom.ts:250-255`, `extract.ts:87-91` |
| BR-11 | low | 无名字控件直接跳过歧义闸门（表格里的图标按钮全部免疫） | `policy.ts:64-65` |
| BR-12 | medium | 审批弹窗的目标/范围完全由页面撰写（aria-label + document.title） | `policy-approvals.ts:15-22` |
| BR-13 | low | 所有页面（含后台标签页）的下载自动落盘，无审批、无上限；`waitForLatest` 会把旧文件当本次结果 | `index.ts:174-177`, `downloads.ts:41-45,58-89` |
| BR-14 | medium | 快照 id 从不清除：滚动后同名 id 指向两个节点，点击抛裸 strict-mode 错误 | `dom.ts:35-41`, `94-97`, `128` |
| BR-15 | medium | Skill 发布审批只显示计数，不显示步骤目标与断言文本 | `index.ts:233-244` |
| BR-16 | high | 读工具回传活密钥：`browser_observe` 直接给出密码框 value，`browser_extract` 读出密码与隐藏 token | `dom.ts:100-102`, `extract.ts:24-39` |

---

## 1. 复现环境

```
macOS / Node v24.20.0 / playwright 1.64.1 / Google Chrome 148（/Applications/Google Chrome.app）
repo: /Users/albaincompleta/DSH_CU   （只读 packages/**，仅写 redteam/**）
```

全量 PoC：

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts
```

```
 ✓ br13-downloads.spec.ts (3)   ✓ br07-credential-gate.spec.ts (3)   ✓ br90-boundaries.spec.ts (6)
 ✓ br08-signin-name.spec.ts (3) ✓ br04-verifier-text.spec.ts (4)     ✓ br01-freshness.spec.ts (3)
 ✓ br16-secret-read.spec.ts (3) ✓ br05-verifier-input.spec.ts (3)    ✓ br06-verifier-url.spec.ts (3)
 ✓ br02-consequential.spec.ts (3) ✓ br12-approval-text.spec.ts (2)   ✓ br10-navigation-ssrf.spec.ts (3)
 ✓ br09-upload-toctou.spec.ts (2) ✓ br11-unnamed.spec.ts (2)         ✓ br15-skill-publish.spec.ts (1)
 ✓ br14-id-reuse.spec.ts (1)
 Test Files  17 passed (17)
      Tests  48 passed (48)
```

**读法**：这些 spec 断言的是"漏洞成立"（例如"点击落在了 trap 上"），所以全绿＝缺陷可复现；`br90-boundaries.spec.ts` 相反，断言攻击**失败**，同样全绿＝这些边界确实守住了。

单项复现（示例）：

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts br01
```

---

## 2. 发现

### BR-01 · blocker · 快照新鲜度由页面保管，点击可被重定向到任意元素

**证据**

- `dom.ts:12-22`：`MutationObserver(bump).observe(..., {subtree:true, childList:true, characterData:true})` —— **没有 `attributes:true`**；同时"已安装"标志与版本计数都写在页面可写的 `window.__dshDecisionObserver` / `window.__dshDecisionVersion` 上。
- `dom.ts:96-97`：快照把 `data-dsh-decision-id="eN"` 写进页面 DOM（页面可读、可改、可搬）。
- `dom.ts:124-138`：`FRESHNESS_SCRIPT` 的唯一权威就是 `window.__dshDecisionVersion` 与 `document.querySelector('[data-dsh-decision-id="…"]')`。
- `dom.ts:164-169` / `187-196`：`assertFresh()` 通过后，`page.locator('[data-dsh-decision-id="…"]').click()` —— 期间的任何属性改动都不会让快照失效。

**攻击步骤**

1. 页面在受控标签页里渲染两个控件：一个"Pay invoice"（D1 将要选中的目标），一个"Delete everything"（攻击者真正的目的）。
2. 快照执行，`Pay invoice` 拿到 `data-dsh-decision-id="e1"`，决策模型基于该快照选择 `CLICK e1`。
3. 页面（任意脚本、任意时机，甚至 `MutationObserver` 监听 attribute 后立刻反应）执行：
   `real.removeAttribute('data-dsh-decision-id'); trap.setAttribute('data-dsh-decision-id','e1')`。
4. `assertFresh()`：URL 未变、版本未变（属性改动不触发 bump）、`[data-dsh-decision-id="e1"]` 存在且可点 ⇒ 通过。点击落在 trap 上。

变体（更强）：页面在文档开头写 `window.__dshDecisionObserver = true`。`OBSERVER_SCRIPT` 第 13 行直接 return，观察器永不安装、版本恒为 0 ⇒ **任何** DOM 变化（包括 `replaceWith` 整颗替换控件）都被判为"新鲜"。这条不需要知道 id，也不需要属性技巧。

**实际影响**：整个执行层的核心不变量——"动作作用在被观察、被批准的那个元素上"——不成立。配合 BR-02（默认无审批）/ BR-03（Skill 无审批），一次 `CLICK` 的实际目标完全由页面决定；对审批型动作（BR-12）则是"人批准了 A，机器点了 B"。

**复现**

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts br01
```

```
 ✓ br01-freshness.spec.ts (3 tests)
   ✓ clicks the attacker element after the page re-points data-dsh-decision-id
   ✓ freezes the version counter so arbitrary DOM substitution is accepted
   ✓ control: with the observer intact the same mutation is rejected as stale
```

关键断言：`expect(window.__clicked).toEqual(['trap'])`；变体中 `window.__substituted === 1`（被替换后的新控件收到了点击）；对照组同样改动则抛 `StaleSnapshot`。

**修复方向**：不要把新鲜度交给页面状态。(a) 属性纳入观察面（`attributes:true, attributeFilter:['data-dsh-decision-id','disabled','aria-disabled','style','class','hidden']`）；(b) 版本计数放在 provider 侧（Node 内存），由 CDP/`page.evaluate` 回传的单调计数或每次动作前的**元素身份令牌**（随快照生成随机 nonce 属性 + 快照时记录该属性值，执行前校验 nonce 与元素仍是同一节点）承担；(c) 拒绝任何页面可写的"已安装"标志；脚本每次执行不要用 `if (installed) return` 早退；(d) 执行前重新校验目标节点的 `isConnected`、同一节点引用（`WeakRef`/`__dshToken`）与派生 selector 唯一性。

**回归测试建议**：把 BR-01 的两个用例收进 `tests/dom.spec.ts`：属性改写后必须 `StaleSnapshot('dom_changed')`；预置 `__dshDecisionObserver` 不得影响版本递增；再补一条"快照→决策（人为延迟 2s）→页面替换节点→执行"的端到端用例。

---

### BR-02 · high · 后果性动作没有任何分类，审批靠调用方自报风险

**证据**

- `controller.ts:225-243`：只有 `needsConsequentialApproval(policy)` 为真才请求审批。
- `policy-approvals.ts:24-26`：`policy.risk === 'consequential' && policy.allowConsequential !== true`。
- `policy.ts:8`（`taskPolicySchema`）：`risk` 默认 `'reversible'`；`contract.ts:19` 中 `policy` 整体可选。
- 仓库里已有 `ConsequentialActionGuard`（`packages/dsh-cu-core/src/action-guard.ts`），但两个 provider 都没有引用，浏览器侧没有任何"动作→后果"的分类器。

**攻击步骤**

1. 页面内容（或用户措辞、或提示注入）让决策模型选择 `CLICK` 一个"Delete account"/"Pay 499 EUR"控件。
2. 调用方未显式传 `policy`（这是默认路径，`GUIDANCE` 也只说"policy accepts risk=…"）。
3. `needsConsequentialApproval` 为假 ⇒ 无审批、无提示，直接派发。

**实际影响**：破坏性/资金类动作在默认配置下**完全没有人类确认**。审批是否存在，取决于 agent（可被页面内容影响）是否自愿声明 `risk:consequential`，等于让被审计方自己决定是否接受审计。Skill 捕获还会把当时的 `risk` 固化下来（`controller.ts:354`），所以一次"默认"捕获会把删除动作永久存成 `reversible`（见 BR-15 输出里的 `Risk: reversible`）。

**复现**

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts br02
```

```
 ✓ performs a destructive click with the default policy and never asks for approval
 ✓ control: the same click with risk=consequential does ask for approval
 ✓ a payment form with card data also runs unapproved under the default policy
```

关键断言：默认策略下 `result.status==='success'`、`window.__deleted===1`、`approvals.calls === []`；付款场景 `window.__paid === '4111111111111111'` 且零审批；对照组 `risk:'consequential'` 时 `approvals.calls.length === 1`。

**修复方向**：把"是否需要审批"从调用方声明改为 provider 侧判定：按元素角色/名称/表单上下文/目标表单的 `method`/`action`/按钮 `type=submit` + 关键词语义（删除、支付、转账、发送、注销、解绑…）分类，未分类的**默认按后果性**处理（fail-closed）；`risk` 只允许**提高**等级，不能降低；同时把 `ConsequentialActionGuard` 接进浏览器执行路径（同指纹重复动作二次确认）。

**回归测试建议**：数据驱动用例覆盖若干破坏性控件，断言"未声明 policy 时仍必须 request 一次审批"；再加一条"`allowConsequential:true` 只在显式传入时生效"。

---

### BR-03 · high · Skill 回放路径完全没有审批

**证据**

- `skill-runner.ts:1-14`：只引入 `checkPagePolicy` / `checkTargetAmbiguity` / `validateDecision` / `verifyAll`，**没有** `policy-approvals`、没有 `ApprovalGateway`。
- `skill-runner.ts:29`：`const policy = taskPolicySchema.parse({ ...args.policy, risk: skill.risk })` —— 算出来了，但只被 `checkPagePolicy`（凭据可见性）使用。
- `skill-runner.ts:99-133`：暂停/停止/预算检查齐全，唯独没有审批分支。
- `controller.ts:112-124`：命中 Skill 直接 `runBrowserSkill(...)` 并 return，D1 循环里的审批代码根本不会执行。
- `skills.ts:287-292`：未传 `skillId` 时按 `origin+path` 自动选中唯一候选项 —— 回放是隐式的。

**攻击步骤**

1. 某次运行在该 origin+path 上捕获并发布了一个 Skill（发布审批见 BR-15：人只看到计数）。
2. 之后任何一次运行只要落在同一 `origin+path`（`SkillStore` 里有且仅有一条匹配），就自动走回放，不触发 D1、不触发审批。
3. Skill 的 `risk:'consequential'` 也不产生任何提示；`execution`/`approvals` 传 `undefined` 同样照跑。

**实际影响**：已发布 Skill 等于"永久免审批的宏"。一次误发布（或一次被污染的捕获）把破坏性动作变成静默重放；且 `selectSkill` 的自动匹配让它无需 agent 主动选择。

**复现**

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts br03
```

```
 ✓ replays a consequential Skill with no approval gateway at all
 ✓ auto-selects the published Skill from the URL and still asks for nothing
 ✓ control: the identical destructive action on the D1 path needs approval
```

关键断言：Skill 回放 `route:'skill'`、`actionsExecuted:1`、`window.__deleted===1`，而 approvals 网关**根本没有被传入**；D1 对照组同动作 `approvals.calls.length === 1`。

**修复方向**：Skill 回放必须走与 D1 相同的动作门（`actionApprovalContext` + `needsConsequentialApproval` + `needsLoginApproval`），并且：
- 一次 Skill 级别的"整段确认"（把步骤列表展示给人）**不能**替代逐步的后果性判定；
- `skill.risk` 只能是下限，实际风险取 `max(skill.risk, classify(step))`；
- 自动匹配命中的回放也应先确认（或只在 `allowConsequential` 显式给出时静默）。

**回归测试建议**：与 BR-03 同款 A/B 用例进 `tests/skill-lifecycle.spec.ts`；再加"Skill 未带 verify / 带 custom 断言时不得回放"。

---

### BR-04 · high · `text_visible` 是全文子串匹配，失败结果可通过成功断言

**证据**：`dom.ts:206` —— `page.getByText(assertion.text, { exact: false }).first().isVisible()`。`exact:false` 是大小写不敏感的子串匹配，作用域是整个主文档，且只要求第一个匹配可见。

**攻击步骤 / 实际影响**

- 断言 `Saved`，页面写 `Not saved` ⇒ 命中（语义相反）。
- 断言 `deleted`，页面写 `The account was not deleted` ⇒ 命中。
- 断言 `order confirmed`，正文是 `Payment declined`，页脚有 "an order confirmed here is only a sample" ⇒ 命中。
- 因为不指定区域，任何页脚/示例文案/模板残留都能满足"操作结果"断言；而 `verifyAll` 是唯一的成功闸门（`controller.ts:157,213,413`），所以**失败的操作会被判成功**并（在 Skill 场景）被捕获成候选 Skill。

**复现**

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts br04
```

```
 ✓ verifies a failed operation as success through a negated phrase
 ✓ verifies success text that only exists in an unrelated region
 ✓ lets the page choose which copy of the text satisfies the assertion
 ✓ fails closed when the only match is hidden (no display:none false positive)
```

**修复方向**：`text_visible` 至少要有：(a) `exact` 语义或"整段文本相等"选项；(b) 可选作用域（`region`/`locator` 字段，限定到某个容器或 `role=status` 区域）；(c) 断言绑定"动作后新出现"（对比动作前后的可见文本集合），而不是"页面某处存在"；(d) 多个匹配时要求全部/指定第 N 个，而不是 `.first()`。

**回归测试建议**：把 BR-04 的前三条转为负向用例（必须 `false`），第四条保持。

---

### BR-05 · high · `input_value` / `checkbox` 可被隐藏诱饵元素满足

**证据**：`dom.ts:210-212` —— `page.getByLabel(label, { exact: true }).inputValue()` / `.isChecked()`。定位是**全局按 label 文本**，既不绑定"本次运行操作过的元素"，也不要求可见。

**前置条件（诚实说明）**：若真实控件也带同名 label，则两个匹配会触发 Playwright strict violation ⇒ `verifyAll` 的 `catch` 返回 `false`（fail-closed，见 B3）。因此本条成立的前提是"真实控件没有 `<label>`/`aria-label`"——这在真实页面里极其常见（`<div>邮箱</div><input placeholder="…">`）。

**攻击步骤 / 实际影响**

1. 页面渲染真实收件人输入框（用相邻文本 + placeholder 标注，`getByLabel` 不识别）。
2. 页面另外放一个 `hidden` 的 `<input aria-label="Recipient email" value="attacker@evil.test">`。
3. 运行没输入任何内容，`input_value` 断言却读到诱饵值 ⇒ 成功。checkbox 同理（隐藏的 `checked` 诱饵）。

**复现**

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts br05
```

```
 ✓ a hidden labelled decoy satisfies input_value while the real field is empty
 ✓ an off-screen labelled decoy does the same for a visible field without a <label>
 ✓ a hidden checked decoy satisfies checkbox while the visible box is unchecked
```

关键断言：`page.locator('#recipient').inputValue() === ''` 的同时 `verifyAll(...) === true`。

**修复方向**：断言必须绑定到"执行时那个元素"（把快照 id / `data-dsh-*` 令牌一并记入 trace，验证时按同一节点读取），并要求 `isVisible()` + 在视口内；label 定位只作为**发现**手段，不能作为**验证**手段。

---

### BR-06 · medium · `url_contains` 子串匹配无法表达 origin

**证据**：`dom.ts:208` —— `page.url().includes(assertion.value)`。

**复现**

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts br06
```

```
 ✓ an attacker host that contains the expected host passes url_contains
 ✓ a query parameter carrying the expected URL passes url_contains
 ✓ a loopback origin check is satisfied by a different port than the one expected
```

`https://example.com.account-verify.test/steal` 通过 `example.com`；`https://evil.test/phish?next=https://example.com/dashboard` 通过整条 URL。

**实际影响**：跨域/钓鱼落地页也能满足"回到本站"的断言；配合 BR-10（可自由导航）等于把"最终 URL 正确"这条最常用的收尾断言变成装饰。

**修复方向**：增加 `url_origin` / `url_path` 结构化断言（`new URL(page.url())` 后比较 `origin`/`pathname`，或要求 `equals`/`startsWith` 作用于规范化后的 origin+path），并把 `url_contains` 标为不可用于安全断言。

---

### BR-07 · high · 凭据闸门只认 `input[type=password]`

**证据**：`policy.ts:25`（`element.inputType === 'password'`）、`policy.ts:44-47`（`targetElement(...)?.inputType === 'password'`）。`inputType` 来自 `dom.ts:106`：`tag === 'input' ? el.type : null`。

**攻击步骤**

1. 页面用 `type="text"` + `-webkit-text-security: disc` 渲染 PIN/OTP/SSN 输入框（业界标准做法，D1 快照里它就是普通 textbox）。
2. 调用方声明 `policy.credentialsAvailable: false`（明确表示"没有可用凭据"）。
3. `checkPagePolicy` 找不到 `password` 元素 ⇒ 不拦截；`isCredentialInput` 为假 ⇒ 不请求登录审批；运行把秘密键入并提交。

**实际影响**：`credentialsAvailable:false` 这条硬约束可以被渲染方式绕过；「输入秘密必须审批」实际上只覆盖了 `type=password` 这一种写法。

**复现**

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts br07
```

```
 ✓ types and submits a masked text field with credentialsAvailable:false
 ✓ control: the same page with type=password blocks on credentialsAvailable:false
 ✓ control: the same page with type=password asks for login approval
```

关键断言：`type=text` 版本 `actionsExecuted:2`、`window.__submitted === '4821'`、零审批；`type=password` 版本 `status:'blocked', reason:'credentials_unavailable'`。

**修复方向**：不要用 input type 判定敏感度。改为对**任何**将被写入文本的控件做敏感度评估：同一表单内是否有"密码/PIN/OTP/验证码/卡号/安全码"语义标签、`autocomplete` 值（`current-password`/`one-time-code`/`cc-number`）、`-webkit-text-security`/`text-security` 计算样式、`inputmode`、以及"写入值是否像秘密"（高熵/数字串）；命中即按凭据路径走审批。另外 `contenteditable`/`role=textbox` 的敏感输入目前连 `type` 概念都没有。

**回归测试建议**：把 BR-07 三例加进 `tests/policy.spec.ts` 与 `tests/provider.spec.ts`（后者走真实 DOM 路径，现在的 policy 单测全是合成 observation，见 §4）。

---

### BR-08 · medium · 登录闸门是按钮文案正则

**证据**：`policy.ts:50-56` —— 先要求"页面当前有可见 `type=password`"，再对元素 name 跑 `/sign in|sign-in|log in|log-in|login|登录|登入|ログイン/`。

**复现**

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts br08
```

```
 ✓ starts a session through a submit control called "Continue" with no approval
 ✓ does not recognise non-English sign-in labels either
 ✓ control: the same click labelled "Sign in" is gated
```

同一页面（密码已由浏览器自动填充），按钮叫 `Continue` 或 `Weiter` 时零审批就建立了会话（`window.__session === 'cookie-set'`），叫 `Sign in` 时才有 1 次 `dsh-cu-login` 审批。

**实际影响**：OAuth/SSO/"继续"式二次认证、非英中日文案、图标按钮全都绕开登录审批；这正好是最常见的现代登录形态。

**修复方向**：登录判定应基于**表单语义**（`autocomplete=current-password`、`<form action>` 含 login/signin、提交后产生会话 cookie）或"该次运行期间写入过凭据/参加过认证流程"的状态机，而不是文案；至少补充多语言与 `type=submit` 的表单归属判断。

---

### BR-09 · high · 上传审批与实际写入元素解耦（TOCTOU），且提示只显示 basename / 放行 symlink

**证据**

- `upload.ts:70-77`：`locatorFor(...)` 后 `count()`、`evaluate()` 都在**审批前**完成。
- `upload.ts:89-107`：`approvals.request(...)`（人类思考时间，真实环境数秒到数分钟）。
- `upload.ts:111`：`await locator.setInputFiles(...)` —— Playwright locator 是惰性的，**在审批之后重新解析 selector**。
- `upload.ts:92-96`：提示只拼 `basename(file)` + 目标字段名 + 页面标题/URL。
- `upload.ts:31-47`：`stat()` 跟随符号链接，只校验"是常规文件 + 合计 ≤50MB"。

**攻击步骤**

1. 页面渲染 `<input id="approved" name="avatar" type="file">`（"换个头像"）。
2. `runBrowserUpload` 解析、校验、弹出审批：`pii.csv → avatar · <页面标题>`。
3. 人类阅读审批期间，页面脚本把 `#approved` 的 id 摘掉，新建一个 `id="approved" name="account_export"` 的文件输入并挂上 `change` 监听（可再自动提交到任意地址）。
4. `setInputFiles` 重新解析 `#approved` ⇒ 落到页面新建的输入框，页面拿到文件内容。

**实际影响**：人批准的是"A 字段 + 某个文件名"，实际交付的是"页面此刻决定的任意字段"；本地文件内容（`pii.csv` 里的卡号）被页面读取并外带。提示只给 basename，`/Users/me/.ssh/id_rsa` 显示成 `id_rsa`；symlink 让"invoice.pdf → /etc/hosts"这种路径也能过校验。

**复现**

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts br09
```

```
 ✓ the page can move the approval to a different file input before the write
 ✓ accepts a symlink as a regular file, so the approved name hides the real target
```

关键断言：审批 detail 含 `pii.csv`、含 `avatar`、**不含**目录；实际落点 `window.__sink === 'account_export'`，并且 `window.__content` 里出现 `4111`（卡号被页面读到）。symlink 用例：`input.files[0].name === 'invoice.pdf'`（真实目标是 `/etc/hosts`）。

**修复方向**：审批前把目标元素"钉住"——记录元素句柄/指纹（`data-dsh-upload-token` + 元素属性快照），审批后用同一句柄 `setInputFiles`，若节点已变则拒绝并重新审批；提示必须显示**完整路径**（含目录）、真实大小、MIME 与解析后的绝对路径（`realpath`），并拒绝 symlink 或显式提示"这是链接，指向 X"；对"审批到写入"的间隔设上限。

---

### BR-10 · medium · 导航没有目的地策略，302 可把你送进 loopback，`extract` 回读正文

**证据**：`dom.ts:250-255`（只校验 http/https 与无内嵌凭据）；`extract.ts:87-91`（`page.goto` 后直接读）；`index.ts:495-536`（navigate 工具无审批）、`363-392`（extract 工具无审批、无 policy）。

**复现**

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts br10
```

```
 ✓ accepts loopback and cloud-metadata destinations
 ✓ reads a loopback-only service through a redirect from a public-looking URL
 ✓ direct loopback navigation + extract also needs no approval of any kind
```

`navigationUrl('http://169.254.169.254/latest/meta-data/…')` 不报错；经 302 从"公共"URL 落到 `127.0.0.1` 的内部服务后，`extract` 返回 `{secret: 'DB_PASSWORD=prod-8f31'}`，`evidence.url` 显示已经跨到内网。

**实际影响**：受控浏览器成了可**读回**的 SSRF 客户端（本地管理口、Elasticsearch、云 metadata、内网面板）。页面内容足以诱导模型说"打开这个链接看看"；因为只校验初始 URL，任何"URL 白名单"都可以被 302 绕过。

**修复方向**：目的地分类（loopback/私网/link-local/metadata/`.local`）+ 默认拒绝策略；导航后校验 `page.url()` 的最终 origin 与 DNS 解析结果（防 DNS rebinding 与 302）；把"导航到私网"和"extract 私网响应"纳入审批；`extract` 对 `type=password`/`hidden` 与私网来源设限（另见 BR-16）。

---

### BR-11 · low · 无名字控件直接跳过歧义闸门

**证据**：`policy.ts:64-65` —— `target === undefined || normalized(target.name) === ''` ⇒ `return null`；`dom.ts:43-53` 的 `name()` 对纯图标按钮/`aria-hidden` 按钮返回 `''`。

**复现**

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts br11
```

```
 ✓ two identical icon buttons snapshot as unnamed and pass the ambiguity gate
 ✓ control: the same duplication with a name is reported as ambiguous
```

两个"删除行"图标按钮快照里 name 都是 `''`，`checkTargetAmbiguity` 返回 `null`（放行）；同名文本按钮则正确报 `ambiguous_target`。附带影响：这类元素的审批提示目标显示为 `e1`（见 BR-12 的第二条输出）。

**实际影响**：表格行内图标按钮（最需要歧义保护的地方）完全免疫；同时审批弹窗退化成"点击 e1"。

**修复方向**：空名不是"唯一"，而是"不可区分"——应升级为更严格的策略（要求上下文/行列标识区分，否则 `ambiguous_target`）；空名元素在审批提示里必须用可读上下文（所在行文本、`context`）替代 id。

---

### BR-12 · medium · 审批弹窗的目标与范围完全由页面撰写

**证据**：`policy-approvals.ts:15-22` —— `target: element?.name || element?.identifier || decision.target`（`name` 即页面 DOM 文本/`aria-label`，≤300 字），`scope: observation.title || observation.url`（`document.title` 由页面控制）。

**复现**

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts br12
```

真实弹出的提示（`console.log` 原文）：

```
[BR-12] approval detail shown to the human: 动作：CLICK
目标：Open read-only preview
范围：Settings · read-only preview
这次批准只覆盖当前动作。
```

而该按钮实际执行的是 `Delete account`（`window.__wiped === 1`）。第二条：

```
[BR-12] approval detail for an icon-only control: 动作：CLICK
目标：e1
范围：Dashboard
```

**实际影响**：同意界面可被被审计对象撰写——`aria-label="Open read-only preview"` 的按钮做删除；`document.title` 可以伪装成"只读预览/沙箱"。人类批准的是页面写的文案，不是动作本身。这也是把 BR-02/BR-07/BR-08 的绕过"洗白"的一环。

**修复方向**：审批提示应主要来自**provider 侧**事实：操作类型、元素的可信选择器路径、元素类型/role/`type`、目标表单的 `method`+`action`（解析后的绝对 URL）、是否跨 origin、本次运行已执行的动作序列；页面文本只能作为**引用**并明确标注"以下文字来自页面"；对超长/含换行/含方括号的 name 做转义与截断。

---

### BR-13 · low · 下载对所有页面自动落盘，无审批无上限；`waitForLatest` 会把旧文件当本次结果

**证据**：`index.ts:174-177`（`downloads.attach(page)` + `context.on('page', next => downloads.attach(next))`）；`downloads.ts:41-45`（每个 page 的 `download` 事件直接 `save`）；`downloads.ts:58-89`（`records.at(-1)` 即返回，哪怕它是上一轮动作的产物）。

**复现**

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts br13
```

```
 ✓ saves an arbitrary number of downloads with no approval and no size cap
 ✓ a background tab nobody is looking at also writes files to disk
 ✓ waitForLatest reports an older download as the result of the current call
```

3 次点击 ⇒ 磁盘 3 个文件；页面自开的**后台标签页**触发下载同样落盘；第二次 `waitForLatest(200)` 在没有新下载的情况下返回上一轮的 `first.txt`。

**实际影响**：任何被访问页面（含广告/弹窗/后台页）都能无审批写文件（磁盘填充、投放"看起来像下载物"的文件）；`browser_downloads wait` 可能把旧文件报告成本次动作的产物，误导后续判断。

**修复方向**：下载与"产生它的动作"绑定（记录 `download` 事件与触发它的 `CLICK` 的关联，只接受当前 run 产生的记录）；加单文件/总量上限与类型提示；可选审批或至少让 `wait` 只返回"本次调用之后产生"的记录。

---

### BR-14 · medium · 快照 id 从不清除，滚动后同一 id 指向两个节点

**证据**：`dom.ts:35-41`（`visible()` 要求在视口内）、`dom.ts:94-97`（只为可见元素赋 id，从不清理旧属性）、`dom.ts:128`（新鲜度检查用 `document.querySelector`，返回 DOM 顺序第一个）、`dom.ts:188`（点击用同一个 selector → 多匹配时 Playwright strict violation）。

**复现**

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts br14
```

```
 ✓ produces duplicate ids after a scroll and throws a raw strict-mode error
```

滚动后 `document.querySelectorAll('[data-dsh-decision-id="e1"]').length === 2`；`dom.execute` 抛 `strict mode violation`（**不是** `StaleSnapshot`），因此 `controller.ts:298-305` 的 stale 重试不生效，`index.ts:268-287` 的 `knownFailure` 也映射不了它 ⇒ 工具直接抛未分类错误。

**实际影响**：`SCROLL_DOWN` 之后的常规操作会硬失败；更糟的是"可点性检查"检查的是**旧节点**，而点击意图是新节点——两者不是同一个元素，这与 BR-01 属于同一类语义缺陷（检查对象≠执行对象），只是这条表现为可用性故障而非静默重定向。

**修复方向**：每次快照前清除全部 `data-dsh-decision-id`（或使用带快照序号的复合键 `data-dsh-decision-id="s3:e1"`）；新鲜度检查与派发都必须保证**唯一匹配**（`querySelectorAll().length===1` 否则 stale）；把 strict violation 映射为 `StaleSnapshot('target_ambiguous')`。

---

### BR-15 · medium · Skill 发布审批只显示计数，不显示内容

**证据**：`index.ts:233-244` `skillDetail()` = scope/risk/步骤数/断言数/证据时间；`index.ts:648-655` 用它组装发布审批。

**复现**

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts br15
```

真实提示（`console.log` 原文，动作是"删除收款人 + 输入金额"）：

```
Scope: https://bank.example/admin
Risk: reversible
Steps: 2
Verification assertions: 1
Latest evidence: passed at 2026-10-31T16:55:00.525Z
发布后该版本不可修改。
```

**实际影响**：人类批准的是一段"2 步、1 条断言"的摘要，看不到步骤目标、键入值、断言文本；同时 `Risk: reversible` 说明捕获时沿用了默认风险（BR-02）。批准后该 Skill 立即具备 BR-03 的"无审批回放"能力，所以这个"盲批"是全链条的关键一环。

**修复方向**：发布审批必须展开步骤（目标名 + role + 是否一次性后果性动作）、断言全文、捕获到的输入键名（值脱敏），以及"该 Skill 将被哪些 origin/path 自动匹配"；`risk` 由 provider 重新评估而非继承。

---

### BR-16 · high · 读工具回传活密钥（observe 的 value、extract 的 inputValue）

**证据**

- `dom.ts:100-102`：`if (tag === 'input' …) value = el.value` —— 对 `type=password` 同样赋值；该 value 随 observation 一起：① 由 `browser_observe` 原样返回给模型（`controller.ts:391-394`），② 由 `d1_browser_subgoal` POST 给决策服务（`decision.ts:62-68`，`controller.ts:177`）。
- `extract.ts:24-39`：`readRawValue` 对 `input/textarea/select` 一律 `locator.inputValue()`，对 `type=password`、`type=hidden` 都返回真实值；没有任何 policy/审批入口。

**复现**

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts br16
```

```
 ✓ browser_observe returns the password field value in the observation
 ✓ browser_extract reads the password value and a hidden CSRF token
 ✓ the credentialsAvailable policy does not reach either read tool
```

关键数据：`observation.elements[...].value === 'hunter2-correct-horse'`；`extract` 返回
`{password:'hunter2-correct-horse', csrf:'csrf-token-9f13', card:'4111111111111111'}`。

**实际影响**：浏览器里已由密码管理器/用户填入的凭据、CSRF/会话 token、卡号，可以被一次"只读"工具调用带进模型上下文（→ 落到会话记录、审计、日志、以及任何下游模型端点）；`credentialsAvailable:false` 只作用于 subgoal 的 `checkPagePolicy`，observe/extract 完全不受约束；若受控浏览器是 attach 模式下用户自己的浏览器，这就是真实凭据泄露。

**修复方向**：快照与抽取对"秘密"统一脱敏（`password`/`one-time-code`/`cc-*`、`-webkit-text-security`、`type=hidden` 的 token 形态）——只回传长度/占位符，绝不回传值；`extract` 增加 `secrets:'refuse'|'masked'` 语义与审批；把"读取页面值"纳入与输入同级的策略与审计（现在 `loadPolicy` 只覆盖写入）。

---

## 3. 攻不破的边界（避免过度修复）

`redteam/poc/browser/br90-boundaries.spec.ts`（6 条，全绿＝这些攻击失败）：

| 编号 | 结论 | 依据 |
|---|---|---|
| B1 | `decision.target` 不能注入 CSS 选择器 | `dom.ts:188` 里 target 被插进 `[data-dsh-decision-id="…"]`，但 `validateDecision`（`actions.ts:25`）要求它等于快照元素 id，而 id 恒为 `eN`。端到端验证：恶意 target 让 `runBrowserSubgoal` 抛 `Target … is not valid for CLICK`，不会派发。 |
| B2 | Skill origin 绑定能抵抗大小写/默认端口/尾点/相似域名 | `https://EXAMPLE.test`、`:443` 通过（URL 规范化）；`example.test.`、`example.test.evil`、`http://` 均 `skill_origin_mismatch`。302 跨 origin 已有项目自带用例（`skill-lifecycle.spec.ts` "rejects replay success after an action navigates to another origin"）。 |
| B3 | 同名 label 的重复元素让验证 fail-closed | `getByLabel` 多匹配 ⇒ strict violation ⇒ `verifyAll` 的 `catch` 返回 `false`（BR-05 的诱饵攻击正因此要求"真实控件无 label"）。 |
| B4 | 无法评估的断言不会被静默满足 | `verifyAll` 的 `else` 分支 `return false`；`assertSupportedAssertions` 对 `custom` 直接抛错（`dom.ts:214-215,229-237`）。 |
| B5 | 下载文件名不能路径穿越 | `sanitizeDownloadName` 对 `../../etc/passwd`、`..\\..\\windows`、`..`、`.`、NUL 全部消解，最终为 `passwd`/`download`；落盘名还有 UUID 前缀。 |
| B6 | shadow DOM 与 iframe 内的控件不可被观测/不被赋 id | 快照只用 `document.querySelectorAll`（主文档 light DOM），shadow root 与 iframe 都不含 `data-dsh-decision-id`；既不能成为目标，也不能成为诱饵。代价是这类 UI 无法操作（fail-closed，属功能限制）。 |

另外两点已核实、**不建议蓝队改动**：

- `WAIT` 不做新鲜度检查（`dom.ts:173-177`）**无害**：它不派发任何输入，也不改变页面；`SCROLL_*` 同样只滚屏。真正需要新鲜度的是带 target 的操作，那里已检查（但检查对象不对，见 BR-01/BR-14）。
- `downloads`、`extract`、`observe`、`navigate` 的输入 schema 都是 `strict()`，多余字段会被拒（`z.strict()`/`additionalProperties:false`），不存在"偷偷塞参数"的面。

---

## 4. 项目自带测试是否真实覆盖

基线：`packages/dsh-browser-use-d1` **67 passed / 16 files**（`npx vitest run`，本机可复现）。但下列"通过"并不代表契约生效：

1. **属性 mutation 从未被测**。`provider.spec.ts:298` 的 stale 用例用 `fixtures/web/mutating.html`，页面只改 `textContent`（characterData），恰好是观察器唯一覆盖的两类之一。属性改写、`window.__dshDecisionObserver` 预置都没有用例（BR-01 因此长期不可见）。
2. **policy 单测全是合成 observation**。`tests/policy.spec.ts:7-14` 的元素 id 是 `'document'`/`'workspace'`，真实快照永远不会产出；也没有 `inputType:'text' + text-security`、空 name 的样本。所以 `policy.spec.ts` 全绿与 BR-07/BR-11 并存。
3. **登录/后果性审批只有"正向"用例**。`provider.spec.ts:256-284` 证明"声明了 consequential 会拦"、"标准登录页会拦"，但没有"未声明 + 破坏性控件"、"改名后的登录按钮"、"掩码文本框"的反向用例——审批的**遗漏面**无人覆盖。
4. **上传只测了拒绝分支**（`upload.spec.ts:100` 相对路径/目录/非文件），没有 symlink、没有"审批期间换 target"、也没有断言 prompt 内容是否包含完整路径。
5. **下载只测"能存下来"**（`downloads.spec.ts:24`），没有多下载/后台页/旧记录误报的用例，也没有任何"是否需要审批"的断言（该文件里 `DownloadSink` 根本没有审批概念）。
6. **`assertions.spec.ts` 的"空断言"风险**：`verifyAll` 用 `catch { return false }` 吞掉了所有异常，`inertPage()` 这个"一碰就抛"的 Proxy 之所以能证明"未评估的断言不算满足"，靠的正是这个 catch，而不是显式的分支覆盖。这条测试是有效的，但它是**唯一**一条验证器语义测试，`text_visible` 的子串/作用域、label 碰撞、可见性都无覆盖。
7. **`br90 B1`**：`validateDecision` 的"target 必须是快照 id"这条防线没有任何项目用例（我是靠端到端 PoC 才确认它守得住）；一旦有人把 id 生成改成"页面可指定"，B1 会静默失效。

结论：现有测试覆盖"happy path + 少量拒绝分支"，**未覆盖"页面是敌手"这一前提**。BR-01～BR-16 全部落在这些空档里。

---

## 5. PoC 清单

| 文件 | 覆盖 | 用例数 |
|---|---|---|
| `redteam/poc/browser/br01-freshness.spec.ts` | BR-01 | 3 |
| `redteam/poc/browser/br02-consequential.spec.ts` | BR-02 | 3 |
| `redteam/poc/browser/br03-skill-approval.spec.ts` | BR-03 | 3 |
| `redteam/poc/browser/br04-verifier-text.spec.ts` | BR-04 | 4 |
| `redteam/poc/browser/br05-verifier-input.spec.ts` | BR-05 | 3 |
| `redteam/poc/browser/br06-verifier-url.spec.ts` | BR-06 | 3 |
| `redteam/poc/browser/br07-credential-gate.spec.ts` | BR-07 | 3 |
| `redteam/poc/browser/br08-signin-name.spec.ts` | BR-08 | 3 |
| `redteam/poc/browser/br09-upload-toctou.spec.ts` | BR-09 | 2 |
| `redteam/poc/browser/br10-navigation-ssrf.spec.ts` | BR-10 | 3 |
| `redteam/poc/browser/br11-unnamed.spec.ts` | BR-11 | 2 |
| `redteam/poc/browser/br12-approval-text.spec.ts` | BR-12 | 2 |
| `redteam/poc/browser/br13-downloads.spec.ts` | BR-13 | 3 |
| `redteam/poc/browser/br14-id-reuse.spec.ts` | BR-14 | 1 |
| `redteam/poc/browser/br15-skill-publish.spec.ts` | BR-15 | 1 |
| `redteam/poc/browser/br16-secret-read.spec.ts` | BR-16 | 3 |
| `redteam/poc/browser/br90-boundaries.spec.ts` | 边界 B1-B6 | 6 |
| `redteam/poc/browser/harness.ts` | 真实 Chromium + 轮询页面 + 决策/审批桩 | — |

运行：

```bash
npx vitest run --config redteam/poc/browser/vitest.config.ts          # 全部（48）
npx vitest run --config redteam/poc/browser/vitest.config.ts br01     # 单条
```

说明：`harness.ts` 里只有 D1 决策服务、`ApprovalGateway`、`ExecutionHandle` 是桩（它们是宿主侧输入），页面、快照、执行、验证、上传、下载、Skill 都是**生产代码本体**；BR-03/BR-15 走的是真实 `SkillStore` + 真实工具注册表（`@albaincompleta/dsh-cu-testkit`）。

---

## 6. 未证实 / 未覆盖（不计入发现）

- **真实 D1 模型在页面注入下的选择行为**未测：我的 PoC 用脚本化决策替代模型，证明的是"一旦决策落在 X，执行层会怎样"。页面文案能否稳定把真实模型推向破坏性控件，属于模型侧对抗，不在本次浏览器执行层范围。
- **`attach` 模式下 `describeTabs` 把用户其它标签页的 URL/标题回传给模型**（`tabs.ts:20-28`）只做了代码核对，没有构造真实 attach 场景；隐私影响真实存在但未做端到端复现，不算发现。
- **并发/重入**：`RunController.start` 的"另一个 run 已存在"分支（`run-controller.ts:100-110`）与工具层的 `run_active` 只在代码层核对；没有构造两个 agent 并发打同一资源。`tabs`/`upload`/`navigate` 的 `controller.status(agent).active !== undefined` 检查存在 TOCTOU 窗口，未构造出可用 PoC。
- **`preview.ts` / `BrowserPreviewProcess`**：Swift helper 的 IPC 只是逐行 JSON，`handleEvent` 已做 `safeParse`；未发现可利用面，也未做 fuzz。
- **`takeover.ts` 的会话存储/表单值回填**：`restoreTakeoverState` 按 id/name/序位匹配并校验 tag+type，属于"尽力恢复"；没有发现越权写入路径，未深入。

---

## 7. 复现边界（合规声明）

- 只读取了 `packages/**`、`src/**`、`scripts/**`；只在 `redteam/` 下写入。
- 未执行 `git commit/push`、`npm install`，未改 `package.json`/`package-lock.json`，未删除任何文件，未 kill 进程（除测试自身启动的 Chromium）。
- 所有"外带"演示都指向本机临时目录与 `127.0.0.1` 上自建的临时 HTTP 服务。
