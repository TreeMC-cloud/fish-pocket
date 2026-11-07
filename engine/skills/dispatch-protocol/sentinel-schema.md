# 回执哨兵台账格式（sentinel.mjs）

## 这个工具为什么存在

`subagent` / `wb_submit_task` 是异步的：调用立刻返回 id，活还在后台跑。
「已发出」「已回执」两个状态不够 —— 中间必须显式存在第三种状态
**「已发出、还没人回」**，否则派单等于扔进黑洞，双方都在等对方且不报错。

台账就是这三个状态的落盘形式。`open` 查「我发出还没人回的」，
`awaited` 查「别人在等我回的」。两者都是**会失败的检查**，不是只读展示。

## 文件

- 路径：`process.env.DSH_SENTINEL_LEDGER`，未设置时为当前工作目录的 `.sentinel.jsonl`
- 编码：UTF-8，**JSONL，一行一条记录**，`\n` 结尾
- 写入：`dispatch` / `inbound` 追加（不重写整本）；`ack` / `gc` 读改写，先写 `.tmp` 再 `rename`，避免半截文件
- 坏行：跳过并在 stderr 报行号，**不自动删除**（猜不出语义的数据不能替人做决定）；
  检查命令 `open` / `awaited` / `list` / `gc` 遇到坏行且本无问题时退出 1

## 字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | string | 唯一标识，自动生成 `s_<时间36进制><6位随机hex>`；`dispatch` 可用 `--id` 自定义，限 `[A-Za-z0-9_.-]{1,80}` |
| `kind` | `"dispatch"` \| `"inbound"` | 我发出的 / 别人发给我的。决定它进 `open` 还是 `awaited` |
| `from` | string | 发出方；`dispatch` 固定为 `"me"`，`inbound` 为 `--from` |
| `to` | string | 接收方；`dispatch` 为 `--to`，`inbound` 固定为 `"me"` |
| `what` | string | 做什么。派单四件套：现象 / 照哪做 / 怎么验 / 回一句 |
| `expect` | string \| null | 预期回执；`dispatch` 未给 `--expect` 时默认「带证据的回执（结论 / 证据 / 落盘）」，`inbound` 为 null |
| `at` | string | 派单时间，ISO 8601（`new Date().toISOString()`） |
| `ackAt` | string \| null | 首次销账时间，ISO 8601；**null / 缺失 / 空串 = 未回执** |
| `evidence` | string \| null | 回执证据：命令输出、文件路径、关键行 |

示例：

```json
{"id":"s_m1abc2d3e4f5","kind":"dispatch","from":"me","to":"remote-workbench","what":"修完跑 node selfcheck.mjs 复验","expect":"带证据的回执（结论 / 证据 / 落盘）","at":"2026-02-14T09:00:00.000Z","ackAt":null,"evidence":null}
{"id":"s_m1abc2d3e4f6","kind":"inbound","from":"subagent-1","to":"me","what":"把 HANDOFF.md 的第 4 节补上","expect":null,"at":"2026-02-14T09:01:00.000Z","ackAt":"2026-02-14T09:12:00.000Z","evidence":"HANDOFF.md:12 下一步=补 I1 引用错误"}
```

## 状态与查询

| 条件 | 归属 |
|---|---|
| `kind === "dispatch" && !ackAt` | `open` —— 我欠一次催 |
| `kind === "inbound" && !ackAt` | `awaited` —— 我让别人空等 |
| `ackAt` 有值 | 已销账，两个查询都不再列出，`list` 仍可见 |

`open` 按等待时长**倒序**，`--stale <分钟>`（默认 30）标 `⚠ 超时`；
`--stale 0` 表示所有未回执都算超时。`waited = now - at`，`at` 非法时按 0 处理并提示。

## 退出码约定（全项目统一）

| 码 | 含义 | 例 |
|---|---|---|
| `0` | 操作成功且**没有问题需要处理** | `open` 无未回执、`ack` 成功、`gc` 完成 |
| `1` | 操作成功但**发现需要处理的问题** | `open` 有未回执（含超时）、`awaited` 有等我的、坏行、`ack` 找不到 id 或重复销账 |
| `2` | **用法错误** | 缺 `--to` / `--id`、`--stale` 不是数字、重复参数、未知命令 |

`1` 和 `2` 必须真的能出现。**如果 `open` 永远返回 0，它就不是检查，是装饰。**

## 销账语义

- `ack --id <id>` 更新该行的 `ackAt` 和 `evidence`，重写整本文件（数据量小，不需要数据库）
- 回执证据可后补：`ack --id <id> --evidence "..."` 只补 `evidence`，**不覆盖 `ackAt`**
  （首次回执时间是「对方到底等多久」的唯一凭据）
- 重复 `ack` 同一 id：报 `⚠ 早就销过账了` 并退出 1；收到回执就结束，不要再回「收到」开新线
- 未带证据销账仍成功，但 stderr 提示 `⚠ 只说「做完了」等于没说`

## 清理

`gc --days N`（默认 7）删除**已销账时间早于 `now - N 天`**的记录，输出被删 id 与销账时间的差异集合。
未销账的一条都不删 —— 把卡住的单清掉等于亲手把黑洞挖回来。
`--days 0` 清掉所有已销账记录，未销账的照留。

## 命令速查

```
node sentinel.mjs dispatch --to <对方> --what <做什么> [--expect <预期回执>] [--id <自定义id>]  # 打印 id
node sentinel.mjs ack      --id <id> [--evidence <证据>]                                       # 销账 / 补证据
node sentinel.mjs open     [--stale <分钟>]                                                    # 我欠不欠催
node sentinel.mjs awaited                                                                      # 我是不是让别人空等
node sentinel.mjs inbound  --from <对方> --what <做什么>                                       # 记一条收到但未回的
node sentinel.mjs list     [--limit N]                                                         # 全部（或最近 N 条）
node sentinel.mjs gc       [--days N]                                                          # 清理旧的已销账
node sentinel.mjs help
```

## 已知边界

### 高并发写会丢数据（实测）

`dispatch` 用 `appendFileSync` 追加单行，系统层面保证不互相覆盖。但**本机（iSH）并发 10 个进程时会丢**——实测只落盘 4-5 条。原因是 node 进程创建线程被系统拒绝：

```
node[6725]: Assertion failed: (0) == (uv_thread_create(t.get(), start_thread, this))
```

内存不足导致进程崩溃，id 已打印但没写进台账。

| 并发数 | 结果 |
|---|---|
| 串行 10 次 | **10/10 全部成功** |
| 并发 3 次 | **3/3 全部成功** |
| 并发 10 次 | **4-5/10，丢一半** |

**正常使用（一次派一个活）不受影响。** 批量派单要串行，或分批（每批 ≤3）。

这不是代码缺陷——同样的代码在正常 Linux 上并发 10 没问题。真要高频并发，得换 SQLite 或加文件锁。

### 其他

- 只按天清理，不支持按条数 / 按体量；单文件会随长期未销账记录变长
- 无文件锁：多进程并发 `ack` / `gc` 存在最后写入覆盖风险
- 时间只看本机时钟；`at` 被手改成非法值时按 0 分钟算并给提示
- `inbound` 不能自定义 id，也不能指定 `--expect`
- 台账是本地文件，不做跨设备同步；远程工作台的 id 要自己写进 `what` 或 `evidence`
