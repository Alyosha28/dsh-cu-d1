# 原生执行层与客户端对抗审计 — NR-01 … NR-11

审计对象：`packages/dsh-computer-use-d1/src/{controller,verification,permissions,skill-runner,indicator,index,config}.ts`、
`packages/dsh-computer-use-d1/native/*.swift`、`packages/dsh-cu-client/**`、
`packages/dsh-browser-use-d1/src/{preview,indicator,takeover}.ts` 的原生/窗口/光标相关部分。
对照：`ARCHITECTURE_PLAN.md` §5.4、§6（6.1–6.3）、§8；`SKILL.md` 硬规则 9、1、4、5。
基线：`f3fa83a`（工作区干净），macOS 26.0 arm64，node v24.20.0，Swift 6.4，GUI 会话存在。

本机环境（实测，脚本复现）：

```
accessibility=false  screenRecording=true  guiSession=true
swiftc=/usr/bin/swiftc   node=v24.20.0
```

所有 PoC 都是**只读产品代码**的独立 spec，位于 `redteam/poc/native/`，运行方式：

```bash
cd redteam/poc/native && ../../../node_modules/.bin/vitest run --config vitest.config.ts
bash redteam/poc/native/baseline.sh          # NR-07 基线复现
```

结果：`Test Files 7 passed (7) / Tests 26 passed (26)`，`out/` 下保存了基线日志。

---

## NR-01 ｜ HIGH ｜ 原生 Skill 的作用域是被控应用自己写的字符串，回放路径没有任何审批

**证据**

- `packages/dsh-computer-use-d1/src/skill-runner.ts:28` — `assertSkillScope(skill, { windowTitle: selected.title, appBundleId })`，之后整个循环（`:44-191`）**没有导入、也没有调用任何审批网关**。
- `packages/dsh-cu-core/src/skills.ts:245-259` — `assertSkillScope` 只做两次字符串相等：`match.windowTitle === scope.windowTitle`、`match.appBundleId === scope.appBundleId`（后者仅在 skill 里存在时才比较）。不比较 pid、windowId、可执行路径、进程启动时间，也没有对 skill 记录的签名。
- `packages/dsh-cu-core/src/skills.ts:90-104` — 内置 fixture `fixture.native-csv-import` 的 `match` 只有 `{ windowTitle: 'DSH Workflow Fixture' }`，且 `:278-285` 的 `selectSkill` 无论如何都把 `fixtureSkills` 拼进候选列表，所以它永远可按 `skillId` 直接选中（`:281-284`）。
- `packages/dsh-cu-core/src/skills.ts:33-46` — `match.windowTitle` 允许空串（`z.string().optional()`），空串计数为「正好一个定位符」，因此 `{ windowTitle: '' }` 是合法作用域。
- `controller.ts:331` — `state.windowTitle = selected.title ?? ''`；无标题窗口捕获出来就是 `windowTitle: ''`。
- `controller.ts:508-543` 是 d1 路径的单次动作审批；skill 路径（`skill-runner.ts`）完全没有对应代码。
- `controller.ts:692-695` → `skill-builder.ts:125` — 候选 skill 的 `risk` 直接采用**模型自己写的** `args.policy?.risk`。

**攻击步骤**

1. 任意应用把窗口标题设成 `DSH Workflow Fixture`（或本来就是无标题窗口 → `''`），并渲染 `Report path` / `Import report` 同名控件。
2. 调用 `computer_subgoal({ app: "<该应用 pid>", skillId: "fixture.native-csv-import", inputs: {...}, verify: [...] })`。
3. `assertSkillScope` 通过（标题相等，或双方都是 `''`），`runNativeSkill` 用 `decisionForSkillStep` 按**元素名字**匹配，把 Skill 的输入与点击打进去。
4. 整个回放零模型调用、零审批。

**影响**

- Skill 的作用域等于「目标应用能显示的任意文本」，跨进程 / 跨应用可复现；窗口标题撞名（`Untitled`、`Settings`、`Document`、产品名）即命中。
- 捕获时由模型决定 risk 类，审批卡片上显示的 `Risk:` 就是模型填的值（`index.ts:161-172`，`Risk:` 在 `:166`），审批语义被降级。
- 只要一次 d1 动作被用户点过「允许」，之后任何同名窗口回放都**不再请求审批**——审批在时间上被洗白，直接违反 §8「后果性动作与凭据提交在动作选定后按单次动作请求批准」与 SKILL.md 规则 5。

**复现**

`redteam/poc/native/nr01-skill-scope-approval.spec.ts`（5 条断言全绿）：

```
✓ ships a built-in Skill that is always selectable and scoped by window title alone
✓ replays into another application that only copied the window title      ← appBundleId 'com.attacker.clone'
✓ treats an empty window title as a wildcard for every untitled window
✓ dispatches a consequential secret entry with no approval prompt          ← risk=consequential, paste+click 均派发
✓ derives the replayed Skill risk from the model-supplied capture policy   ← candidate.risk === 'read_only'
```

**修复方向**（只描述，不写代码）

- 作用域必须绑定**稳定身份**：`bundleId + TeamID/codesign 校验`、windowId 与 AX 位置指纹、可执行路径 hash；禁止 `windowTitle` 单独定位，禁止空串。
- Skill 记录需要签名或至少由 store 在写入时附带不可篡改的 `captureContext`（pid/路径/元素指纹），回放前重算并比对。
- 回放路径必须走与 d1 相同的 `actionApprovalContext` + `requestConsequentialApproval`，且 risk 取「捕获时**用户批准**的等级」与「当前策略上限」的**高**者，而不是模型给的字符串。

**回归测试建议**

- 断言 `windowTitle: ''` 的 skill 不能匹配任何窗口；标题撞名但 bundleId/路径不同的窗口必须 `skill_window_mismatch`。
- 断言 skill 回放的每一步在 `risk==='consequential'` 时都产生一次审批请求，拒绝则 0 动作。

---

## NR-02 ｜ HIGH ｜ 指示器可以在任何人不被告知的情况下消失，输入权限不收回

**证据**

- `native/ControlIndicator.swift:335-361` — `refreshWindow()` 在窗口消失、owner pid 变化、或 `kCGWindowIsOnscreen != true`（最小化、切到别的 Space）时执行 `cursorPanel.orderOut(nil)` / `statusPanel.orderOut(nil)` 并 `targetOnscreen = false`，**不发任何事件**。
- `native/ControlIndicator.swift:210-217` — 面板「关闭」→ `finish()` 后 `return`，同样**不发事件**；而 `emit(["type":"control", …])` 只在非 dismiss 分支。
- `src/indicator.ts:122-141` — Node 侧只处理 `control` / `expired` 两种事件；没有「指示器已不可见」这一状态。
- `src/indicator.ts:193-205` — `activity()` 只检查 `this.runId`，因此指示器已经消失时它**照常返回成功**。
- `native/ControlIndicator.swift:372-388` — `detectTakeover` 用 `targetBounds` 继续做判断，`refreshWindow` 失败分支**不清空** `targetBounds`，因此窗口关闭后仍在拿旧矩形判断用户点击。

**攻击步骤 / 复现路径**

> 注意区分两条路径：运行中面板的「关闭」按钮是隐藏的（`ControlIndicator.swift:245` 的 `closeButton.isHidden = true`，只在 `:292` 的持久结束态才显示），所以用户在 run 期间点不到它；**真正可触达的是 `refreshWindow` 的静默 `orderOut`**。`dismiss` 之所以仍然重要，是因为它证明 Node 侧根本不观察「helper 已无 run」这一状态（协议里没有任何事件表达它）。

1. 运行中的 `computer_subgoal` 让用户「最小化一次目标窗口」（或应用自己关窗/崩溃/切 Space）——完全正常的人类行为。
2. 光标与状态面板被 `orderOut`，`runId` 保持不变；Node 侧收到零事件。
3. 后续 `executeNative` 的 `activity({phase:'acting'})` 成功写入（`indicator.ts:166-170` 只检查 stdin 可写），动作继续派发。
4. PoC 用协议对端确定性复现同一状态机空洞：`dismiss` 后 helper 的 runId 已清空，Node 仍接受 activity：

```
redteam/poc/native/nr02-indicator-lifecycle.spec.ts
✓ keeps the run alive after the indicator is dismissed        ← helper runId=null，activity() 仍 resolves
✓ reports no error when finish races a dismissed indicator
```

**影响**

- §5.4「模型与 Skill 均不能隐藏或伪造指示状态」「完成、停止、失败、接管、客户端退出及心跳丢失均撤销输入权限并清除光标」被绕开：只要窗口进入不可见状态，屏幕上的「正在被控制」证据消失，而控制继续。
- 与 NR-03 叠加：此时点击坐标仍按旧窗口矩形换算，用户以为自己已把窗口挪开，实际点击落到别的窗口。
- 用户失去唯一的就地停止入口（面板不见了），只能靠工具/控制台。

**修复方向**

- 指示器必须是 run 的**租约**：`#shouldBeVisible()==false` 时立刻发 `control{takeover|stop}` 或 `unavailable`，Node 侧据此 abort run；`activity()` 在 `child` 未确认 `visible` 时应失败而不是成功。
- 面板不可见期间禁止派发任何输入（fail-closed），而不是只把窗口 `orderOut`。
- `targetBounds` 失效时必须置空，避免用旧矩形做接管判定。

**回归测试建议**

- 用协议对端驱动 `refreshWindow` 失败的等价命令，断言 Node 在 N 毫秒内停止 run。
- 断言「窗口 offscreen 期间不派发 click/type」「`finish` 之后 activity 必抛错」。

---

## NR-03 ｜ HIGH ｜ 软件光标、点击、滚动用了三套坐标；窗口移动后按旧矩形换算

**证据**

- `controller.ts:650-658` `visualPoint()` — `coordinateSpace === 'screenshot-pixels'` 时用 `pixelWidth/pixelHeight` 计算**像素**坐标。
- `controller.ts:770-793` — 视觉点击把像素坐标直接作为 `click{x,y}` 下发；`dsh-cua` 的 `CuaCoordinates.parameters`（`node_modules/@deepseek-ai/dsh-cua/lib/index.js:856-866`）把**像素**换算成**窗口 point**（`value * frame.width / pixels`）。
- `controller.ts:710-720` `nativeActivityPoint()` — 光标点 = `windowBounds.x + 像素x`，即**没有**做同一换算：2x 屏上光标画在 2 倍偏移处。
- `controller.ts:660-668` `nativeElementPoint()` — 用 `bounds - window.x` 求窗口内坐标，而 `window` 来自 `observation.windowBounds`，该值由 `controller.ts:405` 的 `observationFromState(nativeState, selected)` 传入的 **`selected`（首次 `listWindows` 的结果，`controller.ts:306-330`）**，全程不刷新。
- `controller.ts:784-789` — 元素粘贴路径把点先归一化成 0–999 再 `relative: true`（第三套坐标，且量化到 1/999）。
- `controller.ts:759-768` — 滚动却用 `bounds` 的**绝对屏幕**坐标 + `windowId`。

**攻击步骤 / PoC 输出**

```
redteam/poc/native/nr03-native-geometry.spec.ts
✓ draws the software cursor in screenshot pixels instead of window points
    dispatch: click{x:800, y:600} (px)  → provider: 400,300 pt → 真屏幕 (500,400)
    cursor point: (900,700)             ← 光标偏移 400 pt
✓ clicks from a stale window rectangle when the window moved mid-run
    元素真实中心 x=550，派发 click{562/1000*800, relative:true} → 落点 x≈949.6，偏差 399.6 pt
✓ mixes three coordinate conventions in one action table
    scroll{x:340,y:330} 绝对屏幕坐标，与上面两套都不同
```

**影响**

- 用户看到的「软件光标」与实际点击点是两个位置；这条指示器正是 §5.4 用来证明「代理点了哪里」的唯一证据。
- 窗口被移动/缩放/换显示器后，AX 元素点击继续按旧原点换算：轻则点到隔壁控件，重则点到别的应用（坐标是全局的，`click` 不校验目标窗口是否仍在最前）。
- 999 档量化在 3000pt 宽窗口上带来 ~3pt 误差，双击/小目标场景可落到边缘。

**修复方向**

- 单一坐标契约：控制器只产出「窗口内 point」，或只产出「截图像素」并由一层换算；光标、click、scroll 共用同一函数，且必须与 provider 的换算同源（读 `coordinateSpace` 后决定）。
- `observation.windowBounds` 必须每次 `getState` 时从**同一份** state 里的 window 取，不能用首次 `listWindows` 的对象；窗口几何变化时 raise `WINDOW_CHANGED` 并作废旧快照。
- 光标点应记录「即将执行的 native 参数」，而不是重新推导一次。

**回归测试建议**

- 2x 屏（1x/2x 各一组）断言 `cursorPoint === clickPoint × scale + origin`。
- 模拟 `getState` 前后窗口 x 变化，断言派发前出现 `WINDOW_CHANGED`（或坐标按新矩形换算）。
- 断言三套坐标在适配器层只有一个出口（同一函数被 click/scroll/paste/cursor 复用）。

---

## NR-04 ｜ HIGH ｜ 原生验证接受「不是证据」的证据：0×0 元素、description 文本、任意同名元素满足 checkbox=false

**证据**

- `controller.ts:223-249` `verifyNative()`：
  - `:237-239` `input_value` — 只要**任一**元素 `name|identifier` 等于 label 且 `value` 相等就算过；不检查 `bounds`、不检查可见性、不检查唯一性。
  - `:240-242` `checkbox` — `[true,1,'1','true','checked'].includes(element.selected ?? element.value ?? '') === assertion.checked`；`parseAxElements`（`:154-181`）**从不解析** `selected` 标记，于是 `checked:false` 退化成一个恒真式：任何同名、无 value 的元素都算「未勾选」。
- `controller.ts:154-181` `parseAxElements` — 解析 `bounds=[…]` 但从不据此过滤；`:183-197` `visibleAxText` 把**所有行**的 `title/value/description/placeholder/help` 都算作「可见文本」，包括 `bounds=[0,0,0,0]`。
- `controller.ts:236` `url_contains` — 原生下比较的是自造的 `app://<pid>/<windowId>`，可被 `app://` 之类前缀无条件满足。

**PoC 输出**

```
redteam/poc/native/nr04-verification-fake-positive.spec.ts  (5/5 绿)
✓ accepts input_value from a zero-size, offscreen duplicate field
    可见字段值是 /tmp/wrong.csv，0×0 的重复字段是 /tmp/report.csv → 验证通过
✓ accepts text_visible from an invisible element description
    AXStaticText description="Import complete" bounds=[0,0,0,0] → 验证通过
✓ accepts checkbox checked=false for any element with a matching label and no value
    根本不存在 checkbox，AXStaticText "Remember me" 即可满足「未勾选」
✓ ignores the tree selected marker, so checkbox checked=true cannot pass
✓ accepts a vacuous url_contains assertion without reading application state
```

**影响**

- 直接违反 §6.3「证据不足均失败关闭」「验证器自身必须具有防假阳性回归测试，包括忽略元素编号、内部标识和不可见元数据」。当前实现恰好**依赖**标识并在**不可见元数据**上判定。
- 被控应用可以低成本伪造成功：渲染一个 0×0 或折叠的重复表单、把期望文本塞进 `description`/`help`、复用同名静态文本，就能让 `status: success, reason: independently_verified` 带着 `actionsExecuted: 0` 落地。
- Skill 的持久后置条件也走这条路径，所以假阳性会被固化进已验证 Skill。

**修复方向**

- 断言求值前先做证据过滤：只接受 `enabled`、`bounds` 面积 > 0、且落在窗口可见矩形内（必要时再与截图做一次像素级交叉验证）的元素；label 匹配只允许 `name`（AXTitle/AXDescription/AXPlaceholder），不允许 `identifier`。
- `checkbox` 必须读真正的布尔源（`AXValue` 的 CFBoolean / `selected` 标记），无布尔源即失败关闭；`checked:false` 不能由「无值」推出。
- `input_value` 在存在多份同名候选时必须失败（歧义即失败），不能「任一匹配」。
- 原生 `url_contains` 应直接拒绝（未知断言类型 → 失败关闭），或改为「应用身份 + 窗口身份」的严格断言。

**回归测试建议**

- 把 `nr04-*.spec.ts` 的 5 个用例加入产品测试：0×0、description-only、无 checkbox、`selected` 标记、空断言。
- 增加「同一 label 两个不同 value → 必须 false」与「窗口外元素 → 必须 false」。

---

## NR-05 ｜ HIGH ｜ `custom` 断言是进程级、后写覆盖的注册表，证据路径由调用方给

**证据**

- `src/verification.ts:11-24` — 单个模块级 `Map`，`registerNativeVerification` 直接 `registry.set`（无重复拒绝、无作用域、无 owner）。
- `controller.ts:230-234` — `runNativeVerification(assertion.name, assertion.args ?? {}, {caller, params, signal})`：`name` 与 `args` 全部来自工具参数（或持久化在 Skill 里），并且把 `caller`（可派发原生输入）交出去。
- `tests/visual.spec.ts:56-58`（断言在 `:96` 给出 `args.statePath`）就是这种形态的官方示例：handler 读 `args.statePath` 指向的文件。

**PoC 输出**

```
redteam/poc/native/nr05-verification-registry.spec.ts  (4/4 绿)
✓ silently replaces an existing handler when a second plugin claims the name   ← 先 true，再注册即变 false，无任何告警
✓ accepts evidence from a file the caller names while the application shows failure
    应用 AX 树显示 "Import failed"，验证因调用方指定 statePath 而通过
✓ lets a verifier dispatch native input while it verifies                       ← 验证期间派发 click
✓ fails closed for an unknown handler name                                      （这条是边界，见 B3）
```

**影响**

- 「独立验证」的可信度取决于最后一个注册者：同进程任意插件（包括第三方 DSH 插件）都能静默改写一个已被用户批准过的断言名。
- 证据来源可被模型指定（任意文件路径），等于把「读哪个文件算通过」交给被约束方；配合 NR-01 的捕获逻辑，假证据会被写进 Skill 的后置条件。
- 验证器可以产生副作用（点击），而它运行在「只是读一下状态」的语义里，审计记录不到。

**修复方向**

- 注册表按 provider/plugin 命名空间隔离，重名注册直接抛错；handler 由配置显式绑定，不由断言字符串寻址。
- `custom` 断言只允许读 provider 自己采集的状态（由 provider 提供稳定 id），禁止把调用方给的任意路径/命令作为证据源。
- 验证上下文只暴露只读的 `read`，不提供 `call`。

**回归测试建议**

- 重名注册必须失败；未知 name 必须失败（已满足）；断言 `custom` handler 无法访问可写原生方法。

---

## NR-06 ｜ MEDIUM ｜ 原生 helper 缓存是可预测路径，存在即可执行，无属主/签名/编译器校验

**证据**

- `packages/dsh-cu-core/src/helper-cache.ts:44-48` — 目录名 = `join(tmpdir(),'dsh-cu-helper-cache', name-<8位hex>)`，`if (await executable(binary)) return binary`：**只要该路径可执行就直接用**。
- `:17-24` — key = `fnv1a(compiler + platform + arch + 每个源文件的 "路径:长度:fnv1a(内容)")`，32 位、无编译器版本、无签名/属主/inode。
- `:50-51` — `mkdir(cacheRoot, { mode: 0o700 })` 对**已存在**的目录不生效（`recursive: true` 不改 mode）。
- 调用者是 `permissions.ts:29-35`（PermissionPrompt）与 `indicator.ts:85-95`（ControlIndicator）——两者都在审批网关之外运行。

**PoC 输出**

```
redteam/poc/native/nr06-helper-cache.spec.ts  (3/3 绿)
✓ executes a planted binary instead of compiling the source   ← 源码 print("real helper")，实际执行 PLANTED-HELPER
✓ does not fix the permissions of a cache root that already exists  ← 预置 0777 的 cacheRoot 保持 0777
✓ keys the cache on compiler name and source length, never on compiler identity
```

**影响**

- 同用户的任意进程（一次工具调用、一个 npm postinstall、任何已安装应用）可以先占用该路径，之后 DSH 会执行它——且这两个 helper 恰好是「申请辅助功能权限」和「显示控制面板」的进程，天然运行在用户已授权的 TCC 身份下。
- 32 位 key + 只含编译器**名字**：Xcode 升级、编译器替换都不会让旧二进制失效；理论上可用生日碰撞让两个不同源命中同一目录。

**边界（诚实降级）**：macOS 的 `tmpdir()` 是 `/var/folders/<xx>/…/T`（本机 `drwx------`，属主本人），**跨用户不可写**；因此定级 medium 而非 high。

**修复方向**

- 缓存放进应用私有目录（`~/Library/Application Support/<app>/helpers`，0700 且属主校验），不用 `tmpdir()`。
- 命中缓存前校验：文件属主 == 当前 uid、非 group/other 可写、构建产物附带内容摘要清单并比对。
- key 纳入编译器版本与 `--version` 输出；写入用 `mkdtemp` + `rename` 并在同一步完成 `chmod`。

**回归测试建议**

- 预置同名二进制后编译必须重新编译或拒绝；预置 0777 cacheRoot 必须被拒绝；改变编译器版本必须换 key。

---

## NR-07 ｜ HIGH（流程/可观测性）｜ 基线 7 红 = 环境缺失，但失败被伪装成代码缺陷，且无确定性跳过

**结论（证据充分）**

根因是**两层环境依赖**，不是产品逻辑缺陷：

1. **helper 二进制不存在**。`tests/fixtures.ts:9` 把 helper 硬编码成仓库外路径
   `/tmp/dsh-official-alpha2/packages/experimental/cua-macos/native/.build/release/dsh-cua-native`，本机不存在；9 个 spec 都通过 `helperPath: HELPER` 注入（`provider.spec.ts:75/115/157/196/247`、`multiwindow.spec.ts:70`、`visual.spec.ts:83`、`approval.spec.ts:76`、`composition.spec.ts:32`）。
2. **本机没有辅助功能授权**：`AXIsProcessTrusted() == false`（screenRecording=true）。即使 helper 就位，任何真实原生输入都会被拒绝。

**可复现命令与真实输出**（`bash redteam/poc/native/baseline.sh`，日志在 `redteam/poc/native/out/`）

```
===== 1. host permissions =====
accessibility=false screenRecording=true guiSession=true

===== 2. hard-coded helper path =====
ls: /tmp/dsh-official-alpha2/.../dsh-cua-native: No such file or directory

===== 3. baseline test run =====
Tests  7 failed | 20 passed (27)
  × visual.spec.ts   uses a screenshot box for native input when AX is unavailable
  × multiwindow.spec.ts requires an explicit window before allowing native input
  × provider.spec.ts ×5
  Error: NATIVE_IO: Writing a helper request failed
```

**负向对照（关键证据）**：用 `swift build` 从 `node_modules/@deepseek-ai/dsh-experimental-cua-macos/native`
离线编译出真 helper（28.6s，无远程依赖），软链到硬编码路径后重跑同样两个 spec：

```
===== 4. negative control: helper present, Accessibility not granted =====
Tests  2 failed (2)
  multiwindow: reason "window_selection_required" → "accessibility_permission_required"
  visual:      status "success" → "escalated"
```

即：helper 一旦存在，失败原因立刻变成**权限**而非传输错误。两个因子互相独立，都必须处理。

**错误为何会伪装成代码缺陷（真实缺陷部分）**

- `node_modules/@deepseek-ai/dsh-cua/lib/native-client.js:154-157` — 真正的 `realpath ENOENT` 在 channel 启动时被吞掉，等到 `stdin.write` 回调失败才以
  `NATIVE_IO: Writing a helper request failed` 冒出；helper 不存在与「helper 跑到一半 I/O 故障」不可区分。
- `src/index.ts:174-194` `failureContent()` 只映射 `PERMISSION_DENIED / SESSION_LOCKED / STALE_APP / STALE_SNAPSHOT`，对 `NATIVE_IO` 返回 `null` → 工具直接 throw 原始错误，模型拿不到稳定 reason 与恢复指引（违反 `GUIDANCE` 里「stable reason code + recovery」的承诺）。
- 断言层面也误导：`multiwindow.spec.ts:87` 用 `expect(ambiguous.isError).toBe(false)` 而不打印 content，失败信息只有 `expected true to be false`，看不出是 helper 缺失。

**关于来件提到的 `expected 2071 to be 22427`**

该断言在本次 HEAD（`f3fa83a`）上**不存在**：`grep -rn "22427\|2071" packages/*/tests/` 无命中，
本机 3 次完整运行（含负向对照）都只出现 7 条失败、错误面为 `NATIVE_IO: Writing a helper request failed`
与 `expected true to be false`。测试里与像素相关的唯一显式数值断言是 `tests/controller.spec.ts:134`
的 `pixelWidth: 500, pixelHeight: 400`（纯构造数据）。推测该条来自更早的修订或其他分支；若蓝队复现到，
请提供 `git rev-parse HEAD` 与 spec 名，我再补一条坐标/像素换算的专项用例（与 NR-03 同源）。

**进程生命周期 / 泄漏结论**

- 7 次失败都发生在 `runComputerSubgoalInner` 的第一个原生调用 `getCapabilities`（`controller.ts:283`）：CUA helper 从未 spawn（`realpath` 在 spawn 之前就失败），指示器 helper 只被编译、未 spawn（`indicator.start` 在权限检查之后）；`baseline.sh` 第 5 段实测：`pgrep -fl "dsh-cua-native|ControlIndicator|BrowserPreview|PermissionPrompt" → none`，**无僵尸、无泄漏**。
- 但会留下 `/tmp/dsh-cua-501/`（provider 的 runtime 目录，0700，含 lock 文件）——`prepare()` 每次都会 `mkdir`，属既有设计，非本次失败造成。
- 真正的泄漏风险在指示器路径：`indicator.ts:172-191` `start()` 超时后 `await this.finish()` 只清 `runId`，**不 kill 子进程**，`this.child` 仍存活到 session 关闭（`close()` 才会 SIGTERM）；helper 未 ready 时 spawn 出来的进程会一直挂着。

**CI 无 GUI / 无授权时应如何判定（建议）**

- 判定条件用**能力探测**而不是路径猜测：`AXIsProcessTrusted()` 为 false、或 `realpath(HELPER)` 失败、或 `CGSessionCopyCurrentDictionary()==null` 时，整组原生 spec 标 `skip`（或改断言 `status: escalated, reason: accessibility_permission_required`），并输出一行诊断，避免「绿得莫名其妙」。
- 把 helper 纳入仓库自己的构建产物（`npm run build` 或 test fixture 的 prebuild），不要引用 `/tmp` 下第三方 checkout；`HELPER` 应从环境变量/构建输出解析。
- 失败信息必须带 content（`expect(x.isError, JSON.stringify(result.content))`），并把 `NATIVE_IO` 映射为稳定 reason（如 `native_helper_unavailable`）。

**回归测试建议**

- 一条 `helper 缺失 → reason=native_helper_unavailable，skipped=true` 的用例。
- 一条 `AX 未授权 → accessibility_permission_required` 的用例（可用 `cua` 的假 provider 注入 capabilities）。

---

## NR-08 ｜ MEDIUM ｜ 指示器可用性耦合运行：一行非 JSON 输出崩进程，helper 掉线直接杀死 run，编译失败静默降级成无指示器

**证据**

- `src/indicator.ts:122-123` — `helperEvent.safeParse(JSON.parse(raw))`：`JSON.parse` **未包裹**，readline 的 `line` 回调里抛错 → 未捕获异常（默认终止进程）。
- `src/indicator.ts:193-195` — `activity()` 在 `runId===undefined` 时 `throw new Error('native_indicator_not_running')`；`controller.ts:730-734` 与 `:741` 无 try → 动作阶段直接失败。
- `src/index.ts:119-127` — `NativeControlIndicator.create(...).catch(() => new NoopNativeIndicator())`：编译失败/授权失败时**静默**换成空实现，此后整个 run 没有任何光标与状态面板（违反 §5.4 与 SKILL.md 规则 9）。
- `src/indicator.ts:154-162` — helper 退出即 `onUnavailable()`（`index.ts:126` → `controller.stop(agent,'indicator_unavailable')`）。
- `native/ControlIndicator.swift:80-84` — 0.5s 一次的心跳检查，>3s 无心跳即 `expired` 并 `finish()`：Node 事件循环被同步工作阻塞 3s（大 JSON、GC、模型响应解析）就会误杀合法 run。

**PoC 输出**

```
redteam/poc/native/nr02-indicator-lifecycle.spec.ts
✓ turns one malformed helper line into an uncaught exception      ← 一行 "helper: starting up" 即触发
✓ kills the run when the helper disappears instead of degrading   ← onUnavailable=1，随后 activity 抛 native_indicator_not_running
```

**影响**

- 可用性缺陷被放大成控制面缺陷：指示器任何异常都会中断一次合法操作，或者在 `Noop` 情况下让操作**完全不可见**却继续执行。
- 崩溃面来自 helper 的 stdout：任何 `print`、Swift runtime 诊断、未来新增字段都会让宿主进程未捕获异常退出（Node 单进程 = 整个会话状态丢失）。

**修复方向**

- 逐行解析必须 try/catch 并计数丢弃；未知/畸形行只记诊断。
- 指示器不可用 → 明确两种语义：`Noop` 只允许用于**只读**操作；任何输入动作要求「可见指示器可用」，否则 `escalated: indicator_unavailable`（fail-closed 而不是静默降级）。
- 心跳改为「宿主主动 ping + 宽限窗口」或双向租约，并把事件循环阻塞计入预算而不是误判掉线。

**回归测试建议**

- 畸形行、超大行、helper 立即退出、helper 挂起（不 ready）四种故障注入；断言进程存活 + 稳定 reason。

---

## NR-09 ｜ MEDIUM ｜ 权限状态读的是一次性临时二进制的 TCC 身份，不是派发输入的那个进程

**证据**

- `src/permissions.ts:29-49` — 编译 `native/PermissionPrompt.swift` 到 helper 缓存并解析它打印的 JSON。
- `native/PermissionPrompt.swift:18-30` — `AXIsProcessTrusted()` / `CGPreflightScreenCaptureAccess()` 回答的是**该二进制自己**的授权状态。
- 真正派发输入的是 `dsh-cua-native`（另一个二进制、另一个 TCC subject），run 路径用的是 `controller.ts:283-302` 里 `getCapabilities` 的结果。
- `helper-cache.ts:17-24` — 源文件改动一个字符 ⇒ key 变 ⇒ 新路径 ⇒ 旧授权不再适用。

**PoC 输出**

```
redteam/poc/native/nr09-nr10-permissions-pending.spec.ts
✓ gives a one-comment source change a brand new TCC identity   ← 两份仅差一行注释的源 → 两个缓存目录
```

**影响**

- `readPermissions()` 可能报告 `accessibility: true`（用户给临时 helper 授过权）而实际输入全部失败；反之临时 helper 未授权而主 helper 已授权时又会误报「未授权」，引导用户在错误的条目上授权。
- 每一次 helper 源码变更都会让用户已经给出的授权静默失效，表现为「昨天能用今天不能用」。
- `promptMissingPermission`（`controller.ts:62-79`）在 await 之前就把 kind 写进 `promptedPermissions`，`requestPermission` 抛错后（`prompted: false`）也**不再重试**。

**修复方向**

- 权限状态只从真正执行输入的那个 helper（`getCapabilities`）读，`PermissionPrompt` 只用于「打开设置面板」，不参与判定。
- 若必须用独立 helper 申请授权，它的路径必须稳定（固定安装位置、签名与 host app 一致），不能落在内容寻址的临时缓存里。
- `promptedPermissions` 只在真正 `prompted === true` 时写入。

**回归测试建议**

- 注入「临时 helper 已授权、主 helper 未授权」与反向两种组合，断言对外只报告主 helper 的状态。
- 断言 `requestPermission` 抛错后仍可重试。

---

## NR-10 ｜ LOW/MEDIUM ｜ `hasPendingState` 把整棵 AX 树里的「loading/waiting」当成进行中，被控应用可以决定卡住 run

**证据**

- `controller.ts:251-253` — `hasPendingState(state) = /loading|waiting|please wait|加载|等待/iu.test(state.tree)`，对整棵树做正则。
- `controller.ts:613-630`（d1）与 `skill-runner.ts:171-190`（skill）在每次动作后进入 `asyncTimeoutMs`（默认 5000ms）轮询。

**PoC 输出**

```
redteam/poc/native/nr09-nr10-permissions-pending.spec.ts
✓ treats any "loading/waiting" word in the AX tree as a pending operation
    "Waiting for customer reply" / "Build loading…" / "正在等待对方输入" → true
    AXProgressIndicator（真正的进度指示，无英文动词）→ false
```

**影响**

- 任何渲染了 `waiting/loading` 字样的正常界面（客服、CI、聊天）都会让每一步多花最多 5 秒并可能以 `async_result_timeout` 结束；被控应用可以用一行静态文本决定 run 的节奏（预算消耗，§8 的墙钟预算被外部消耗）。
- 反向漏判：真正的 spinner 无文本时直接跳过等待，误判为「无更新」。

**修复方向**

- 以结构化信号为准（`AXProgressIndicator` / `AXBusyIndicator`、`enabled=false` 的提交按钮、`value` 变化），文本启发式只作为补充并限制在「本次动作目标子树」。
- 正则命中不应延长预算，而应记一次诊断；`asyncTimeoutMs` 按动作类型区分。

**回归测试建议**

- 两棵只有静态文本 `Waiting…` 的树：断言 `hasPendingState === false`（或动作后不等 5s）。
- 一棵带 `AXProgressIndicator` 的树：断言会等待并最终超时。

---

## NR-11 ｜ MEDIUM ｜ 控制台没有租约：断连不撤销输入，pageToken 进转录，监听不指定 host

**证据**

- `packages/dsh-cu-core/src/control-server.ts:157` — 页面只 `setInterval(refresh,1000)` 轮询；服务端 `:206-290` 无 `req.on('close')`、无 SSE/WS、无心跳端点 ⇒ **客户端关闭无法被感知**，§5.4「客户端退出…撤销输入权限」在控制台这一侧无法实现。
- `control-server.ts:217` — 静态 Bearer 鉴权（`this.token` 或 `pageToken`），无过期、无轮换、无来源校验。
- `src/index.ts:253-257` — `computer_control` 把 `http://127.0.0.1:PORT#token=<uuid>` 直接放进**工具返回值**，即进入模型上下文与任何转录/导出；`pageToken` 可 `pause/resume/stop/takeover` 并调用 `/api/skills/remove`（`control-server.ts:253-263`）。
- `control-server.ts:203-207` — `createServer(...)` 后 `listen(port)` 未指定 host：Node 默认绑定 `::`（所有接口），意味着同一局域网可达（虽仍需 token）。

**影响**

- 关闭控制台页面后 run 继续控制机器、光标仍在：与 NR-02 同源的「可见性/授权脱钩」。
- 控制台页面本身 XSS 安全（见 B2），但 token 在转录中流通；一旦被别的会话/日志外带，攻击者可拿到完整的 run 控制权。
- 无 host 绑定时，若 token 泄漏，局域网内即可操作（POST /api/stop、/api/takeover）。

**修复方向**

- 控制台引入租约：页面心跳 3s 一次，缺失即 `stop`（或至少 `pause` + 释放指示器）；或把控制台纳入与原生指示器同一套租约。
- `pageToken` 单次使用/短 TTL；不要把带 token 的 URL 放进工具返回值（改为「控制台已就绪」+ 单独的安全通道展示）。
- `listen(port, '127.0.0.1')`，并校验 `Host`/`Origin`。

**回归测试建议**

- 断言页面停止心跳后 N 秒内 run 进入 `stopped`；断言工具结果中不含 token；断言服务只监听回环地址。

---

## 攻不破边界（本轮未能打破，记录为正面结论）

**B1 ｜ AX 文本无法注入伪造的元素行。**
`AXTextFormatter.swift:78-112` 用 `String(reflecting:)` 输出 title/value/identifier/description，Swift 的 debug 描述会把换行转义成 `\n`（反斜杠+n 两个字符），因此应用无法在自己的标题里塞真实换行来伪造 `- [99] AXButton …` 行；`controller.ts:157` 的行首正则也要求 `- [数字] 角色` 结构。附带结论：伪造**值**同样受阻（`"` 会被转义成 `\"`，正则 `"([^"]*)"` 取不到干净的值）。
（注意：合法但不可见的元素仍能骗过验证 —— 那是 NR-04，不是注入。）

**B2 ｜ 控制台 / 客户端没有发现 XSS。**
`control-server.ts:95-146` 全程 `document.createElement` + `textContent`，动态数据（`skill.scope`、`reason`、audit detail）从不进 `innerHTML`；注入点只有 `${data.labels.*}`（静态 locale 字符串）与 `escapeJson(data)` 引导块。`dsh-cu-client/lib/client.js` 用 React `jsx` 渲染纯文本子节点，全文件无 `dangerouslySetInnerHTML`/`innerHTML`。token 放在 URL fragment 并 `history.replaceState` 清除，仅存 `sessionStorage`。

**B3 ｜ 未知/缺失断言是失败关闭的。**
`verification.ts:22-24` 对未注册的 handler 抛错，`controller.ts:245-248` 的 catch 返回 `false`；`contract.ts:17` 的 `verify` 是 `array(...).min(1)` 且必填，`verificationForSkill`（`skills.ts:167-192`）在 Skill 无后置条件时抛 `skill_verification_required`。因此「空断言直接成功」这条路走不通（唯一的空转口子是 NR-04 的 `url_contains`）。

---

## 附：发现清单

| ID | 级别 | 一句话 | 主要证据 | PoC |
| --- | --- | --- | --- | --- |
| NR-01 | HIGH | Skill 作用域=应用自写的标题串；回放零审批 | `skill-runner.ts:28`、`skills.ts:245-259`、`skills.ts:90-104`、`controller.ts:692-695` | `nr01-skill-scope-approval.spec.ts` |
| NR-02 | HIGH | 指示器可无声消失，输入权限不收回 | `ControlIndicator.swift:210-217,335-361`、`indicator.ts:122-141,193-205` | `nr02-indicator-lifecycle.spec.ts` |
| NR-03 | HIGH | 三套坐标 + 旧窗口矩形；光标≠落点 | `controller.ts:405,650-668,710-720,759-793`、`dsh-cua/lib/index.js:856-866` | `nr03-native-geometry.spec.ts` |
| NR-04 | HIGH | 0×0/description/同名文本即可「验证通过」 | `controller.ts:154-197,223-249` | `nr04-verification-fake-positive.spec.ts` |
| NR-05 | HIGH | custom 断言注册表后写覆盖 + 证据路径由调用方给 | `verification.ts:11-24`、`controller.ts:230-234` | `nr05-verification-registry.spec.ts` |
| NR-06 | MEDIUM | helper 缓存可预测路径、存在即执行 | `helper-cache.ts:17-24,44-51` | `nr06-helper-cache.spec.ts` |
| NR-07 | HIGH(流程) | 基线 7 红=helper 缺失+无 AX 授权；错误被伪装；无跳过 | `tests/fixtures.ts:9`、`native-client.js:154-157`、`index.ts:174-194` | `baseline.sh` + `out/*.log` |
| NR-08 | MEDIUM | 畸形 stdout 崩进程 / helper 掉线杀 run / Noop 静默降级 | `indicator.ts:122-123,193-195`、`index.ts:119-127` | `nr02-indicator-lifecycle.spec.ts` |
| NR-09 | MEDIUM | 权限读的是临时 helper 的 TCC 身份 | `permissions.ts:29-49`、`PermissionPrompt.swift:18-30` | `nr09-nr10-permissions-pending.spec.ts` |
| NR-10 | LOW/MED | `hasPendingState` 文本启发式可被应用利用 | `controller.ts:251-253,613-630` | `nr09-nr10-permissions-pending.spec.ts` |
| NR-11 | MEDIUM | 控制台无租约/断连不撤销；token 进转录；监听全接口 | `control-server.ts:157,203-217`、`index.ts:253-257` | 源码审查（无 PoC） |

统计：HIGH 6（NR-01/02/03/04/05/07）、MEDIUM 4（NR-06/08/09/11）、LOW/MED 1（NR-10）；攻不破边界 3 条。
