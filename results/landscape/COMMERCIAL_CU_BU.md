# 商用 Computer Use / Browser Use 能力盘点

核实时间 2026-10-29。只写官方文档可查内容；OpenAI 官网与 Help、Google 部分产品页在本机 403 或重定向，相关条目标 `[未核实]`。

## OpenAI

- 现行 API 两条路径：`ComputerToolset`+computer tool 返回结构化鼠标/键盘动作；或模型写代码执行（`exec_js` 用 Playwright、`exec_py` 用 PyAutoGUI）。官方称 GPT-6 Astra 推荐代码执行，computer tool 仍受支持。[docs](https://platform.openai.com/docs/guides/tools-computer-use)
- 动作：截图+坐标点击/输入；代码路径一次调用可含循环和条件；示例视口 1024×768、1440×900。
- 观察：截图（按图像计费）；`BrowserToolset` 另把页面文本、控件、标签页暴露为 function tool。
- 人在环：SDK 有 `confirm` 回调、`allowed(action)` 白名单（示例只许点指定表单区域）、`maxSteps`；要求改动前批准、报成功前核对结果。
- 安全：隔离浏览器/桌面、全新 profile、限制网络、凭证不得进入页面文本或截图；API 安全审查会中断运行，需自接审批回调。
- 可靠性：无自动后置校验，示例由应用比对页面结果；单次示例限 20 个 response。
- 失败模式：文档未列清单，只提示页面内容会影响模型、截图计费、`store:false` 不消除全部留存。
- 评测：无 WebArena/OSWorld 分数。
- Operator / ChatGPT agent / Codex / Atlas：官网 403，`[未核实]`。

## Anthropic

- 两套 client toolset：`computer_toolset_20260801`（17 个成员工具）、`browser_toolset_20260801`（默认 27 个+4 可选），均不在 Managed Agents 提供。([computer use](https://docs.claude.com/en/docs/agents-and-tools/tool-use/computer-use-tool)、[browser use](https://docs.claude.com/en/docs/agents-and-tools/tool-use/browser-use-tool))
- 动作：screenshot、zoom（区域全分辨率）、左/右/中键、双击、三击、拖拽、mouse_down/up、scroll、type、key（ctrl+s 等组合，repeat 1–100）、hold_key（≤300 秒）、wait；坐标为截图像素。
- 观察：computer use 仅截图；browser use 走 accessibility tree、元素、表单、标签页（`browser_state.tabs`）加截图与视口坐标，两套坐标系独立。
- 分辨率：桌面 1024×768 或 1280×720，网页 1280×800/1366×768，不建议超 1920×1080；单图约 1000–1800 input tokens，超 20 张图触发更严单边限制。
- 人在环/安全：要求专用 VM/容器、最小权限、域名 allowlist、后果性动作人工确认；工具返回内容经分类器扫描 prompt injection，可申请关闭。
- 失败模式：下拉框/滚动条难操作（改用快捷键）、DPI 未缩放导致点击偏移、小目标或低分辨率点错、指令含糊点错元素。
- 评测：任务成功率未给。
- Claude in Chrome：站点级权限、动作确认、autonomous mode 仍保护敏感动作、屏蔽金融/成人/盗版站点；官方红队 ASR 23.6%→11.2%，浏览器专属攻击 35.7%→0%；支持多标签、定时任务、读取 DOM/console，管理员可配 allow/blocklist。[来源](https://www.anthropic.com/news/claude-for-chrome)
- Claude in Excel/desktop、MCP 方案：`[未核实]`。

## Google

- Vertex computer use：模型返回 `function_call`，客户端执行后回传新截图与 URL。([docs](https://cloud.google.com/vertex-ai/generative-ai/docs/computer-use))
- 动作（3.5 Flash 桌面）：click/double/triple/middle/right、mouse_down/up、move、type、drag_and_drop、wait、press_key、key_down/up、hotkey、scroll（像素）、take_screenshot，坐标 0–999 网格；移动环境另有 open_app/list_apps/long_press；3 Flash 用 navigate/search/hover_at 等旧集合。
- 观察：截图+URL，无 AX/DOM 接口。
- 安全：内置 `safety_decision`，`require_confirmation` 时必须弹确认并回传 `safety_acknowledgement`，CAPTCHA 即示例；3.5 Flash 起可开 prompt injection detection（默认 false）。
- 人在环：官方 HITL 模板要求提交/发送/支付/登录/下载文件前确认；建议沙箱 VM/容器、allow/blocklist、全量日志。
- 失败模式：可能相信屏幕诈骗信息、误点、被诱导绕过 CAPTCHA；文档明确禁止绕过 CAPTCHA。
- 支持模型：Gemini 4 Argon、3.8/3.7/3.6/3.5 Flash、3 Flash preview，已不含 2.5。评测：无。
- Project Mariner：官方页重定向到 DeepMind 首页，`[未核实]`；Gemini in Chrome 亦 `[未核实]`。

## Microsoft

- Copilot Studio computer use：在 Windows 机器上以虚拟鼠标键盘操作网站与桌面应用，自然语言指令，仅生成式编排 agent 可用。([docs](https://learn.microsoft.com/en-us/microsoft-copilot-studio/computer-use))
- 动作：点击、选菜单、输入；按像素截图理解，FAQ 称为 perception-reasoning-action 循环，可处理多步流程与界面变化。
- 模型：OpenAI CUA、GPT-6 Sol、Claude Sonnet 4.5/4.6、Opus 4.6；5 credits/步（premium 15）。
- 人在环：human supervision 检测到可疑/有害指令时暂停并邮件通知审核人，超时终止；官方称触发是概率性的，不能当安全兜底。
- 权限/凭证：access control 限定 URL 与桌面应用，但只阻止交互、不阻止打开；可强制 HTTPS；凭证支持 maker 或 end-user 身份，存于 Power Platform 内部或 Azure Key Vault；Electron/Java/Unity/CLI/Citrix 密码框可能不支持。
- 运行：autonomous 或 conversational，官方称 autonomous 最好；机器由 Power Automate 管理，建议专用隔离机、最小权限、Intune/Edge 策略限站。
- 失败模式（FAQ）：性能随任务与界面差异大、对布局和加载时序敏感、下拉框/日期选择器难操作、可能循环卡住、不适合金融交易及招聘/医疗/金融评分。([FAQ](https://learn.microsoft.com/en-us/microsoft-copilot-studio/faqs-computer-use))
- 评测：只给定性描述。Copilot Vision `[未核实]`；UFO/OmniParser 是开源研究项目，Copilot Studio 文档未列为组件，`[未核实]`。

## 横向共性

- 截图+像素坐标是共同底座；只有 Anthropic browser use 与 OpenAI BrowserToolset 额外提供 DOM/AX 结构化观察。
- 模型只出动作，执行环境由客户提供（VM/容器/本地浏览器）；四家都要求隔离与最小权限。
- 都有人工确认闸门：OpenAI `confirm` 回调、Anthropic 后果性动作确认、Google `safety_response`、Microsoft human supervision。
- 都提供站点/应用 allowlist 或网络限制（OpenAI 由 driver 与托管 provider 规则实现）。
- 都把 prompt injection 列为首要风险，要求不向模型暴露凭证。
- 都支持多步循环与出错后继续尝试，但无一家承诺任务成功率或提供内置的后置条件验证。
- 都按 token/步/credits 计费，截图是主要成本项。

## 明确未提供的

- 统一公开基准分数：本次核实的四家文档均未给出 WebArena/WebVoyager/OSWorld/ScreenSpot 数字。
- CAPTCHA/2FA 自动通过：无厂商声称支持；Google 明确禁止绕过、要求用户确认。
- 高风险场景的无人值守担保：四家都要求确认或声明不适用（Microsoft 明确排除金融交易）。
- 跨站凭证代管：仅 Microsoft 提供 Key Vault/内部存储，其余三家都要求避免把凭证交给模型。
- 内置的后置条件验证与自动重试保证：OpenAI 由应用侧校验，Microsoft 承认可靠性随任务波动，Google/Anthropic 未提供。
- 桌面与移动统一动作集：仅 Google 有移动环境动作，其余面向桌面/浏览器。
- 完整审计回放：Google 建议自建日志，Microsoft 有 run activity map，但不是统一交付物。
