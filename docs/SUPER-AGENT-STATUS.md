# SUPER-AGENT 能力盘点（2026-11-09 · 只读核实）

> 这份文档回答一个问题：**六项目标能力，各自到哪了。**
>
> 判据只有三条，每条都必须可核查：
> **已实现**（代码存在，有测试）→ **已接入**（有运行时调用方，不是孤儿模块）→ **真机验证**（有证据表明在真机上跑通）。
> 本轮只读核实，未改任何引擎代码。所有结论后附「证据：路径:行号」或「测试名」；查不到证据的一律写「未核实」。
>
> 复现命令（仓库根目录）：
>
> - `ulimit -s 8192 && node engine/tools/scan-orphans.mjs`（孤儿扫描）
> - `ulimit -s 8192 && cd engine && node --test test/capability-wiring.test.mjs`（本次新增的接线钉子，8 项）
> - `ulimit -s 8192 && cd engine && sh test/run-all.sh`（全量测试；结果见 §六）

---

## 一、六项对照表

| # | 能力 | 状态 | 证据（路径:行号 / 测试名） | 已知缺口 |
|---|---|---|---|---|
| 1 | 稳定身份（Sigma/Σ 跨会话） | 已实现 · 已接入；真机：**旧逻辑有记录，新版更新路径未验证** | `engine/AGENTS.md:7`（"你是 Sigma"，符号 Σ）、`:152`（`<!-- BUNDLED:END -->` 结尾）；`engine/main.mjs:45-77`（按 BUNDLED:END 替换铁律段、保留标记之后的内容、无标记时先备份再覆盖）；`engine/skills/scene/scene.mjs:26-27`（SCENE 标记）；`docs/踩坑总表.md:65-71`（"配好的场景重启 App 后没了"→修复→"二次启动后场景段和铁律都在，SCENE:BEGIN 标记数量为 1"）；`engine/AGENTS.md:13`（2026-11-08 身份被环境覆盖的实测记录） | ① main.mjs 的安装分支没有直接测试（`engine/test/` 里没有覆盖 AGENTS.md 安装逻辑的用例）② 新版更新逻辑（BUNDLED:END 替换）没有真机记录——踩坑总表里的复验写在旧逻辑时期 ③ "身份靠每轮注入"的前提是注入链每轮真跑到，这只能在真机上看 |
| 2 | 持续记忆（meow-memory 七层） | 已实现 · 已接入；真机：**未验证（只有失败史）** | `engine/ios.patch.yml:71-87`（插件插入 + 七层映射 + dream 空闲整理配置）；`scripts/build-engine.sh:103-111`（剪枝放行 `*/prompts/*`——否则 prompt-loader 在模块初始化时 ENOENT，整层不激活）、`:134-156`（把 meow-memory 注入 dsh install anchor，否则 profile 侧 ERR_MODULE_NOT_FOUND）；`scripts/engine-smoke.mjs:90`（出包冒烟必检 meow-memory）；`engine/runtime/memory-store.mjs`（Dream 产出→记忆库适配，写 lesson 层）；`engine/runtime/dream.mjs`；触发点 `engine/plugins/auto-guard/index.mjs:847-862`；测试 `engine/test/memory-integration.test.mjs`（本次实跑通过）、`memory-store.test.mjs`（通过） | ① 工具层未验证（`docs/current-baseline.md:53`：存储层 OK，"apply() 注册的 7 个工具在真实引擎里是否可用未验证"）② Dream 落库目录与会话记忆库可能不是同一个（见 §三-3）③ dream/reflect 靠"用户在用"推进，App 挂起即停（机制注释自述） |
| 3 | 积累技能（可提炼、可撤销） | 已实现 · 已接入（自动记账；提升/撤销为人工 CLI，属设计） | 记账：`engine/plugins/auto-guard/index.mjs:1002-1026`（每轮 turn/end 写 `.trace.jsonl`，成功判定用白名单 `outcomeOf`）；候选文件三处同名 `.skill-candidates.jsonl`：`trace.mjs:28`、`promote.mjs:49-50`、`skill-revoke.mjs:22`；测试 `trace-accuracy.test.mjs`、`evolve-promote.test.mjs`（含"跨模块文件名一致"钉子，返回源码抽名字面量比对）、`skill-revoke.test.mjs`——本次实跑全部通过 | ① 候选表的唯一写入者是 `trace.mjs distill`（CLI，无自动调用方）；自动路径（Dream）走 `consolidate.distill` → 记忆库。两条路都活，但不是同一条 ② 候选 → SKILL.md 全人工（`promote.mjs` 头部注明是故意的减速带）③ 技能检索会不会读到 `evolved-*` 只能在真机验证 |
| 4 | 跨任务协调（队列/失败重排/并发/人工确认） | 已实现 · 已接入；真机：**未验证** | 状态机 `task-registry.mjs:47`（TRANSITIONS 白名单）`:210`（create）`:247`（transition）`:317`（gc）`:342`（expired）；Router `router.mjs:256`（起跑设 30 分钟租约）`:410-432`（sweep：收僵尸+gc）；编排 `auto-guard:316-416`（15 秒调度循环：drain→tick→flush，`INTERVAL_MS=15_000` 在 `:321`）、`:386`（task-control.drain）、`:388`（task-runner.tick）；投递 `task-runner.mjs:35`（makeRunTask，`agent.inject` + `source:{kind:'schedule'}`）`：96-109`（tick：先 sweep 再 execute）；每轮建任务 `task-tracking.mjs:61`（onTurnStart）`:110`（onTurnEnd，幂等键 `session:<id>:turn:<n>`）；人工入口 `task-control.mjs:79`（drain，App 落 `task-control/<id>.json`）；测试 `task-registry/router/task-tracking/task-runner/task-control/outbox-delivery/consecutive-failure/fault-injection.test.mjs`——本次实跑全部通过 | ① `Router.accept()` 无运行时调用方（全仓只有测试和 `bench.mjs:394` 在调）——外部事件（webhook/agent-message/审批）进不来（见 §三-2）② `Router.heartbeat()` 无运行时调用方——30 分钟租约不会续（见 §三-1）③ 真实会话投递（agent.inject）未真机验证；`docs/current-baseline.md:39` 记的"runTask 未接真实 DSH session"已过时（代码已接 agents），但同样没有真机记录 ④ 多进程并发未验证（baseline 自述） |
| 5 | 主动筛选事件（notice-admission） | 已实现 · 已接入；真机：**未验证** | 准入器 `notice-admission.mjs:21-63`（ALWAYS 不冷却 / THROTTLED 按会话冷却 / 其余只进日志）；宿主桥 `main.mjs:138`（创建准入器）`:163-187`（准入通过才写 `notices.jsonl`，顶层 kind/sessions/turns 字段契约）；投递 `auto-guard:650-676`（pendingOutbox 只投未 ack 的；notify 明确失败就不 ack）`:1261-1274`（parentPort；无宿主通道返回 false）；测试 `notice-admission.test.mjs`、`notice-contract.test.mjs`、`outbox-delivery.test.mjs`（含源级钉子 `:314`"main.mjs 收 dsh-ios/notice 并写 notices.jsonl"）、`auto-guard-notify.test.mjs`——本次实跑全部通过 | ① `scene_missing`/`scene_mismatch` 两类提醒被准入器静默丢弃（见 §三-4）② Swift 侧读取器未经 Xcode 编译（`docs/current-baseline.md:23`）③ 冷却窗口 10 分钟写死，没有配置入口 |
| 6 | 故障安全恢复（飞行记录 + 租约巡检） | 已实现 · 已接入；真机：**未验证** | `flight-recorder.mjs:61`（writeInFlight，原子写）`:74`（interruptedSince）`:127`（reportInterrupted：写失败不清空记录——旧实现会丢唯一证据）；启动报告 `main.mjs:146`；逐轮记录 `auto-guard:584-585`（turn/start 记在跑）`:908-913`（turn/end 销账）`:1040-1046`（最后一步摘要）；租约巡检 `router.mjs:410-432`；测试 `flight-recorder.test.mjs`（含"写完通知失败时必须保留记录"）、`flight-step.test.mjs`、`auto-guard-flight.test.mjs`、`fault-injection.test.mjs`（save 失败必须抛错、不留半成品）——本次实跑全部通过；`docs/rollback-runbook.md:22` 有验收数字 | ① 只识别+提示，不自动重跑（有意：有副作用的操作重来更危险）② 不是任务级 checkpoint 恢复（`docs/current-baseline.md:45` 自述）③ heartbeat 断裂 → 超过 30 分钟的任务会被误判中断（见 §三-1）④ 中断记录超过 24 小时不再提示（`STALE_MS`） |

---

## 二、点名核实的五件事（每条都有结论）

### 1. `engine/runtime/text-decoder.mjs` 有没有被调用？

**结论：没有。仍是零调用孤儿，而且依赖缺失——留着风险大于价值。**

- 孤儿扫描（`node engine/tools/scan-orphans.mjs`，本次运行）把它列为「真孤儿」之一：
  「真孤儿（3 个）：runtime/bench.mjs、runtime/text-decoder.mjs、smoke.mjs」。
- 它自己在文件头写明了原因（`text-decoder.mjs:1-18`）：解码要 `require('iconv-lite')`，
  而 `engine/package.json` 的 dependencies 里没有它、`engine/node_modules/` 里也没有（本次核实：`ls engine/node_modules | rg iconv` 无结果）。
- 现在调 `installTextDecoder()` 比不调更糟：原生 TextDecoder 至少抛清晰的 `ERR_ENCODING_NOT_SUPPORTED`，
  替换后会变成 `MODULE_NOT_FOUND`（文件头原话）。
- 影响：GBK 输入在引擎侧按 UTF-8 走，会失败——**已知限制**，不影响现有主流程（因为没人调用它）。
- 要真正启用：加依赖 → 在 `boot.mjs` 里跟 `installSegmenter` 一起装 → 补 small-icu 下的 GBK 测试（三步写在文件头）。

（另两个"真孤儿"是扫描器的盲区，不是断点：`smoke.mjs` 由 `scripts/build-engine.sh:182` 在构建时用 shell 调起；`bench.mjs` 是手动基准工具，跑法写在 `docs/BENCH-001-baseline.md:9`。真正"没人叫"的只有 text-decoder。）

### 2. `schedule-bridge.mjs` 的 `harvest` 还在不在？

**结论：已删除，且是正确删除。不会有重复投递。**

- 现在文件只导出 3 个只读函数：`isDue`（`:23`）、`toEvent`（`:38`）、`summarize`（`:64`）。全仓搜 `harvest` 只剩一处注释。
- 那处注释就是"为什么不能加回来"的证据：`auto-guard/index.mjs:352` 「⚠ 这里**不**去 harvest DSH 的定时任务」——DSH 的 schedule 自带投递循环，Router 再收一遍 = 同一任务执行两次，而且 `scheduledAt` 不推进会每 15 秒重复"到期"。
- 文件头（`schedule-bridge.mjs:1-20`）写明了判据：「判断某个来源该不该由 Router 接管，先看它有没有自己的执行者：有 → 只观察」。
- 本次新增回归钉子：`engine/test/capability-wiring.test.mjs`「schedule-bridge 只读——不导出会改变 schedule 状态的函数」（断言导出恰好是 isDue/summarize/toEvent）。

### 3. `gc`（任务表回收）有没有调用方？

**结论：有，且已在正确的位置——但它是最近才被接上的。**

- 定义：`task-registry.mjs:317`（回收已 ack 的 outbox + 超过 24 小时的终态任务 + 清理对应幂等键）。
- 调用方：`router.mjs:428`（`sweep()` 内）——router 里的注释自述「`gc()` 之前**没有任何调用方**，任务表只增不减」（`:426-427`）。
- 再往上一跳：`sweep()` ← `task-runner.tick()`（`task-runner.mjs:96-98`）← auto-guard 15 秒调度循环（`auto-guard:388`）。链条完整。
- 顺带说明：`engine/runtime/git/` 里的 `gc/maintenance/prune/fsck/repack` 是另一回事——git shim 直接 return 忽略（`git/index.mjs:110`），不在此列。

### 4. `promote.mjs` 和 `trace.mjs` 的候选文件名一致吗？

**结论：一致（都是 `.skill-candidates.jsonl`），而且有测试守着。**

- `trace.mjs:28`、`promote.mjs:49-50`、`skill-revoke.mjs:22` 三处同一个默认值 + 同一个 `DSH_CANDIDATES_FILE` 覆盖口。
- 测试：`engine/test/evolve-promote.test.mjs` 最后一条「distill 写出的候选文件，promote 必须能读到（跨模块文件名一致）」——从两个模块源码里抽名字面量比对，谁单改一边立刻红。
- 本次新增测试把这个钉子补全到第三个模块（skill-revoke 也在用同一张表）。

### 5.（附带）孤儿扫描的总结果

- 全树 97 个 `.mjs`：被引用 41 · 入口/技能/补丁 52 · 合法 CLI 1（`runtime/selfcheck.mjs`）· 真孤儿 3。
- 三类"孤儿"里只有 text-decoder 是断点；另外两个原因见上。
- 对比：任务队列五个模块（task-registry/task-tracking/router/task-runner/task-control）、notice-admission、flight-recorder、memory-store、dream、capability-status、skill-registry、skill-stats 全部**有非测试引用**——这次不是孤儿。

---

## 三、本轮核实中发现的仍然断裂的地方

以下 3、4、6 是本轮新发现的；1、2 是任务点名之外、但同性质且更隐蔽的新断裂（都已静态确证"没有调用方"）。

### 1.（新）`Router.heartbeat()` 没有运行时调用方 → 30 分钟租约不会续，长任务会被误判中断

- 租约起点：`router.mjs:256`，任务起跑时 `leaseUntil = now + 30 分钟`。
- 续期函数存在且有测试：`router.mjs:396-404`；但**全仓（排除测试）没有任何地方调用它**——本次核实 `rg '\.heartbeat\('` 结果只有 `engine/test/router.test.mjs:137,139`。
- 巡检判据：`task-registry.mjs:342`（`expired`：`running` 且 `leaseUntil < now`）；`router.sweep()`（`:410-432`）会把这种任务转成 `interrupted` 并**发一条"心跳超时"提醒**。
- 后果：任何一个真正跑超过 30 分钟的任务，在 15 秒调度循环里会被 sweep 抓成"中断"——明明还在跑。任务越重越容易踩。
- **但这不会真的发生**，因为 `runTask` 在 `agent.inject()` 之后就返回了（`task-runner.mjs`），
  任务活不过毫秒，根本到不了 30 分钟。心跳不续期在实践中不会造成误判。
- 反过来说，这里有个更值得修的问题：`runTask` 返回 `{ok:true}` 只代表**消息投递成功**，
  不代表那一轮做完了。所以任务表里的 `succeeded` 是"已投递"，不是"已完成"。
  已加 `deliveredOnly` 标记并在 App 里如实显示"已投递"。
- 结论：**heartbeat 不是当前需要修的东西**；真正的缺口是"任务结果与会话结果没打通"——
  会话那一轮的成败没有回写到任务表。要做完整需要 turn/end 时按 sessionId 找到对应任务，
  属于下一步。

### 2.（新）`Router.accept()` 没有运行时调用方 → 外部事件进不了任务队列

- `router.accept()`（`router.mjs:97`）是"事件→任务"的唯一入口，含两级准入、审批（await_approval）语义，且**只在测试和 `runtime/bench.mjs:394` 里被调**（本次核实，排除测试后全仓只剩 bench——bench 自己也是手动工具）。
- 现状：任务表里的任务只有两个来源——每轮对话（`task-tracking.onTurnStart`）和人工重排（`task-control`）。`schedule` 来源被有意挡在外面（见 §二-2），`webhook`/`agent-message`/`await_approval` 整条链在运行时**没有入口**。
- **但队列不是死的**：`Router.runnable()` 直接读 `tasks.json`，任何 `queued` 状态的任务都会被调度，
  不管是谁写进去的。实际闭环是：
  `用户点「重排」→ task-control 把状态改成 queued → 15 秒循环拾取 → agent.inject 进会话`。
  这条链有测试覆盖（`task-control.test.mjs` / `task-runner.test.mjs`），是通的。
- 真正缺的是**自动任务来源**：除了人工重排，没有别的东西往队列里放任务。
  iOS 上没有常驻的外部事件源（webhook / IM / 邮件都进不来），所以这一项目前只能是
  "失败重试队列"，不是"自主调度器"。`approve()` 无人调用同理——没有需要审批的入口。
- 顺带：`approve()` 全仓 0 处调用（连测试都没有）——审批通过没有消费者。

### 3.（新）Dream 落库的目录和会话读的记忆库可能不是同一个

- 事实链：
  1. `memory-store.mjs:108-112`：`workspaceFromEnv()` = `DSH_IOS_WORKSPACE || DSH_WORKSPACE || DSH_IOS_DATA || cwd`；
  2. 主进程没有设置前两个：`main.mjs:87-98` 的 env 块没有 `DSH_IOS_WORKSPACE`；宿主也没设：`app/DshIOS/NodeEngine.swift:54-59` 只设了 `DSH_IOS_HOME/DATA/DOCUMENTS`（本次核实全仓 `DSH_IOS_WORKSPACE` 只在 `memory-store.mjs` 及其测试里出现）；
  3. 于是 Dream 落库用的 workspace = `$DSH_IOS_DATA`（即 `/home/dsh/.ios`，见 `EnginePaths.swift:12-15`），写的库是 `<DSH_IOS_DATA>/.dsh-meow/memory.db`；
  4. 而会话读写记忆库按 `agent.session.header.cwd` 定位（meow-memory `lib/index.js:2294-2297`：`workspaceOf(exec)` → `header.cwd`），会话 cwd 在工作区下（`ios.patch.yml:38-43`：first-use workspace 在 `<Documents>/deepseek-harness`）。
- 即：**Dream 整理的产出很可能写进了一个会话永远不读的库**（或反之，取决于真机上会话 cwd 到底落在哪——这一点只有真机能定案）。
- 静态可证的部分：两条路径的输入变量不同（env vs header.cwd），且 env 链第一步永远是空的。修法（不在本轮范围）：在 `main.mjs` 里把会话工作区导出为 `DSH_IOS_WORKSPACE`，或让触发点把 session cwd 传给 `createMemoryStore`。
- 真机定案步骤见 §五-2③。

### 4.（新）`scene_missing` / `scene_mismatch` 被准入器静默丢弃

- 发出方：`auto-guard:826-832`（"还没有配置场景：先选一个项目再开始，否则规矩和记忆会混在一起"）。
- 准入器：`notice-admission.mjs:21-40` 里 `ALWAYS` 不冷却、`THROTTLED` 按会话冷却，**其余一律不放行**。`scene_missing`/`scene_mismatch` 不在任一名单里 → 用户永远看不到。
- 该提醒的性质恰恰是"需要人做决定"（选工作区），和 ALWAYS 那批同类。现在等于"提醒写了、发了、被自己的过滤器吃了"——这是本项目最经典的坑型。
- 处置：需要拍板——要么进 ALWAYS/THROTTLED，要么明确写下"此提醒只进日志"的决策依据（目前找不到后者）。列在这里等裁决。

### 5.（确认，非新）`text-decoder.mjs` 仍是半成品孤儿

见 §二-1。它不报错、不崩溃，只是不存在。留着会让下一个人以为"GBK 适配已经有了"。

### 6.（新·文档级）`docs/README.md` 指向两个不存在的目录

- `docs/README.md:16-17`、`:33-45` 链接 `docs/协作与规矩/` 与 `docs/场景模式/`；`ls docs/` 里没有这两个目录（只有顶层的 `场景地盘与仲裁.md`、`记忆两级.md`）。
- 属于文档树断裂，不涉及运行时代码；修法是补目录或改链接。列出来因为"照 README 读文档"是新人第一动作。

---

## 四、已修复、别让它复发（本轮复认的四个"静默坑"）

这几个是项目历史上的真实事故，本轮逐一回看代码确认修复还在；顺手用新增测试把其中能钉的钉住。

| 坑 | 当年症状 | 现在状态 | 守护 |
|---|---|---|---|
| auto-guard 用 `process.parentPort` | worker 里它永远 undefined，提醒全部静默丢失，一条没到过 App | 已修：`auto-guard:1261-1274` 用 `import { parentPort } from 'node:worker_threads'`，且**没有宿主通道时明确返回 false** | `auto-guard-notify.test.mjs`（通过）；投递侧"notify=false 就不 ack"在 `auto-guard:650-676` |
| `reportInterrupted` 写失败仍清空记录 | 磁盘满/权限错时唯一的中断证据被永久丢弃 | 已修：`flight-recorder.mjs:127` 起，先写 outbox，"只有第 1 步成功才清空" | `flight-recorder.test.mjs`「写完通知失败时必须保留记录」（通过） |
| capability 读 `.tasks.json`、registry 写 `tasks.json` | 差一个点，面板永远"还没开始干活" | 已修：`capability-status.mjs:55-58` 统一 `tasks.json`；`selfcheck.mjs:78-96` 专门复核这个口径 | `selfcheck.test.mjs`（通过） |
| meow-memory 的 prompts 被构建当文档删掉 | 插件在模块初始化时 ENOENT，整层静默不激活 | 已修：`build-engine.sh:103-111` 剪枝放行 `*/prompts/*`；冒烟 `engine-smoke.mjs:90` 把 meow-memory 列入必检 | 新增：`capability-wiring.test.mjs` 断言构建脚本保留这两条放行规则 |

另两个已修并复核：schedule-bridge 的重复投递（§二-2）；任务表 gc 无调用方（§二-3）。

---

## 五、未验证的部分：只能在真机上确认的事 + 怎么确认

> 前提（所有项共用）：当前工作树的改动**还没经过一次完整的"编译→出包→装机→复验"**（`docs/current-baseline.md:23`："本基线之后的所有改动……从未经过 Xcode 编译"；`docs/VERIFY-CHANGES.md:1-25` 讲的就是"构建成功 ≠ 改动生效"的四道门）。
> 所以第一步固定是：出包 → `node engine/tools/verify-package.mjs <ipa>` 逐文件核对 → 装机。
> 真机上的路径口径：`$DSH_HOME=/home/dsh/.dsh`、`$DSH_IOS_DATA=/home/dsh/.ios`、`$DSH_TOOLS=/opt/dsh/nodejs-project/skills`（`engine/main.mjs:88-98`、`app/DshIOS/EnginePaths.swift:12-15`）。命令可在 App 的终端里跑（或让 Agent 跑）。

### 1. 稳定身份（要确认：每轮真注入；重启两次不丢、不重复）

- 新开会话问「你是谁」→ 第一句必须是「我是 Sigma（Σ）」（`engine/AGENTS.md:7-9` 的硬要求）。
- 重启 App 两次，然后看 `$DSH_HOME/AGENTS.md`：
  - `tail -c 40 $DSH_HOME/AGENTS.md` 应能看到 `<!-- BUNDLED:END -->`；
  - `grep -c 'SCENE:BEGIN' $DSH_HOME/AGENTS.md` 应为 1（不堆积，对应踩坑总表 `:71` 的复验判据）；
  - SCENE 段（若有）应原样保留在 BUNDLED:END 之后。
- 若设备上还是旧格式（无 BUNDLED:END）：第一次启动应生成 `AGENTS.md.bak-<时间戳>` 而不是静默覆盖（`main.mjs:69-73`）。

### 2. 持续记忆（要确认：插件激活、工具可用、跨会话记得住、Dream 落对库）

- ① 插件是否激活（历史事故点）：启动日志里搜 `meow-memory`，不应有 `ENOENT ... lib/prompts/`；会话里应能用到 `memory_remember` / `memory_search` 工具（baseline `:53` 里"7 个工具未验证"就是指这个）。
- ② 跨会话记忆：在会话 A 说「记住：我的偏好是 X」，新开会话 B 问「我的偏好是什么」→ 应能答出。
- ③ **Dream 落库与 §三-3 的定案**：
  - 会话说几轮后看 `<会话 cwd>/.dsh-meow/memory.db`（工作区下）与 `$DSH_IOS_DATA/.dsh-meow/memory.db` 哪个存在、哪个在长；
  - 或直接对比：`ls -la $DSH_IOS_DATA/.dsh-meow 2>/dev/null; ls -la <工作区>/.dsh-meow 2>/dev/null`；
  - 若只有 `$DSH_IOS_DATA/.dsh-meow` 有 Dream 产出（lesson 层带「未验证」前缀），而会话检索不到 → §三-3 成立，要修。
- ④ Dream 触发条件较苛刻（`MIN_NEW=20` 条新 trace + 间隔 ≥1 小时 + 10 分钟一次的轮次检查，`dream.mjs` / `auto-guard:847-862`），真机上可以先手动：`node $DSH_TOOLS/evolve/..` 不行（那在 engine 树）——用 `node /opt/dsh/nodejs-project/runtime/evolve-cli.mjs run --force` 走一次整理（需要引擎在跑、且有 traces）。

### 3. 积累技能（要确认：trace 每轮在写；候选/提升/撤销能走通）

- 聊 5 轮以上，然后：`wc -l $DSH_IOS_DATA/.trace.jsonl`（应 ≥ 轮数——auto-guard 每轮 turn/end 追加一行，`auto-guard:1002-1026`）。
- `DSH_IOS_DATA=/home/dsh/.ios node $DSH_TOOLS/evolve/trace.mjs list` → 应列出记录；`... distill --dry-run` → 看有没有够格的话题。
- 攒够样本（同 tag ≥3 次、失败占比 ≥30%）后 `... distill`（真写）→ `... /promote.mjs list` 应能看到候选；挑一条 `promote <编号>` 生成骨架，再 `revoke --tag <tag> --reason <原因>` 看撤销是否生效且留痕。
- 观察点：这一步走通才算"学了但没学会"被修掉；现在这整条链只在单测里跑过。

### 4. 跨任务协调（要确认：每轮建任务、sweep 收僵尸、人工重排、真投递）

- `cat $DSH_IOS_DATA/tasks.json` → 每轮对话应有一条 `source: session:<id>`、`eventId: turn:<id>:<n>` 的任务，状态多停在 `succeeded`（`task-tracking.mjs:61/:110`）。
- 杀 App 重启后 15 秒内，原先 `running` 的任务应被 sweep 转 `interrupted`（`router.mjs:410-432`）。
- 制造一次失败任务（故意让一个带 threadKey 的任务失败），App 里任务控制点「重排」→ `$DSH_IOS_DATA/task-control/` 下应出现请求与 `.out` 回执（`task-control.mjs:79`），任务回 `queued`。
- 真投递（最不确定的一环）：`task-runner.makeRunTask` 需要 `ctx.get('agents')` 和 `agent.inject`——真机上找一个排队的无主任务，看它是否真的以 `source:{kind:'schedule'}` 被投进目标会话（日志 `[auto-guard] 调度启动了 N 个任务`）。**拿不到 agents 时是静默跳过的**，日志里不会有别的提示。
- §三-1 的复验（不必等 30 分钟）：手动把某条 `running` 任务的 `leaseUntil` 改成过去时间（编辑 `tasks.json`），等 ≤15 秒，看它是否被 sweep 成 `interrupted` 并弹提醒——以此确认"没有心跳 → 必被误判"这条在真机上同样成立。

### 5. 主动筛选事件（要确认：该打扰的真的到、不该的真的静）

- 触发一次中断（任务进行中杀 App）→ 重启后应出现「被引擎重启中断……」横幅（`kind: interrupted` 在 `notices.jsonl` 顶层，`main.mjs:163-187` 的契约）。
- 同一会话 10 分钟内连触发两次同类高频提醒（如轮次超限）→ 只应弹一次（`notice-admission.mjs` 冷却）。
- 检查 `scene_missing` 是否真的静默（§三-4）：在没有 `.scene.json` 的工作区开会话 → 现在**不会**有提醒；这到底对不对需要拍板。
- 提醒链路排查位：引擎日志 `[auto-guard] …` 有 = 发了；`notices.jsonl` 有 = 过了准入并落盘；App 弹了 = Swift 侧读取器正常（这三个环节互相独立，断哪层查哪层）。

### 6. 故障安全恢复（要确认：知道"断在哪一步"、不丢记录）

- 任务跑着时 `cat $DSH_IOS_DATA/in-flight.json` → 应有 `{ running: { "<session>": { at, step, turn } } }`，`step` 是"正在运行命令（…）"这类人话（`auto-guard:1040-1046`）。
- 杀 App → 重启：`in-flight.json` 应被清空（或只剩新会话），`notices.jsonl` 应多一条 `interrupted`，且讯息里带"停在「……」这一步"（`flight-recorder.mjs:127` 组装）。
- 断电式复验（可选）：把 `in-flight.json` 手写一条 `at` 为 1 小时前、`step` 为"正在写入文件（x.md）"的记录，重启 App → 应弹对应提示；把 `at` 改成 30 小时前 → 不应弹（`STALE_MS` 24 小时）。

---

## 六、测试与扫描：本轮实跑结果

- 孤儿扫描：`node engine/tools/scan-orphans.mjs` → 「共 97 个 .mjs：被引用 41 · 入口/技能/补丁 52 · 合法 CLI 1 · 真孤儿 3」（真孤儿见 §二-1）。
- 与六项能力直接相关的 24 个测试文件，本轮逐个实跑，全部 `fail 0`：
  - 任务/恢复：`task-registry` `router` `task-tracking` `task-runner` `task-control` `flight-recorder` `flight-step` `auto-guard-flight` `auto-guard-wiring` `fault-injection` `outbox-delivery` `consecutive-failure` `delivery-gate`
  - 通知：`notice-admission` `notice-contract` `auto-guard-notify`
  - 技能：`evolve-promote` `skill-revoke` `trace-accuracy`
  - 记忆：`memory-integration` `memory-store`
  - 工具/自检：`selfcheck` `scan-orphans` `capability-wiring`（本次新增，8 项）
- 全量 `sh test/run-all.sh` 的完整结果见运行日志（本环境已知有 6 个文件缺原生依赖失败：`child-process` / `direct` / `git` / `ios-environment` / `sharp` / `subprocess-ios`，与代码改动无关——`docs/current-baseline.md:110` 有同样记录）。
- 注意：全量测试必须串行跑（`--test-concurrency=1`），并行会互相抢内存假失败（baseline 自述）。

---

## 七、结论

**现在不是 super agent。**

六项能力都已经"写出来、接上线、单测绿"，但**没有一项**有"装进包、在真机上跑通"的完整证据；而且本轮又找出三个静态可证的断点：`Router.heartbeat()` 没人调（长任务会被误判中断）、`Router.accept()` 没人调（外部事件进不来）、Dream 的落库目录很可能不是会话读的那个库（写了但搜不到）。它现在是一副**接线到一半、还没通过整机通电测试的地基**——差的不是更多代码，是修掉这三个断点、再走完一次"编译→出包→装机→按 §五 逐项复验"的闭环。

---

## 八、本轮新建的文件（未改任何已有文件）

| 文件 | 内容 |
|---|---|
| `docs/SUPER-AGENT-STATUS.md` | 本文 |
| `engine/test/capability-wiring.test.mjs` | 六项能力的接线回归钉子（8 项断言：身份安装标记、调度循环调用链、sweep/gc/中断报告、通知准入行为、三个 evolve 模块候选文件名一致、trace/Dream 触发点、构建脚本两条放行规则、schedule-bridge 只读契约） |
