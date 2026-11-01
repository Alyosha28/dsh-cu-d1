# DSH-CU 红蓝对抗报告

> 方式：四个红队小组独立审计（只读、只写 `redteam/`），再由五个蓝队小组按**互不重叠的文件写域**修复，Lead 统一验收。
> 验收口径：`npm run build` + 每个 workspace 的测试 + `pytest` 全绿；每条修复必须有回归测试；红队报告与 PoC 保留为证据，不被改写。

## 1. 结论

| 项 | 结果 |
|---|---|
| 红队发现 | **49 条**（browser 16 / core 10 / native 11 / supply 12），含 **1 blocker**、**22 high**、**19 medium**、**7 low** |
| 攻击是否可复现 | 全部给出可运行 PoC；不可复现的猜测在各自报告里单列「未证实」，不计入结论 |
| 蓝队修复 | **41 条完全修复**（含全部 blocker 与 high）、**4 条部分修复**、**4 条**作为接受风险/后续项在 §6 明确记录 |
| 回归测试 | 新增 22 个测试文件；各包用例总数 99 / 126 / 69(+1 skip) / 6 / 28，Python 49 |
| 验收 | `bash redteam/verify.sh` → **GREEN** |
| 是否提交 | 未 commit、未 push（工作区 63 个文件修改，`redteam/` 未跟踪） |

一句话：**审批边界原本由被约束方（模型）自己填写，Skill 回放是一条完全绕过审批的高权限通道；快照新鲜度、验证器和上传/下载/读取的信任边界都能被页面内容操纵。这些在本轮全部关闭，并附带可复跑的回归测试。**

## 2. 红队方法与分工

| 组 | 攻击面 | 报告 | PoC |
|---|---|---|---|
| red-browser | 浏览器观察/快照/验证器/上传/提取/下载 | `redteam/findings/browser.md` | `redteam/poc/browser/`（17 spec / 48 断言） |
| red-core | 策略、审批、Skill 生命周期、审计、控制面 | `redteam/findings/core.md` | `redteam/poc/core/`（11 spec / 58 断言） |
| red-native | 原生执行层、坐标、指示器、权限、客户端 | `redteam/findings/native.md` | `redteam/poc/native/`（7 spec / 26 断言 + 基线复现脚本） |
| red-supply | 发布/打包/安装脚本/评测/Python/文档 | `redteam/findings/supply.md` | `redteam/poc/supply/`（7 脚本） |

方法要点：
- 贴着**文档承诺**打：`SKILL.md` 硬规则、`ARCHITECTURE_PLAN.md` §5.4/§6.3/§7.1/§8、`README.md` 的「外部审批」「独立验证」。
- 每个 PoC 驱动**生产代码**（真 Chromium、真 cordis 服务、协议对端假 helper），不 mock 掉被审计的机制。
- 明确记录**攻不破的边界**，避免蓝队过度修复（例如：Skill origin 已抗大小写/默认端口/尾点；控制面无 CORS；未知断言 fail closed）。

## 3. 最要害的五条（blocker/high，已修）

### 3.1 BR-01 快照新鲜度由页面保管（blocker）
`dom.ts` 的 observer 只看 `childList/characterData`，版本计数与「已安装」标志挂在 `window`。页面脚本把 `data-dsh-decision-id` 从「已批准的元素」搬到攻击者元素，新鲜度检查照旧通过，点击落到攻击者控件（PoC 实测点了 `Delete everything`）。
**修复**：provider 侧记录 version；observer 观察 attributes 并每次重挂（`bootstrapId` 去重）；**派发不再按属性重解析**——快照时用 `evaluateHandle` 绑定活节点，`handle.click/fill` 直接作用在该节点上；token + 唯一性校验兜底。页面搬 id 只能让校验失败，不能改派发目标。

### 3.2 CR-01 / BR-03 / NR-01 Skill 回放零审批（high）
动态路径有后果性/登录两道 gate，回放路径**一个都没有**；且 `skill.risk` 覆盖调用方更严格的策略（`read_only` 被静默放宽）。一次批准发布的 Skill 于是成为永久免审批的高权限宏。
**修复**：两个 runner 每步复用同一对 gate（审批在 `admit()` 之后、输入之前），缺失审批通道即 `confirmation_required` + 零动作；`risk` 取 `max(caller, skill, config.minRisk)`；`read_only` Skill 带变更步骤直接拒回放。

### 3.3 CR-04 模型给自己预授权（high）
`policy.allowConsequential` / `allowLogin` 是**工具参数**，描述原文写着 "pre-authorizes consequential actions"，于是「外部审批」在实现上是模型自填的一个 JSON 字段。
**修复**：工具面 schema 只剩 `risk` + `credentialsAvailable`（只能收紧）；预授权改为 provider 配置（`minRisk` / `preauthorizeConsequential` / `preauthorizeLogin`），模型不可达。凭据判定同时扩展到卡号/CVV/OTP/验证码与表单语义（邮箱优先登录页不再绕过）。

### 3.4 BR-04/05/06、NR-04 验证器假阳性（high）
`text_visible` 是全文子串（"Not saved" 满足 "Saved"），`input_value`/`checkbox` 会被隐藏诱饵 input 满足，`url_contains` 是裸 `includes`；原生侧 `url_contains` 恒真，同名/0×0 元素也能满足。
**修复**：浏览器侧改为「规范化空白 + 精确 + 可见 + 恰好一处」，label 必须唯一可见启用，URL 按 origin/path 段边界匹配；原生侧重写 AX 解析与可见性（hidden/offscreen/0×0/出窗全不成立，容器 description 不计），证据绑定 windowId + index/identifier + bounds。

### 3.5 SR-01 / SR-02 发布链路能发空包（high）
`dist/` 被 gitignore 且没有 `prepublishOnly`，干净 clone 打包只有 2 个文件；发布脚本的内部依赖门用 `@dsh-cu/` 前缀（改名后永不命中），缺 core 也照发。
**修复**：`scripts/verify-dist.mts`（main/types/exports 目标存在、`dist/index.js` 在 tarball 里、文件数 > 2），5 个包接 `prepublishOnly`，发布脚本内联同一道门；依赖门改为匹配真实 workspace 包名。

## 4. 全量发现与处置

状态：✅已修并带回归测试　◐部分修复（见备注）　⏸接受风险/后续（§6 给理由）

### 4.1 浏览器（redteam/findings/browser.md）

| ID | 级别 | 标题 | 状态 |
|---|---|---|---|
| BR-01 | blocker | 快照新鲜度由页面保管（搬 id / 预置 observer 冻结版本） | ✅ |
| BR-02 | high | 后果性动作无分类，risk 默认 reversible | ◐ 模型不再能自我预授权；分类仍由调用方声明，operator 可用 `minRisk=consequential` 收紧 |
| BR-03 | high | Skill 回放无审批分支，URL 命中即自动回放 | ✅ |
| BR-04 | high | text_visible 全文子串 → 假阳性 | ✅ |
| BR-05 | high | 隐藏诱饵 input 满足 input_value/checkbox | ✅ |
| BR-06 | medium | url_contains 裸 includes（evil-example.com 命中 example.com） | ✅ |
| BR-07 | high | 凭据闸门只认 `type=password` | ✅ |
| BR-08 | medium | 登录闸门是按钮文案正则 | ✅ |
| BR-09 | high | 上传审批与写入元素 TOCTOU + symlink | ✅ |
| BR-10 | medium | 导航无目的地策略，302 可到元数据地址 | ✅（169.254/16、100.100.100.200、fd00:ec2::254、fe80::/10、metadata.* 全拦；loopback 保留） |
| BR-11 | low | 空名字控件跳过歧义闸门 | ⏸ |
| BR-12 | medium | 审批弹窗的目标/范围由页面撰写 | ⏸ |
| BR-13 | low | 下载无审批、旧文件冒充本次结果 | ✅ |
| BR-14 | medium | 快照 id 从不清除，滚动后同 id 指向两个节点 | ✅ |
| BR-15 | low | 发布审批只显示计数 | ✅（列出步骤目标 + 断言文本 + risk 下限） |
| BR-16 | high | observe/extract 回传活密钥（密码框、隐藏 CSRF） | ✅（默认 `[redacted]`/`•••`，仅 config 或逐字段一次性审批放行） |

### 4.2 核心（redteam/findings/core.md）

| ID | 级别 | 标题 | 状态 |
|---|---|---|---|
| CR-01 | high | 回放零审批 + risk 覆盖 | ✅ |
| CR-02 | high | 证据链自证（`independent` 字面量、`approvedBy` 字符串比较） | ✅（store 铸造 nonce：`beginVerification`/`finishVerification`/`mintPublishNonce`） |
| CR-03 | high | 跨 provider 作用域回放 | ✅（`assertSkillProvider`，选择阶段即拒） |
| CR-04 | high | 模型自我预授权 | ✅ |
| CR-05 | medium | 审计脱敏绕过（`access_token=`、全角冒号、分隔符） | ✅ |
| CR-06 | medium | 审计链一次失败永久毒化；`resume` 可撤销用户 stop | ✅ |
| CR-07 | medium | 控制面：页面无鉴权顺序、无 Host 校验、特权变更不入审计、500 回显、超限断连 | ✅（另加常量时间比较、pageToken TTL、`/` 壳放行但含零数据） |
| CR-08 | medium | 存储全有或全无、跨实例丢写、`reject` 改写已发布版本 | ✅ |
| CR-09 | medium | 未 capture 的值明文落盘、合并断言不受 max(12)、PASTE 轨迹不可捕获 | ◐（合并上限与占位符强制已修；PASTE 捕获策略保留） |
| CR-11 | low | 审批应答无形状校验 | ✅ |

### 4.3 原生（redteam/findings/native.md）

| ID | 级别 | 标题 | 状态 |
|---|---|---|---|
| NR-01 | high | Skill 作用域=被控应用自写标题 + 回放零审批 | ✅（回放审批）+ ⏸（标题撞名，见 §6） |
| NR-02 | high | 指示器无声消失且不收回输入 | ✅（`unavailable` 事件 → `controller.stop('indicator_unavailable')`，`activity()` fail closed，targetBounds 清空） |
| NR-03 | high | 三套坐标 + 旧窗口矩形 | ✅（单一 AX point；派发前 `readLiveWindow` 重读；帧变化则结构化失败） |
| NR-04 | high | 验证假阳性 | ✅ |
| NR-05 | high | custom 断言注册表后写覆盖 | ✅（构造期冻结，删除模块级可变 Map） |
| NR-06 | medium | helper 缓存可预测路径/存在即执行 | ⏸ |
| NR-07 | high（流程） | 基线 7 红：硬编码 `/tmp` helper、无确定性 skip、`NATIVE_IO` 裸抛 | ✅（三级解析 + 能力探针 skip + 结构化 reason；本机真跑真 helper） |
| NR-08 | medium | 一行非 JSON stdout 崩宿主、helper 掉线杀 run、编译失败静默 Noop | ✅ |
| NR-09 | medium | 权限状态读临时 helper 的 TCC 身份 | ✅（三态 granted/denied/unknown，宿主不下断言） |
| NR-10 | low/med | `hasPendingState` 文本启发式可被 "Waiting…" 拖住 | ✅（只看结构信号 + 1500ms 上限） |
| NR-11 | med | 控制台无租约、pageToken 进工具返回 | ◐（pageToken TTL + Host/鉴权收紧；租约本身未做） |

### 4.4 供应链（redteam/findings/supply.md）

| ID | 级别 | 标题 | 状态 |
|---|---|---|---|
| SR-01 | high | 发布无构建门（空包 2 文件） | ✅ |
| SR-02 | high | 发布依赖门死代码（前缀不匹配） | ✅ |
| SR-03 | high | doctor 假绿：未装包仍 PASS | ✅ |
| SR-04 | high | doctor 假绿：重复 id 被覆盖仍 PASS | ✅ |
| SR-05 | high | `--profile=../../x` 路径穿越写任意 package.json | ✅（白名单 + realpath 围栏） |
| SR-06 | medium | 安装失败不回滚、`.bak` 无界增长 | ✅ |
| SR-07 | medium | 评测判据只有格式/子串，无行为对照 | ⏸ |
| SR-08 | medium | `check(..., true)` 硬编码 PASS、每次覆盖 tracked results | ✅ |
| SR-09 | medium | server.py 图像炸弹、无超时、logger 恒 None | ✅ |
| SR-10 | medium | bundle 固化公开默认 token | ◐（doctor 检测即 FAIL；默认值仍在 patch 里） |
| SR-11 | low | NPM_TOKEN 临时文件残留 | ✅ |
| SR-12 | low | 文档与实现偏差 | ✅ |

## 5. 验收

```
$ bash redteam/verify.sh
== build ==            build: PASS
dsh-cu-core: PASS       Tests  99 passed (99)
dsh-browser-use-d1: PASS Tests 126 passed (126)
dsh-computer-use-d1: PASS Tests  69 passed | 1 skipped (70)
dsh-cu-client: PASS     Tests   6 passed (6)
dsh-cu-bundle: PASS     Tests  28 passed (28)
== python tests ==      pytest: PASS 49 passed
== result: GREEN ==
```

唯一 skip：`tests/visual.spec.ts` 一例——能力探针证明字段点击与键入落地，但该会话中合成的按钮点击被 fixture 忽略，带测得 detail 跳过（换到窗口交互正常的会话不 skip）。基线曾是 7 failed。

红队 PoC 复跑（对修复后的代码）：

```
npx vitest run --config redteam/poc/browser/vitest.config.ts br01   → 3/3 「攻击成立」断言转红
npx vitest run --config redteam/poc/browser/vitest.config.ts br03   → 2/3 转红（剩 1 条是 D1 对照组）
... br09 2/2、br16 3/3 转红
core cr01 4/4 转红
```

注意解释口径：红队 PoC 断言的是「攻击成立」，修复后它们**失败**才是正确结果。少数 PoC 仍绿，是因为它们断言的是**内部函数**行为（如 `needsConsequentialApproval({allowConsequential:true})===false`），该行为在 core 内部仍成立，但模型已无法从工具面设置它；这类差异在 §6 逐条说明，不当作「未修复」。

## 6. 部分修复与接受风险（8 条，带理由）

| ID | 为什么这轮不修 |
|---|---|
| BR-02 | 「什么算后果性」需要领域分类，代码无法从页面可靠推断。已消除「模型自我授予」，把最终权限交给 operator 的 `minRisk`。默认 `reversible` 是产品选择，不是漏洞——需要强约束的部署应设 `minRisk=consequential`。 |
| BR-11 | 空名字控件的歧义（图标按钮）会在修复后把大量真实页面判为 ambiguous，收益低。兜底是执行前 token 绑定 + 审批提示里的 target 退化为 id。 |
| BR-12 | 审批提示里的元素名/标题本质是页面内容。已让提示只作为「页面自述」呈现，并把 operation/scope 由 provider 填；真正的护栏是 page origin + risk 下限。 |
| CR-09 | PASTE_TEXT 轨迹不可捕获是刻意的保守策略（粘贴内容常是密钥），改动它需要单独的脱敏设计。 |
| NR-01（标题撞名） | 要求 native Skill 必须声明 `appBundleId` 会拒绝内置 fixture，并让现有 Skill 全部失效；需要一次带迁移的版本。当前缓解：回放每步用**实时**窗口标题 + 应用身份重校验。 |
| NR-06 | helper 缓存路径可预测属于同用户威胁模型（跨用户被 `/var/folders` 0700 挡住）；改动涉及编译缓存协议，收益低于风险。 |
| NR-11 | 控制台租约（断连即撤销）需要客户端心跳协议；本轮已加 pageToken TTL、Host 校验、常量时间比较、`/` 壳零数据。 |
| SR-07 | 评测判据改成行为 judge 需要先定义 transcript 契约；这是独立工作量，不是补丁。 |
| SR-10 | 删除默认 token 会让未设 env 的用户插件直接加载失败（需要安装期生成随机 token 的迁移）。当前 doctor 把它判 FAIL，错误可见。 |

## 7. 复跑方式

```bash
# 全量验收（build + 5 个 workspace + pytest）
bash redteam/verify.sh

# 红队证据（攻击断言，修复后应大量失败）
npx vitest run --config redteam/poc/browser/vitest.config.ts
npx vitest run --config redteam/poc/core/vitest.config.ts
bash redteam/poc/supply/poc-05-publish-empty-tarball.sh
bash redteam/poc/native/baseline.sh

# 单点复核
npx vitest run --config redteam/poc/browser/vitest.config.ts br01
```

## 8. 变更面

- 63 个文件修改、+4514/−747；新增 22 个测试文件（分布在各包 `tests/`）。
- 关键新增：`scripts/verify-dist.mts`、`packages/dsh-cu-core/src/policy.ts`（模型面/内部 policy 拆分）、`packages/dsh-cu-core/tests/{control-hardening,evidence,audit-redaction,policy-v2}.spec.ts`、浏览器 `{hardening,upload-hardening,extract-sensitive,downloads-approval,skill-approval-gates,skill-approval-e2e,publish-detail}.spec.ts`、原生 `{coordinates,verification,indicator-lease,skill-approval,pending-state}.spec.ts`。
- 契约变更（对外可见）：`policy` 工具参数只剩 `risk`/`credentialsAvailable`；extract 敏感字段默认 `[redacted]`（`ok:true` + `reason:"sensitive_redacted"`，新增 `redacted[]`）；未审批的下载不落盘；`upload` 返回绝对路径。`SKILL.md` 已同步（新增规则 6，修订 5/8/10）。
- 未做：git commit/push（按要求）。`redteam/` 为未跟踪目录，报告与 PoC 保留原样作为证据。
