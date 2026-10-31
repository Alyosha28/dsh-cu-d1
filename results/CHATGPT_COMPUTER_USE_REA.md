# ChatGPT Computer Use：REA 静态逆向报告

## 结论

本机 ChatGPT 客户端的 Computer Use 不是“模型直接看截图并调用鼠标”。它是一个分层系统：

```text
模型
  │ 生成 JavaScript 工具调用
  ▼
cua_repl / 本地 MCP 与持久化 JavaScript 环境
  │ @oai/cua、@oai/sky 类型化观察与动作 API
  ▼
Computer Use worker / 本地 RPC 与生命周期管理
  │ Apple Event JSON 请求；同时存在 XPC、JSON-RPC socket、Native Bridge 边界
  ▼
SkyComputerUseService（com.openai.sky.CUAService）
  │ AXUIElement、AppKit、ScreenCaptureKit、CGWindow、Apple Event
  ▼
被授权的 macOS 应用和窗口
  │
  └─ AX 文本或 diff、截图、metadata、completed / failed 状态返回
```

模型负责规划和选择 API；本地 Provider 负责状态采集、坐标与快照语义、原生输入、权限、服务生命周期和结果验证。模型推理的完整后端链路没有在本次通过网络流量验证，因此本报告不声称推理全部位于云端或全部位于本机。

## 证据范围

- 客户端：`/Applications/ChatGPT.app`，版本 `26.1021.31345`。
- 原生服务：`Codex Computer Use.app`，版本 `26.1021.1001631`，最低 macOS 14.4。
- REA 对 14 个 Computer Use 相关 renderer 模块完成静态图分析。
- 对 Electron 主进程、worker、`@oai/cua`、`@oai/sky` 文档及原生服务链接符号进行了只读检查。
- 未登录账号、未启动真实 Computer Use、未截取用户应用、未拦截网络流量，也未对原生服务做完整反编译。

## 1. 模型看到什么、怎样操作

随客户端分发的 `tinysky-alt-core-cua-repl.md` 和 `tinysky-alt-core-node-repl.md` 明确给出模型侧契约：

- 优先使用专用 connector、API、CLI 或 Skill；Computer Use 用于这些接口无法完成的任务。
- 使用持久化 `cua_repl` JavaScript 调用，不要求模型逐步生成鼠标底层事件。
- `cua.getApp()`、`cua.getTab()` 等绑定调用自动返回初始 UI 状态。
- 默认优先 AX 元素索引；AX 行动失败或没有语义元素时才使用截图坐标。
- 一批动作后重新 `getAXState()`，不能复用旧元素索引。
- AX 默认返回与上一棵树的 diff；需要完整树时使用 `disableDiffing: true`。
- 可以把确定性动作和结果观察批处理在一次调用中，减少模型往返。
- 观察函数内部负责适当等待，模型不应通过任意 `setTimeout` 猜测等待时间。
- 最终必须由可见 UI 结果证明任务完成，动作发出不代表完成。

主要 API 包括 `getAXState`、`getScreenshot`、`getAXStateAndScreenshot`、`click`、`drag`、`scroll`、`selectText`、`setValue`、`performSecondaryAction`、`paste`、`pressKey` 和 `typeText`。

## 2. 本地执行链

Electron worker 中存在 `computer-use-worker`，处理：

- `requestPermissions`
- `start` / 捕获启动
- `watchUpdates` / 连续观察
- `stopApplication`
- status item、history、settings 和 Messages 相关控制

主进程通过 `computer-use-service-pid` 获取原生服务 PID，并可失效旧 PID。生命周期代码会检查进程是否存活、可执行路径是否匹配，并支持启动和重新启动 `SkyComputerUseService`。

原生请求使用 `CodexComputerUseNativeBridge-1` 版本标识，把请求类型、JSON 数据和超时封装进 Apple Event。可见请求包括：

- `ComputerUseIPCAppGetSkyshotRequest`
- `ComputerUseIPCAppStartCaptureRequest`
- `ComputerUseIPCAppNextCaptureUpdateRequest`
- `ComputerUseIPCAppStopRequest`
- `ComputerUseIPCSkysight*Request`

捕获更新类型包括 `metadata`、`axText`、`screenshot`、`completed` 和 `failed`。截图 URL 不是无条件读取：客户端限制文件类型、大小以及位于原生服务临时目录内的真实路径，再转换为 data URL。

## 3. macOS 原生能力

原生服务链接和未定义符号直接显示：

- **AXUIElement**：读取属性与动作、执行动作、设置值、遍历与定位 UI 元素。
- **ScreenCaptureKit / SCStream**：屏幕与窗口捕获。
- **CGWindow**：窗口列表、编号、边界、所有者与可见状态。
- **AppKit / NSWorkspace / NSEvent**：应用、窗口和输入相关行为。
- **Apple Event / AECreateAppleEvent / AESendMessage**：客户端与原生服务间的授权请求和响应。
- **AXObserver**：监听辅助功能通知。

服务 bundle 同时包含授权插件、客户端和 `CUALockScreenGuardian`。签名 entitlements 包含 Apple Events automation 和应用组；Contacts、Calendars 权限说明属于对应的 Messages/Calendar 功能，不能都解释为普通鼠标控制所必需。

## 4. 权限、确认与用户接管

首次授权文案明确说明：Computer Use 可操作本机应用、可能截取应用内容，用户可选择可访问应用、随时停止，并控制截图是否用于训练。

授权卡片支持：

- `Allow this conversation`
- `Always allow`
- 拒绝
- 高风险操作的 elevated-risk 展示

设置与查询模块包含应用授权撤销、Messages 读取/发送审批、观察策略以及锁屏使用状态。`takeover-border` 提供 `Take over` 和 `Return control`，允许用户在 Agent 与真人之间切换控制权。

随客户端提供的确认策略进一步区分：

- 必须交给用户的动作；
- 即使预先批准也必须在动作时确认的动作；
- 可以由初始提示预授权的动作；
- 无需确认的动作。

删除、金融交易、发送信息、上传、敏感数据传输、安装软件、修改系统设置和 CAPTCHA 等不是单纯由模型自行决定。第三方页面或文档内容不能自行构成授权。

## 5. 对 DSH_CU 的直接启示

1. **Provider 比模型更关键。** ChatGPT 把大量可靠性工作放在状态格式化、diff、坐标映射、权限和原生执行层，而不是要求模型解决所有问题。
2. **类型化 API 比自由坐标更重要。** AX 元素、具名动作、窗口和截图 ID 限定了模型可执行空间。
3. **AX 优先、视觉兜底是实际采用的路径。** 这与本项目的方向一致。
4. **状态压缩是核心设计。** 默认 AX diff、持久对象、批处理动作和内部等待都直接减少模型上下文和往返。
5. **需要独立的完成与风险判断。** 可见后置状态、按动作风险确认、应用授权、人工接管和停止不能由 Decision Model 自己宣布。
6. **D1 最合适的插入点是决策层，而不是替代原生服务。** 可以让 D1 选择下一个类型化操作或目标 box，但官方 CUA 类原生服务仍应负责权限、输入路由、快照和几何检查。

## 未验证部分

- 未观察真实任务中的具体模型请求、提示词版本和云端路由。
- 未证明所有鼠标/键盘路径都使用同一个系统 API；原生服务存在多种输入与桥接机制。
- 未评估第三方应用中的实际成功率、延迟和错误恢复。
- 本报告针对当前安装版本，后续客户端可能改变实现。
