# Sigma 当前基线（AUDIT-001 / AUDIT-002 产物）

> 冻结时间：2026-11-08。所有数字来自实际命令，不是估计。
> 用途：给后续改动做对比基准；没有这份基线，「改好了」和「更早」（regression）无法区分。

## 版本与工作树

| 项 | 值 |
|---|---|
| 最后 commit | `f714ed1e`（2026-11-07 06:31）feat: 一页接入第三方 API + 未签名 IPA 构建 |
| 工作树状态 | **脏**：106 项未提交改动 |
| 说明 | 本基线记录的是「工作树」状态，不是 commit。这些改动尚未整体提交，部分已被 CI 编译过、部分是新的 |

## 构建基线

| 项 | 值 |
|---|---|
| 最近成功构建 | `42491733872` / `c92a2e4d` / **success** |
| 该构建包含 | 注入检测之前的一批（注入防线、任务表、Router **均未包含**） |
| 上一个成功包 | `/var/minis/attachments/Sigma-1.0.0-8.ipa`（`5822fce7`，119.7MB） |
| CI 失败/取消 | `42490885585`、`42490477648`（均为 cancelled，非编译错误） |

**关键缺口**：本基线之后的所有改动（注入检测、任务表、Router、场景 schema、trace 修正、通知契约修复）**从未经过 Xcode 编译**。Node 测试通过不等于 Swift 能编过。

## 引擎结构

| 项 | 数量 | 备注 |
|---|---|---|
| `runtime/` 模块 | 18 | 其中 6 个是本次新增：`flight-recorder` / `injection-guard` / `notice-admission` / `router` / `scene-schema` / `task-registry` |
| 插件 | 4 | `auto-guard` / `ios-host` / `sandbox-ios` / `subprocess-ios` |
| 技能目录 | 18 | `cost-guard` 下新增 `load-gate.mjs`；`evolve` 为新增 |
| 测试文件 | 25 | 本次新增 9 个 |

## 已验证的能力（有测试证据）

| 能力 | 证据 | 边界 |
|---|---|---|
| 任务状态机 | `test/task-registry.test.mjs` 13 项 | 单进程文件存储；多进程并发未验证 |
| Router 调度 | `test/router.test.mjs` 12 项 | `runTask` 未接真实 DSH session；并发上限默认 1 |
| 派单超时催办 | `test/dispatch-sentinel.test.mjs` 3 项 | 依赖 `sentinel.mjs` 台账 |
| 负载闸 | `test/load-gate.test.mjs` 5 项 | iSH 无 `MemAvailable`，回退 `os.freemem` |
| 注入检测 | `test/injection-guard.test.mjs` 7 项 | 只覆盖「工具返回文本」；输入侧未覆盖 |
| 记忆闭环 | `test/memory-integration.test.mjs` 6 项 | 只验证存储层；工具注册链路未验证 |
| 场景解析 | `test/scene-schema.test.mjs` | 解析逻辑；未接 `session/create` |
| 中断恢复 | `test/flight-recorder.test.mjs` 10 项 | 识别与通知；**不是任务级 checkpoint 恢复** |
| 通知字段契约 | `test/notice-contract.test.mjs` 4 项 | 引擎→App 单向 |

## 未验证 / 未知（不得当成已支持）

1. **Swift 编译**：`Timeline.markInterrupted`、`SessionModel.configureInterruptedState`、`AppModel.InterruptedSession` 全部未编译。
2. **DSH 并行语义**：只有一个 Node Worker；多个 session 是否真并行、是否互相阻塞，未实测。
3. **事件来源是否真接通**：`Timeline` 认识 `webhook`/`schedule`/`team-message` 等类型，只证明 UI 能显示，未证明订阅存在。
4. **meow-memory 工具层**：存储层已验证，但 `apply()` 注册的 7 个工具在真实引擎里是否可用未验证（`apply` 依赖完整 cordis 服务树，单测跑不起来）。
5. **iOS 后台**：`BackgroundKeeper` 存在，但 App 被挂起/杀死后无法保证运行；不构成 24/7 常驻。
6. **多进程写入**：所有 store 都是单文件 + 原子 rename，无锁；多 Worker 并发写会互相覆盖。

## 已知缺陷（按文档优先级）

| 编号 | 问题 | 状态 |
|---|---|---|
| P0 | `auto-guard` 曾用 `process.parentPort`（永远 undefined），提醒全部静默丢失 | 已修，有负向验证 |
| P0 | `/proc/meminfo` 无 `MemAvailable` 时退到 `MemFree`，导致 97% 假警报 | 已修，有负向验证 |
| P0 | `reportInterrupted` 写失败仍清空记录，丢弃唯一中断证据 | 已修 |
| P0 | `notice-admission` 白名单漏掉 `interrupted`/`injection`，功能被自己挡死 | 已修 |
| P0 | `main.mjs` 把 `kind` 写死 `notice`、字段塞进 detail，Swift 永远读不到 | 已修 |
| P1 | trace 跨轮污染 + assistant 文本取错路径 + 成功判定过宽 | 已修 |
| P1 | `ack()` 声明幂等但实现删除条目 | 已修 |
| P2 | trace 无文件体积上限 / 保留期 | **未做** |
| P2 | App 未按 `eventId` 去重（靠行号，重投会重复弹） | **未做** |

## 性能基线（BENCH-001 实测）

`node runtime/bench.mjs --tasks 100`，iSH / iPhone 实测：

| 项目 | 中位数 | 单任务成本 |
|---|---|---|
| 任务生命周期（建表+流转+落盘） | 55 ms / 100 个 | 550 µs |
| 任务建表（纯内存） | 16.6 ms / 100 个 | 166 µs |
| 幂等去重（全重复事件） | 2.5 ms / 100 个 | 25 µs |
| 并发调度 20 个（max=1） | 362 ms | — |
| 并发调度 20 个（max=4） | 179 ms | — |

**已暴露的扩展性问题**：并发 4 只比并发 1 快 2 倍，不是 4 倍。根因是每次任务状态变化都
全量 `load()` + `save()` 整个 `tasks.json`——那部分是串行的，并发越多反而越多重复 IO。
任务上到几千个时会明显退化。修法是按任务分文件 + 索引，或改 append-only 日志 + 定期压缩；
**当前未修**，因为现在就改会让状态机测试全部重写，等任务量真的上来再做。

**不能宣称的**：以上只是本进程文件 IO 与调度开销。真实 DSH session 并发、网络、
模型响应耗时都不在其中。用它说「端到端更快」是错的。

## Phase 1/2 缺口补齐记录（2026-11-08 追加）

| 文档要求 | 产物 | 测试 |
|---|---|---|
| 经验提炼/回滚工具 | `skills/evolve/skill-revoke.mjs`（软撤销 + 恢复 + 审计） | `test/skill-revoke.test.mjs` 8 项 |
| 磁盘满故障注入 | save 失败必须抛错、不留半成品 | `test/fault-injection.test.mjs` 3 项 |
| 取消传播 | `Router.cancel()`；结果回写前检查，取消优先于结果 | 同上 4 项 |

取消语义：running 任务取消后，**慢半拍的 worker 成功结果不再回写**——否则取消是装饰。
恢复 ≠ 重新验证（restore 后 verified 仍为 false，需人工再确认）。

## 测试基线（全量）

- 本批测试文件：**28 个**，覆盖任务状态机 / Router / 场景 / 记忆 / 注入 / 负载 / 派单 / 中断 / 通知契约 / trace / 撤销 / 故障注入
- 环境固有失败（与本批改动无关，缺 `just-bash`/`sharp`/`@deepseek-ai/dsh-subprocess` 依赖）：`child-process` / `direct` / `git` / `ios-environment` / `sharp` / `subprocess-ios` 共 6 个文件
- 必须串行执行：`node --test --test-concurrency=1`，并行时 Node 抢内存会假失败

## 复现命令

```sh
cd engine
node --test --test-concurrency=1 test/*.test.mjs      # 必须串行：并行时 Node 抢内存会假失败
node skills/cost-guard/load-gate.mjs                   # 当前负载判定
node runtime/task-registry.mjs list                    # 任务表
node runtime/scene-schema.mjs check <工作区>            # 场景解析
```

## 结论

当前状态：**单设备可用的调度地基 + 安全防线**，不具备 Router/Worker 的真实多任务执行、外部事件接入和任务级恢复。
距离官方 Super-agent 的差距主要在：真实并行（未验证）、多信道（无）、任务级 checkpoint（无）、外部 watchdog（无）。
