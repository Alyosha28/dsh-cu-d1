# 开源 Browser-use / Computer-use 框架能力盘点

只列文档/源码可确认的事实；未确认标 `[未核实]`。

## browser-use（Python）
- 工具：`click(index)`、`input`、`scroll`、`send_keys`、`switch`、`extract`、`screenshot`、`upload_file`、`done`（[工具表](https://docs.browser-use.com/open-source/customize/tools/available)）。
- 观察：`dom_state`（裁剪 DOM）+ 可选 `screenshot`（[views.py](https://github.com/browser-use/browser-use/blob/main/browser_use/browser/views.py)）；无 token 数字。
- 重放：`save_history` → `detect_variables()` → `load_and_rerun(variables=...)`，点击/输入逐条重放、每步不调模型；extract 与收尾仍用模型，页面变动在首个不匹配步抛 `RuntimeError`（[README](https://github.com/browser-use/browser-use)）。
- 认证：复用本机 Chrome profile；云端 profile sync 只迁 cookie；`sensitive_data` 写占位符。
- 基准：自称 Stealth Bench V2 90.5%，自建基准，无 WebVoyager 数字。

## Stagehand（TypeScript）
- `act(instruction)`、`observe()`、`extract(schema)` + 原生 Playwright；`observe` 返回真实 selector（凭据不进模型）；`act(Action)` 确定性重放、零推理（[Act](https://docs.stagehand.dev/v4/basics/act)）。
- `selfHeal` 在 selector 失效时重推理；观察为 "hybrid accessibility-tree trimming"。
- 缓存：Browserbase 服务端，命中零 token；本地浏览器无效（[Caching](https://docs.stagehand.dev/v4/best-practices/caching)）。
- 多 tab 自动跟随；locator 支持嵌套 iframe、closed shadow DOM。无 benchmark。

## Skyvern
- `page.act/extract/validate/prompt`；`page.agent.run_task/login/download_files/run_workflow`；Playwright 动作可加 `prompt=` 找元素（[README](https://github.com/Skyvern-AI/skyvern)）。
- Vision LLM 为主，不用 XPath；token 未说明。工作流含 Validation、Loop、HTTP、Code 等 block。
- 重放：成功后可生成代码，`run_with="code"` 直接执行；AI Fallback 默认开，失败回退模型并重生成（[文档](https://www.skyvern.com/docs/developers/browser-automation)）。
- 认证到 TOTP/邮件/SMS 2FA；下载入 block storage；可 livestream 人工介入。
- 基准：WebVoyager 85.8%、WebBench 64.4%。

## Playwright MCP
- `browser_snapshot`（a11y tree）+ `target`（ref 或唯一 selector）驱动 click/type/fill_form/drag；另有 file_upload、tabs、cookie/storage、network、`run_code_unsafe`（[README](https://github.com/microsoft/playwright-mcp)）。
- 纯 a11y、无视觉；截图明确不可用于操作。
- 验证：`--caps=testing` 才开 `browser_verify_element_visible/text_visible/value/list_visible`。
- `browser_start_recording` 把人工操作录成 Playwright 代码（零 LLM 但需示范）。

## Chrome DevTools MCP / Puppeteer MCP
- CDMCP：`take_snapshot` 给 a11y tree 与每元素 `uid`；动作按 `uid`，另有 `click_at(x,y)`；`pageId` 多页；含 performance/network/console（[tool-reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)）。底层 Puppeteer，自动等待。
- Puppeteer MCP：已归档参考 server，仅 CSS selector + navigate/screenshot/fill/evaluate，无 a11y 快照与校验（[servers-archived](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/puppeteer)）。

## cua（trycua/cua）
- `get_window_state(pid, window_id)` 一次返回 AX tree（每元素 `element_token`）+ 截图（[文档](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works)）。
- 动作 `click/type_text/press_key/hotkey/scroll/drag`，每次显式指定 target（元素/窗口像素/桌面）。
- 验证：`effect=confirmed|unverifiable|suspected_noop|partial|refused`，`verified` 仅 AX 回读成功；附 `escalation`（element→pixel→page→foreground）与 `stale_element_token`。
- Lume 本机起 macOS VM、Linux 镜像、云 runtime；后台输入不抢焦点；权限用 manifest + YAML/Rego（[README](https://github.com/trycua/cua)）。Spaces 可人接管，Cua Bench 导 trajectory。

## Microsoft UFO / OmniParser
- UFO²：HostAgent + AppAgent；Windows UIA + Win32 + WinCOM；GUI/API 混合动作；UIA+视觉混合控件检测；RAG 吃文档/演示/轨迹。在 WAA 154、OSWorld 49 任务评测，README 未给分数（[README](https://github.com/microsoft/UFO)）。
- OmniParser：截图 → 结构化元素（bbox、类型、可交互性、描述），纯 grounding 无执行器；OmniTool 驱 Win11 VM 并记轨迹；ScreenSpot Pro 39.5%（[README](https://github.com/microsoft/OmniParser)）。

## WebVoyager / Agent-E / Nanobrowser
- WebVoyager：Selenium + Set-of-Mark 截图；`--text_only` 退化为 a11y tree；643 任务/15 站 + 90 GAIA；限步、存 trajectory、可下载 PDF；GPT-4V 自动评（[README](https://github.com/MinorJerry/WebVoyager)）。成功率 `[未核实]`。
- Agent-E：AutoGen 双 agent；技能 `get_dom_with_content_type(...)`、`click(selector)`、`enter_text_and_click`；DOM 蒸馏 + 注入 `mmid` + a11y 树降噪（[README](https://github.com/EmergenceAI/Agent-E)）。缓存与 Shadow DOM 仅在 roadmap；分数 `[未核实]`。
- Nanobrowser：Chrome/Edge 扩展；元素 ID 绑死元素，页面变化后旧 ID 失效；动作回报是否生效/到达预期状态；提交、删除、上传前按 Ask/Auto 与站点策略拦截；多 tab、上传、写 Downloads、可选视觉（[README](https://github.com/nanobrowser/nanobrowser)）。无 benchmark。

## Browserbase / Browserless（仅 agent 相关）
- Browserbase：托管 session/context、residential proxy、Verified 浏览器、session recording，并承载 Stagehand 缓存（[Stagehand](https://github.com/browserbase/stagehand)、[docs](https://docs.browserbase.com)）。
- Browserless：托管 Chrome 的 REST/WS 接入；细节本轮未取证 `[未核实]`。

## 共性能力
- `act(instruction)` 式单步自然语言动作是通用入口。
- 元素引用定位（index/ref/uid/`element_token`/selector）至少一种；纯坐标非主流。
- 观察以结构化文本为主，截图为辅或仅作确认。
- 步骤循环 + 轨迹留存；schema 化提取普遍。
- 登录态复用（profile/context/cookie）、多 tab、文件上传多数支持。
- 人工接管/live view/审批多数有，但库层强度差异大。

## 明显分化
- 观察：裁剪 DOM（browser-use、Agent-E）↔ 纯 a11y（两个 MCP）↔ 截图为主（OmniParser、Skyvern、WebVoyager 视觉）↔ AX+截图（cua、UFO）。
- 定位：index/ref/uid ↔ 真实 selector ↔ 像素坐标 ↔ 纯自然语言（Skyvern）。
- 失效：只有 cua 把 `stale_element_token`/`effect`/`escalation` 做成协议字段；Nanobrowser 让旧 ID 直接失效；其余靠重拍快照。
- 验证：`browser_verify_*` 与 cua `verified` 是显式后置条件；Skyvern 有 Validation block；browser-use 明说 `is_successful` 只是自报。
- 重放：browser-use 轨迹重放（extract 仍用 LLM）；Skyvern 代码化 + AI fallback；Stagehand Action 零推理、缓存依赖 Browserbase；Agent-E 仅待办。
- 隔离/认证：cua 到 VM 级；其余多为浏览器 context 级。Skyvern 到 2FA，browser-use 只同步 cookie，Stagehand 靠 `userDataDir`。
- 基准：Skyvern、OmniParser、UFO 公开 benchmark；Playwright MCP、Stagehand、Nanobrowser 不给；browser-use 改用自建基准。
