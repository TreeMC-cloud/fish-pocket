---
name: evolve
description: 记录干过什么、从失败里提炼经验。插件每轮自动记账；复盘或想查踩过的坑时手动跑。
version: 1.0.0
source: handwritten
permissions: [writes-files]

---

# 经验沉淀

**核心理念：不沉淀的 agent，干一年还是第一天那个 agent。**

这一层解决一个问题：**踩过的坑，下次别再踩。**
它不靠 agent 自觉，而是每轮结束由 `auto-guard` 插件自动写一条 trace；
攒够样本后 `distill` 把重复出现的「坑 + 解法」提成候选技能。

---

## 自动的部分（不用你管）

每轮对话结束，插件往 `.trace.jsonl` 追加一行：

```json
{"at":1794135754245,"kind":"task","ok":false,
 "summary":"iSH 的 wait 卡死不返回","tags":["下载"],"tools":["Bash"]}
```

- `ok` 取自这一轮的结束原因：`error` 记 false，正常结束记 true。
- `tags` 是按话题认的（下载/构建/图片/记忆/测试/偏好/版本/界面），不是工具名。
  工具名当标签只能得出「Bash 老出错」，没用。
- 只记有内容的轮次；空转的轮次不写，免得稀释样本。

## 手动三个命令

```sh
node "$DSH_TOOLS/evolve/trace.mjs" record --summary "这轮干了什么" --ok 1 --tags 下载,构建
node "$DSH_TOOLS/evolve/trace.mjs" distill          # 提炼候选技能
node "$DSH_TOOLS/evolve/trace.mjs" list             # 看最近的 trace
node "$DSH_TOOLS/evolve/trace.mjs" list candidates  # 看候选技能
```

退出码 0=正常 / 2=用法错。

## 提炼的判据（宁少勿滥）

一条候选要同时满足：

1. **同一话题 ≥3 次** —— 一次性的偶发不算经验
2. **失败占比 ≥30%** —— 一路顺利的事不需要技能
3. **有成功样本** —— 从没成功过说明还没解法，别急着固化

只看最近 300 条：老经验可能已经过时。

## 故意的减速带：verified 默认 false

提炼出来的候选 **一律 `verified: false`**，只在 `list` 里展示，**不自动变成技能**。

为什么：记错比记不住糟糕得多。把一次偶然的失败总结成"规律"，
以后每次都按错的方法做，比没有经验伤害大得多。所以要有人看过、
确认它确实对，再手动把 `verified` 改成 true。

---

## 跟其他层的关系

- **cost-guard** 回答「烧了多少」，evolve 回答「学到了什么」，两者都靠插件自动记账。
- **memory** 存「事实」和「偏好」，evolve 存「过程和教训」——分工不同。
- **self-review** 是交付前自查，evolve 是跨轮的长期积累。
