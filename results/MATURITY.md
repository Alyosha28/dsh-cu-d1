# 成熟度验收记录

日期：2026-10-31
目标：把 DSH-CU 从“一组能跑的包”收敛成“一件能装进 DSH 的插件”。

## 成熟度判据与证据

| 判据 | 证据 | 结果 |
|---|---|---|
| 能装进真实 profile | `dsh plugin --profile dsh-cu-install add link:...bundle link:...core link:...browser-use-d1`，再把 `@alyosha28/dsh-cu-bundle` 加进 `dsh.profile.bundles` | 通过 |
| 组合出正确条目 | `dsh --profile dsh-cu-install --dump-config`：`browser-use-registry`、`dsh-cu-browser` 均在，无 `skipping profile bundle` | 通过 |
| 运行时版本匹配 | 应用为 `@deepseek-ai/dsh-desktop-runtime` 0.2.1-rc.5；插件 `engines.dsh: >=0.2.1-rc.5 <0.3.0`，依赖 0.2.1-rc.5 / cordis 4.0.5 | 通过 |
| 真机启动 | `dsh --profile dsh-cu-install --json "ok"`：完整跑完一轮，无启动失败 | 通过 |
| 模型能调用工具 | `DSH_CU_HEADLESS=1 dsh --profile dsh-cu-install "...browser_observe..."`：`tool_call browser_observe` → `status: success`，返回快照 JSON | 通过 |
| 装机自检 | `dsh plugin --profile ...` + `npm run plugin:doctor -- --profile=dsh-cu-install`：条目、启用状态、独占槽位、版本对齐全部 PASS | 通过 |
| 插件级契约 | `npm run test:plugin`：loader 装载 dist、真实服务、真实工具管线 | 8/8 |
| 单元与集成 | core 38 项、browser 67 项、client 4 项、native 20 项 | 通过 |
| 直达工具面 | `browser_navigate` / `browser_tabs` 已通过真实 agent 调用；`browser_upload`、`browser_downloads` 由单测覆盖 | 通过 |
| 运行可见性 | 受控标签页标题前缀 + 图标角标（跨导航保持、结束清除）；原生与可见浏览器运行的菜单栏 `◉ DSH-CU` 项，带“停止”菜单 | 通过 |
| 客户端集成 | `@alyosha28/dsh-cu-client` 的 `tool.call.toolview` 卡片在真实 `dsh web` 会话中渲染：`标签页 · 完成 · 1 个标签页`（截图：`results/client-card.png`） | 通过 |
| 原生执行 | native 18/25；7 项失败原因均为 `accessibility_permission_required`（当前会话进程无辅助功能权限）；缺权限时会弹一次 macOS 授权对话框并在 doctor 中显示真实状态 | 环境受限 |
| 许可与变更记录 | `LICENSE`（MIT）、`CHANGELOG.md` 0.2.0 | 就绪 |

## 本轮关键修正

1. **运行时对齐**：应用实际运行 0.2.1-rc.5，而包原先依赖 0.2.2-alpha.2。Harness 的兼容性门禁会直接跳过不匹配的 bundle（`skipping profile bundle ... incompatible with dsh 0.2.1-rc.2`），此前插件根本无法进入应用。现在全部依赖、`engines.dsh`、cordis `~4.0.5`、loader/include 版本与应用一致。
2. **可安装的 bundle**：新增 `@alyosha28/dsh-cu-bundle`，只含一层 `cordis.patch.yml`，插入浏览器注册位、D1 浏览器 Provider、以及默认关闭的原生一对条目。
3. **装机自检**：`npm run plugin:doctor` 做组装级检查，不启动浏览器/模型；能识别未安装、被禁用、槽位冲突、版本错配四种失败。
4. **测试工具链**：`dsh-tool-testkit` / `dsh-tool-executor-native` 只有 0.2.2 版本，改为 `@alyosha28/dsh-cu-testkit`（直接调用生产工具注册表），24 个文件 60 处调用一次性切换。
5. **原生调用适配**：0.2.1 的 `tools.execute` 是单次调用（`callId/name/arguments/agent/signal`），替换掉 0.2.2 的批处理协议。
6. **浏览器可用性**：Playwright 自带浏览器缺失时回退本机 Chrome/Edge；两者都没有时返回 `browser_unavailable` 与恢复步骤，而不是把 Playwright 堆栈丢给模型。

## 复现

```bash
npm install --include=dev
npm run build
npm run test:plugin
DSH_BIN=./node_modules/.bin/dsh npm run plugin:doctor -- --profile=dsh-cu-install
DSH_CU_HEADLESS=1 ./node_modules/.bin/dsh --profile dsh-cu-install --json "Use browser_observe once and report the element count."
```

## 仍未覆盖

- DSH 客户端内的运行面板尚未接入；入口仍是控制页、macOS 预览面板与原生状态面板。
- 浏览器直达工具已覆盖导航、标签页与上传；下载、JavaScript 对话框尚未并入。
- 原生套件需要具备辅助功能与屏幕录制权限的终端才能完整复跑。
- 接管时的可见浏览器窗口没有纳入自动测试，测试只覆盖状态捕获与恢复。
