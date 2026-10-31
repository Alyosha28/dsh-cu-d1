# DSH 插件级验收记录

日期：2026-10-31

## 目的

前一轮体验优化只用包内单元测试验证。这一轮先回答一个问题：**把 Provider 当作真正的 DSH 插件装载时，它还能不能注册、被调用、返回正确结果。** 只有这条链路成立，后续优化才有意义。

## 方法

`npm run test:plugin`（`scripts/plugin-dsh.mts`）在本地 DSH 运行时里做以下事情：

1. 用 `@deepseek-ai/cordis-plugin-loader` + `cordis:include` 装载一个 `cordis.yml`，与 DSH profile 装载插件的机制一致。
2. 条目指向**构建产物** `packages/dsh-browser-use-d1/dist/index.js`，不是 `src`，因此验证的是发布形态。
3. 同时挂载 Provider 声明的真实服务：`browserUse`、`tools`、`systemPrompt`、`agents`、`sessions`、`llm`、`agent-loop`、`session-projection`、`fs`、`workingDirectory`、`toolExecutor`。
4. 用 `executeToolFixture` 走真实工具执行管线，浏览器为无头 Chromium，页面为回环 fixture。不创建可见窗口、不触碰用户已有的浏览器或应用。

## 结果

```
PASS  plugin entry imports
PASS  browser-use provider registered — d1-system-one
PASS  tools registered — d1_browser_subgoal, browser_observe, browser_extract, browser_navigate, browser_tabs, browser_control, browser_skill_publish
PASS  browser_extract reads a real page — {"heading":"Book a flight","search":"Search flights","from":""}
PASS  blank field reported as empty, not missing
PASS  browser_observe reads the owned page — 5 elements at http://127.0.0.1:.../flights.html
PASS  browser_control returns a page token URL — http://127.0.0.1:...#token=<page-token>
PASS  invalid config fails closed — captureSkills without skillStorePath

8/8 plugin checks passed
```

机器可读结果：`results/PLUGIN_DSH_TEST.json`。

## 发现并修复的问题

插件级调用暴露了一个单元测试没有覆盖的语义错误：

- `browser_extract` 把“元素存在但值为空”当成 `missing`。航班 fixture 的 `From` 输入框存在且为空，工具却返回 `blocked / extract_field_missing`，调用方无法区分“没有这个元素”和“元素在这里、值是空的”。
- 修复后：`string` 字段的空值返回 `""` 并列入 `empty`；`number`、`boolean`、`url` 字段的空值按 `empty_value` 拒绝；元素不存在仍然进入 `missing`，必填缺失仍然 `blocked`。
- 证据字段新增 `empty: true`，结果新增 `empty: [...]` 和 `reason: extracted_with_empty_fields`。
- 回归测试：`packages/dsh-browser-use-d1/tests/extract.spec.ts` 增加 2 项（空字符串成功、空值拒绝转数字），原“空值算缺失”的断言改为“缺失与空值分开”。

## 本轮同时完成的优化

插件测试通过后，继续按上一轮遗留清单做了两项改动：

1. **提取语义**：空值不再算缺失（见上）。`string` 返回 `""` 并进入 `empty`，非字符串类型以 `empty_value` 拒绝。
2. **接管状态转移**：启动模式接管时保留 Session Storage、滚动位置和已输入的表单值（Cookie 与 Local Storage 仍由 `storageState` 负责）。字段按 id、唯一 name、最后才是位置匹配，并且要求标签与类型一致；页面结构变化时不会把值写进别的控件。

回归结果：

- Core：9 个文件 38 项通过。
- Browser：10 个文件 51 项通过（新增 `tests/takeover.spec.ts` 4 项、extract 2 项）。
- Native：17 项通过、7 项失败，失败原因全部是 `accessibility_permission_required`。当前 DSH 会话进程没有 macOS 辅助功能权限，属于运行环境限制，与本轮改动无关；需要在有权限的终端里复跑才能得到原生套件的完整结果。

## 运行时对齐（2026-10-31 追加）

第一次插件测试用的是本机 `dsh` CLI `0.2.1-rc.2`，插件依赖 `0.2.2-alpha.2`，启动停在 `1 required plugin did not activate`。后续查明：

- 桌面应用实际是 `@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.5**（asar 内 `dsh-agent`、`dsh-tools`、`app-boot` 均为 0.2.1-rc.5，cordis 4.0.5）。
- Harness 有兼容性门禁：bundle 的 `engines.dsh` 或 `@deepseek-ai/dsh*` peer 不满足运行版本时，直接 `skipping profile bundle`，插件不会加载。

因此把全部依赖、peer、`engines.dsh`、loader/include 版本对齐到 0.2.1-rc.5，并把测试工具链换成 `@albaincompleta/dsh-cu-testkit`（0.2.1 只有单次 `tools.execute`）。之后：

- `dsh plugin --profile dsh-cu-install add link:...` + `@albaincompleta/dsh-cu-bundle` 进 `bundles` → `--dump-config` 出现两个插件条目，无 skip。
- `dsh --profile dsh-cu-install --json "ok"` → 完整跑完一轮。
- `DSH_CU_HEADLESS=1 dsh ... "Use browser_observe once"` → 模型真的调用 `browser_observe`，返回 `status: success`。
- `npm run plugin:doctor -- --profile=dsh-cu-install` → 全部 PASS。

## 边界与未覆盖

- 原生套件的 7 项失败均为 `accessibility_permission_required`：当前 DSH 会话进程没有 macOS 辅助功能权限，需要在有权限的终端复跑。
- 可见预览面板与原生指示器未在本轮插件测试中启动（避免打断用户界面）。
- 接管时的可见浏览器窗口仍未纳入自动测试。
- 未接入 DSH 客户端内运行面板。
