# 可见控制与无中断执行验收

日期：2026-10-30

## 执行路径

- Browser 可见启动模式使用后台 Chrome 与非激活 macOS 预览面板。面板持续显示受控标签页画面、44×44 矢量软件光标、当前动作和暂停/停止/接管控件。
- Browser attach 模式通过 Chrome DevTools 隔离世界在受控标签页显示软件光标和控件。
- Native 动态执行与零模型 Skill 回放共用非激活 `NSPanel` 光标和状态面板，光标跟随授权窗口及实际动作坐标。
- 两条 Native 路径共用 `executeNative`；两条 Browser 路径共用 `BrowserDom.execute`，活动事件由执行适配器产生。
- `stopped_by_user`、`indicator_unavailable`、`human_takeover`、`takeover_detected` 与 `foreground_required` 使用独立结构化原因。

## 已通过检查

| 范围 | 结果 |
| --- | ---: |
| Core 单元与合同测试 | 33/33 |
| Browser 单元与真实工具管线测试 | 43/43 |
| Native 单元与真实工具管线测试 | 24/24 |
| Python 决策与验收测试 | 36/36 |
| Browser 光标、控件、导航与清理专项 | 通过 |
| Browser 实时预览、前台、系统指针、控件与断连专项 | 通过 |
| Native 窗口、光标坐标、控件、前台与断连专项 | 通过 |
| Native 动态与 Skill 执行期间持续前台输入 | 通过 |
| TextEdit 与 Calculator 真实矩阵（第 4 轮） | 9/9 |
| 下载应用与隐私矩阵（第 4 轮） | 5/5 |
| Impeccable 指针设计检测 | 无发现 |

真实矩阵原始证据：

- `results/real-apps/round-4.json`
- `results/third-party/round-4.json`

持续输入用例位于 `packages/dsh-computer-use-d1/tests/provider.spec.ts`。动态路径和 Skill 路径各执行两次目标动作，独立前台文本框累计接收六十个字符；二十毫秒前台监视只记录参照应用。

## 光标视觉与坐标

- Browser 与 Native 使用一致的圆角钴蓝箭体、白色内线、分离式热点和单圈点击涟漪。44×44 矢量图形置于 52×52 透明画布，完整保留圆环和描边。
- 明暗背景截图和 Native 矢量位图均已实际检查。
- 真实动作热点位于透明画布 `(10, 9)`，Native 窗口断言使用同一偏移；可见图形内部的相对坐标保持 `(6, 5)`。
- 光标层忽略真实鼠标事件并排除模型屏幕采集；控制按钮通过真实 Accessibility `AXPress` 验收。

## 生命周期

以下路径均已覆盖：正常完成、主动停止、显式接管、辅助进程强制退出、Browser 导航后重建、心跳与资源释放。异常退出撤销输入并清除窗口，不使用残留光标表示已结束任务。

## 边界

- Browser 可见启动模式显示受控标签页的实时预览，后台 Chrome 不创建操作系统窗口。
- Native 后台能力取决于目标应用和动作。需要前台的动作返回 `foreground_required`，不自动激活应用。
- 用户在受控 Native 窗口输入时返回 `takeover_detected` 并暂停自动化。
- 本轮结论限于已执行场景，不扩展到未测应用或无人值守生产环境。
