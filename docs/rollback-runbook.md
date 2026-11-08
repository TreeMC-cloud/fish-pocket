# 逐票回滚方案与验收数字

> 对应 `super-agent-v2-architecture.md` §9「每个 ticket 必须有：目标、非目标、改动文件、数据迁移、失败语义、测试、回滚方案、验收数字」。
>
> 本文补齐其中**回滚方案**与**验收数字**两项。目标/非目标/改动文件见各模块文件头注释。

## 通用回滚原则

1. **所有新增模块都是独立的**：删掉对应文件、移除 import 即回到旧行为。没有跨模块的隐式依赖。
2. **数据文件独立**：`.tasks.json` / `.in-flight.json` / `.trace.jsonl` / `.skill-stats.json` 各自独立，删掉任何一个只会丢失该项能力的历史，不影响 App 启动。
3. **有版本号的数据文件**：`.tasks.json` 带 `schemaVersion`，降级安装会**拒绝加载**（不是静默按旧格式读），需手动备份后删除。

---

## RECOVERY-001/002 · 中断恢复

| 项 | 内容 |
|---|---|
| 改动文件 | `runtime/flight-recorder.mjs`、`plugins/auto-guard/index.mjs`、`main.mjs` |
| 数据 | `in-flight.json` |
| **回滚** | 删除 `in-flight.json`；从 `auto-guard` 移除 `inFlight` 相关调用；`main.mjs` 移除 `reportInterrupted` 调用。App 立即恢复为「重启后无提示」的原行为 |
| **验收数字** | 写失败时记录保留率 100%（测试 `写完通知失败时必须保留记录`）；重复启动不重复提示（第 2 次启动发现 0 条） |

## TRACE-001/002 · 经验记录与脱敏

| 项 | 内容 |
|---|---|
| 改动文件 | `plugins/auto-guard/index.mjs`（`onTurnEnd` / `appendJsonlBounded`）、`skills/evolve/trace.mjs` |
| 数据 | `.trace.jsonl`（上限 2MB，超出轮转 `.1`） |
| **回滚** | 删除 `.trace.jsonl*`；移除 `onTurnEnd` 里的 trace 写入。进化能力失效，其它不受影响 |
| **验收数字** | 跨轮污染 0 例（测试 `只记录本轮`）；凭证脱敏覆盖 4 类（sk-/AKIA/Bearer/URL token）；`aborted/interrupted/max-tokens/quota` 均判失败，未知返回 `null` |

## TASK-001 · 任务状态机

| 项 | 内容 |
|---|---|
| 改动文件 | `runtime/task-registry.mjs` |
| 数据 | `.tasks.json`（**带 schemaVersion**，升级/降级都要管） |
| **回滚** | 停止调用 `Router` 即可；`.tasks.json` 可整个删除（会丢任务历史，不影响启动）。**降级安装时 `load()` 会抛错**，需先备份再删 |
| **验收数字** | 幂等去重 25µs/次（bench）；同 `source:eventId` 重投只建 1 个任务；非法转移 100% 拒绝；写盘无残留临时文件 |
| **数据迁移** | v1 为当前版本。旧文件无 `schemaVersion` 按 v1 读；版本更高则拒绝加载并提示备份 |

## TASK-002 · Router

| 项 | 内容 |
|---|---|
| 改动文件 | `runtime/router.mjs`、`runtime/delivery-gate.mjs` |
| 数据 | 复用 `.tasks.json` |
| **回滚** | 把 `runTask` 换回旧的直接执行；Router 不参与即恢复 |
| **验收数字** | 并发峰值 ≤ `maxConcurrent`（实测 2/2）；失败任务 0 次自动回队列；取消后慢结果 0 次覆盖（测试 `取消 running 任务后，结果不再回写`）；租约过期 ≥1 秒即被 sweep 捕获 |

## SCENE-001 · 场景解析

| 项 | 内容 |
|---|---|
| 改动文件 | `runtime/scene-schema.mjs` |
| 数据 | 各工作区的 `.scene.json`（**只读，不自动创建**） |
| **回滚** | 删除 `scene-schema.mjs`；不调用 `resolveScene` 即恢复旧的单场景行为 |
| **验收数字** | 5 种解析路径全覆盖；绑定与文件冲突判 `mismatch`（不静默选一个）；无配置判 `ambiguous`（不静默用默认） |

## MEMORY-001 · 记忆

| 项 | 内容 |
|---|---|
| 改动文件 | `test/memory-integration.test.mjs`（只加测试，未改实现） |
| 数据 | `.dsh-meow/`（SQLite） |
| **回滚** | 无需回滚（未改实现）。要清空记忆：删除工作区下的 `.dsh-meow/` |
| **验收数字** | 写入→读回 100%；关库重开仍在；不同工作区互相隔离；七层各自独立 |

## Phase 4 · 技能版本与健康度

| 项 | 内容 |
|---|---|
| 改动文件 | `runtime/skill-registry.mjs`、`runtime/skill-stats.mjs`、`runtime/dream.mjs`、`runtime/skill-eval.mjs`、`runtime/evolve-cli.mjs`、18 个 `SKILL.md` 的 frontmatter |
| 数据 | `.skill-stats.json`（上限 200 技能）、`.dream-state.json`、`.dream-audit.jsonl`、`.dream.lock` |
| **回滚** | 删除这些模块与数据文件；从 `SKILL.md` 移除 `version`/`source`/`permissions`（`validateMeta` 对缺失只警告，不阻断）。Dream 停止后只是不再自动整理，已有候选不受影响 |
| **验收数字** | 18 个技能元数据 0 错误 0 警告；检索评测 9/9 通过；`insufficient-data` 阈值 5 次；降级阈值失败率 ≥40%；`evolved` 无溯源 100% 拒绝；Dream 并发锁 1 个；预算上限 200 条/次 |

### Dream 机制（run 时对齐 Phase 4 要求）

| 要求 | 实现 | 验证 |
|---|---|---|
| 预算 | 单次最多处理 200 条 trace | 测试「预算生效：只处理最近 N 条」 |
| 锁 | `.dream.lock`，10 分钟未释放视为僵死可抢占 | 测试「锁过期可被抢占」 |
| 审计 | 每次整理写 `.dream-audit.jsonl` | 测试「写审计」 |
| 只改候选库 | `verified` 恒为 false，绝不自动激活 | 测试「绝不能自动 verified」 |
| 取消 | 异常时 finally 释放锁 | 测试「整理失败也要释放锁」 |
| **聚类** | 标签 Jaccard + 中文短语变体，贪心聚簇 | 测试「标签相近的两条会聚成一簇」 |
| **成功率门槛** | 簇内 ≥3 条、成功率 ≥60%、必须有成功样本 | 测试「全失败不出技能」「成功率低于 60% 不提炼」 |
| **落库可检索** | 产出写入记忆库（`procedural`），不再只返回数组 | 测试「必须落库，不能只返回」 |

**判据移植自服务器项目 `memory_core.mjs::consolidate()`**，因为它的门槛比原版严：
原版只卡「失败占比 ≥30%」，一个成功率 0% 的簇也会产出"技能"——那是在把错误做法固化成经验。

**已知局限**：关键词检索 ≠ 模型真的会想起来用。评测只能筛出「描述里压根没提这件事」的明显问题，不能证明模型一定会调用。

## 明确未做的（避免误判为已完成）

| 项 | 状态 | 原因 |
|---|---|---|
| Phase 3 独立 Hub | ❌ | 需常驻服务器；客户机器不可用 |
| Dream 定时触发 | ⚠️ 半 | 判定与执行已完成，但**没有常驻定时器**——iOS 上只能挂在每轮对话时检查，或手动 `evolve-cli.mjs run` |
| 多信道事件接入 | ❌ | 需 Hub 接收公网 webhook |
| 失败率自动降级 | ⚠️ 半 | 判定完成，动作保持人工确认（自动撤销比留着不太准的更危险） |
| 外部 watchdog | ❌ | 进程内 `sweep()` 已够单机用，跨进程需 Hub |

**注意**：Phase 4 的可离线部分（版本、权限、健康度、Dream、检索评测、冲突检测）已全部完成并有测试覆盖。真正缺的是**长期运行数据**——trace 库现在为空，Dream 和健康度要等 App 跑一段时间才有多样本可看。
