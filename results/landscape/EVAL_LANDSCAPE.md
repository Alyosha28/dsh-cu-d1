# CU/BU Agent 评测：行业现状与诚实套件清单

本仓库 `scenarios.json` 仅 3 条 workflow / 15 个 case（11 success、2 blocked、2 escalated）。差距不在任务数，而在判定独立性、负向覆盖、重复运行与成本记账。

## Web 基准

- **WebArena** — 812 任务；6 个自托管站点；程序化 functional correctness（locator/DB/API 读状态）；task success；human 78.24%，GPT-4 14.41%。批评：站点冻结、可被针对性调优，脚本与版本强耦合。[2307.13854](https://arxiv.org/abs/2307.13854)
- **VisualWebArena** — 910 任务；3 个自托管视觉站点；图像级程序化判定；human 88.7%，最佳 VLM 16.4%。批评：任务偏合成、站点少。[2401.13649](https://arxiv.org/abs/2401.13649)
- **WebVoyager** — 643 任务、15 个真实站点；GPT-4V 看全轨迹打二值，与人工一致率 85.3%（300 子集，人工间 kappa 0.7）；得分 59.1%。批评：judge 非状态验证、站点漂移、答案站内可搜到。[2401.13919](https://arxiv.org/abs/2401.13919)
- **Mind2Web** — 2,000+ 任务、137 站点；离线静态快照；元素/动作匹配（step accuracy），不执行不验状态。批评：离线正确 ≠ 完成，快照易进训练集。[2306.06070](https://arxiv.org/abs/2306.06070)
- **Mind2Web 2** — 130 任务、实时 Web、1,000+ 人工小时；Agent-as-a-Judge（树状 rubric，评答案与引用）；最佳达人类 50–70%。批评：任务少、judge 贵且有方差。[2506.21506](https://arxiv.org/abs/2506.21506)
- **WebLINX** — 2,300 演示 / 100K 交互、150+ 站点；离线多轮下一动作预测，不执行。批评：离线指标失真；微调模型对未见站点泛化差。[2402.05930](https://arxiv.org/abs/2402.05930)
- **BrowserGym** — 统一 observation/action 的生态（含 AgentLab），首次实验横跨 6 个基准。价值在可比性与轨迹管理；本身不定义任务。[2412.05467](https://arxiv.org/abs/2412.05467)
- **AssistantBench** — 214 任务、258 站 / 525 页；开放 Web 答案匹配；最佳不到 26 分，纯 agent 近 0。批评：答案中心、无 UI 状态验证，未见正式 human 基线 `[未核实]`。[2407.15711](https://arxiv.org/abs/2407.15711)
- **Online-Mind2Web** — 300 任务、136 在线站点；人工评测为准 + WebJudge（一致率约 85%）；前沿 agent 仅 20–30%，远低于旧榜。批评：在线漂移、仍需 judge、样本小。[2504.01382](https://arxiv.org/abs/2504.01382)

## 桌面 / OS 基准

- **OSWorld** — 369 任务；Ubuntu/Windows/macOS 真 VM；逐任务 Python 执行脚本验最终状态；human 72.36%。批评：脚本近乎逐题定制（约 1,800 人时）、VM 贵、镜像漂移使分数不可比。[2404.07972](https://arxiv.org/abs/2404.07972)
- **WindowsAgentArena** — 150+（常引 154）任务；Win11 VM，Azure 并行全套约 20 分钟；程序化检查；human 74.5%，Navi 19.5%。批评：仅 Windows、任务少、依赖云配额。[2409.08264](https://arxiv.org/abs/2409.08264)
- **ScreenSpot** — 移动/桌面/Web grounding；约 1,200 指令 / 600 图 `[未核实]`；点击落框率，不执行任务。批评：单步、偏简单、标注有歧义。[2401.10935](https://arxiv.org/abs/2401.10935)
- **ScreenSpot-Pro** — 1,581 指令-图；23 个专业应用、5 行业、3 OS；grounding accuracy；零样本最佳 18.9%，ScreenSeekeR 48.1%。批评：grounding ≠ 任务成功，小目标与缩放敏感。[2504.07981](https://arxiv.org/abs/2504.07981)
- **AndroidWorld** — 116 程序化任务、20 个 App；模拟器；按系统状态（JSON/SQLite）判成功，任务动态生成；human 80.0%，最佳 30.6%。批评：仅模拟器；措辞变化显著影响分数。[2405.14573](https://arxiv.org/abs/2405.14573)
- **AndroidLab** — 138 任务、9 个 App；预定义 AVD；程序化检查；开源模型 4.59%→21.50%（LLM）、1.93%→13.28%（LMM）。批评：App 少、偏训练框架。[2410.24024](https://arxiv.org/abs/2410.24024)
- **WindowsAgentBench** — 未找到可信论文/官网/代码，疑与 WindowsAgentArena 混淆，不应单独引用 `[未核实]`。

## 评测方法论问题

- **判定三档**：精确匹配最便宜但只适合短答案；程序化状态检查最可信但需逐题写脚本；LLM judge 最省人力也最易虚高。
- **judge 虚高有实测**：Online-Mind2Web 对人工，GPT-4o(a11y tree) 平均高估 8.1pp、rule-based 9.8pp、WebJudge 仍差 5.9–10.5pp；WebVoyager 85.3% 一致率即约 15% 误判。
- **judge 偏差**：位置/冗长/自我偏好（[MT-Bench](https://arxiv.org/abs/2306.05685)）；看轨迹时倾向"看起来做了"而非状态真变了。
- **human 基线**：WebArena 78.24、VWA 88.7、OSWorld 72.36、WAA 74.5、AndroidWorld 80.0；AssistantBench 无 `[未核实]`；Mind2Web 2 仅报相对值。
- **成本/时间**：OSWorld 构建约 1,800 人时；Operator 步数为人类 2.6×、单任务可达 44 分钟；多数论文不报 $/task 与人工介入次数。
- **方差**：AndroidWorld 显示任务改写显著改分；temperature=0 仍有随机性；榜单多只报单次/最好成绩。
- **污染/泄漏**：WebVoyager 答案站内可搜且站点漂移；Mind2Web/WebLINX 快照可进预训练；WebArena 冻结副本可被调优；几乎无 held-out 站点划分。

## 生产环境的可靠性工程

- **重试/幂等**：写操作带 idempotency key（Stripe 保留 24h），指数退避 + jitter，按业务键去重。[Stripe](https://docs.stripe.com/api/idempotent_requests) · [AWS](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
- **恰好一次**：严格 exactly-once 不存在；工程上是 at-least-once + 幂等接收端 + 去重表/outbox，即 effectively-once。
- **陈旧观测**：动作前重新取快照；Playwright actionability（visible/stable/enabled/receives events）是下限；元素引用带版本，过期即拒。[actionability](https://playwright.dev/docs/actionability)
- **checkpoint/resume**：持久化执行（Temporal event history 重放）、图状态 checkpoint 与中断恢复、失败补偿。[Temporal](https://docs.temporal.io/evaluate/understanding-temporal) · [LangGraph](https://docs.langchain.com/oss/python/langgraph/persistence)
- **轨迹取证**：每步留截图、DOM/ARIA 快照、动作、观测哈希、判定输出；Trace Viewer 可离线回放。[Trace](https://playwright.dev/docs/trace-viewer) · [OTel GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- **护栏**：域名/App 白名单、VM 隔离、凭据闸门、破坏性动作默认拒绝、步数与费用预算、kill switch；威胁模型对照 [OWASP Agentic](https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/)。
- **审批 UX**：副作用动作前展示 diff/预览再确认，提供接管与暂停，超时默认拒绝，全程审计。[HAX](https://www.microsoft.com/en-us/haxtoolkit/) · [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)

## 一个诚实的评测套件需要什么

1. **独立后置条件验证**：读 DOM/DB/文件/API 的最终状态，不信自报与"看起来对"。
2. **负向对照**：no-op、缺凭据、歧义目标、越权、重复提交，要求"正确地不做"。
3. **重复运行**：每任务 ≥3 次，报均值、标准差、置信区间，禁止只报最好一次。
4. **判定器校准**：程序化优先；用 LLM judge 必须与人工子集比对并公开一致率。
5. **人工基线**：同任务、同环境、同判定下测人类，否则分数无法解释。
6. **成本/延迟记账**：$/task、token、步数、墙钟、人工介入次数全部入表。
7. **held-out 站点/应用**：调参与评测分离，至少留一组没见过的站点或 App。
8. **污染与漂移控制**：锁定镜像/站点版本与日期，检查答案能否被直接搜到。
9. **可重置可复现**：独立初始状态、幂等 teardown、固定 seed 与镜像 digest，失败可单题重跑。
10. **轨迹与证据留存**：截图、DOM 快照、动作日志、判定输出归档，失败可回放。
11. **安全维度单列**：越权、破坏性动作、凭据、审批时延与误批率，不并入成功率。
12. **公开失败清单**：报已知缺口、失败模式与负结果，而不是只报一个好看的数字。
