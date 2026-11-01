# 原生执行层红队 PoC

只读 `packages/**` 与 `src/**`；所有脚本只写本目录与 `out/`（以及 `baseline.sh` 会临时创建并删除
`/tmp/dsh-official-alpha2` 软链、产品自己创建的 helper 缓存）。

## 运行

```bash
# 全部 PoC（无 GUI、无辅助功能授权即可跑，约 3 秒）
cd redteam/poc/native
../../../node_modules/.bin/vitest run --config vitest.config.ts

# NR-07 基线复现（会跑产品测试 + 编译一次真 helper 做负向对照，约 40 秒）
bash baseline.sh
```

`baseline.sh` 输出：`out/baseline-test.log`（7 红）、`out/negative-control.log`（helper 就位后的
`accessibility_permission_required` 对照）、`out/axprobe`（本机权限探测）。

## 文件

| 文件 | 对应发现 | 依赖 |
| --- | --- | --- |
| `nr01-skill-scope-approval.spec.ts` | NR-01 Skill 作用域/审批 | 纯内存假 caller |
| `nr02-indicator-lifecycle.spec.ts` | NR-02 指示器失联、NR-08 可用性 | `fixtures/fake-indicator.mjs`（协议对端，node 脚本） |
| `nr03-native-geometry.spec.ts` | NR-03 坐标/光标 | 纯内存假 caller |
| `nr04-verification-fake-positive.spec.ts` | NR-04 验证假阳性 | 纯函数 + 假 caller |
| `nr05-verification-registry.spec.ts` | NR-05 custom 断言信任 | 纯内存 |
| `nr06-helper-cache.spec.ts` | NR-06 helper 缓存 | 需要 `swiftc`（编译一次探针，约 1s） |
| `nr09-nr10-permissions-pending.spec.ts` | NR-09 TCC 身份、NR-10 pending 启发式 | `nr09` 需要 `swiftc` |
| `fakes.ts` | 共用假 `NativeCaller` / observation 构造 | — |

## 注意事项

- `fakes.ts` 里的假 caller 记录每一次 `cua` 调用，断言直接比对**实际派发参数**，不依赖内部状态。
- `nr02` 的协议对端刻意复刻 `ControlIndicator.swift` 的行为（`dismiss` 只清本地状态、不发事件），
  因此它证明的是**协议状态机**缺陷，而不是「假 helper 写错了」。
- `nr06` 会在 `$TMPDIR/dsh-cu-helper-cache` 下创建 `RedTeamProbeNr06*` 目录并在 `afterEach` 删除；
  若中途 kill，请手动删除这些目录。
- `nr06`/`nr09` 需要 `swiftc`；缺失时这两条会失败，属环境不可用，不代表发现失效。
