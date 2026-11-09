# 包与仓库漂移基线（PACKAGE DRIFT）

> 基线时间：2026-11-09
> 核对工具：`engine/tools/verify-package.mjs`（逐文件 sha256，只读不改）
> iSH 前置：`ulimit -s 8192`

## 为什么要有这份文档

这个项目踩过一个大坑：**构建成功、包能装、能跑，但里面是旧代码**。

```
仓库 plugins/auto-guard/index.mjs   1237 行
打进包的同一文件                     186 行   ← 连 onTurnEnd 都没有
```

原因有两个，都静默：
1. `build-engine.sh` 的缓存早退：只要缓存 tar 存在就 `exit 0`，跳过 `cp -R "$src/plugins"`
2. **仓库侧丢过文件**：包里有、仓库没有的文件，下次构建就会消失

第 2 类是最阴的——它不报错，只是「下一次出的包少了点东西」。本文档记录一次完整盘点的结果。

## 核对方法

```bash
ulimit -s 8192
cd /var/minis/workspace/fish-pocket

# 人读
node engine/tools/verify-package.mjs <ipa或解包目录>

# 机器可读，只看差异
node engine/tools/verify-package.mjs <ipa> --json | python3 -c \
  'import json,sys; d=json.load(sys.stdin); print(d["counts"]); \
   [print(" +",e["path"]) for e in d["extras"]]; [print(" -",m) for m in d["missing"]]'
```

**读结果的要点**：`不一致` 的绝对值没有比较意义（仓库一直在改，越老的包差异越大，属正常滞后）。
有诊断价值的只有两列：

- **缺失**（仓库有、包里没有）→ 说明「加了新文件但包是旧的」，重建即可
- **多出**（包里有、仓库没有）→ 说明**仓库丢过文件**，下次构建会少东西，**必须处理**

## 盘点结果（16 个包/解包目录）

### 最新包的正面结论

| 包 | 一致 | 不一致 | 缺失 | 多出 |
|---|---|---|---|---|
| 最新包 | 122 | 10 | **0** | 3 |

**缺失 0** —— 这是关键。不存在「加了文件但包是旧的」。

### 多出项逐个判定

| 文件 | 判定 | 理由 |
|---|---|---|
| `package-lock.json` | 正常，忽略 | npm install 产物；仓库里没有锁文件，构建时现生成 |
| `shims/dsh-llm-min/index.mjs` | **废弃残留，已从仓库删除** | 零引用；被完整版 `shims/dsh-llm` 取代；包名与真包同名，留着易误引用 |
| `shims/dsh-llm-min/package.json` | 同上 | 同上 |

### ⚠ 反向分叉：包比仓库新（已修复）

这两个是**真正危险**的——仓库里的版本比已发布的包还旧，说明**仓库侧丢过代码**：

| 文件 | 仓库（修复前） | 包内 | 内容 |
|---|---|---|---|
| `plugins/ios-host/index.mjs` | 56 行 | **101 行** | `refuseBuilds()`：在 pnpm 策略里关掉装不了的构建脚本，让插件安装不被卡住 |
| `runtime/worker-main.mjs` | 52 行 | **63 行** | 调用 `installTextDecoder()` + `entryOf()` 脚本解析 |

**处理**：已从包里恢复这两个文件的完整版（仓库里的旧版备份在 `/tmp/fork/`）。

`ios-host` 那段丢失的后果很具体：用户装插件时遇到 iOS 上根本跑不了的构建脚本（没有编译器），会**卡死在整个安装流程**，而 `refuseBuilds` 就是让引擎能跳过它们。

## 已知遗留

| 项 | 状态 | 说明 |
|---|---|---|
| `iconv-lite` 依赖 | **已补** | `text-decoder.mjs` 解码 GBK 需要它；纯 JS 无编译步骤，已写进 `engine/package.json` |
| `engine/package-lock.json` | 缺失 | 工作区被删（git `D`）→ 构建不可复现（每次解出不同依赖版本） |
| `engine/` 大部分文件 untracked | 未解决 | HEAD 仍是 2026-11-07；`runtime/*`、`plugins/auto-guard/`、`skills/evolve/` 等全是 `??`。**git 里的仓库重建不出任何近期的包**——这是漂移的总根源 |
| 构建机残留 `shims/dsh-llm-min/` | 已删（仓库侧） | 删掉后重新出包，「多出」应从 3 降到 2 |

## 下次出包后的期望值

```
缺失 0 · 多出 1（只剩 package-lock.json）
不一致里不再出现「包比仓库新」的项
```

如果 `多出` 又冒出别的文件，用上面的命令立刻能看出来——**不要等到装机才发现**。
