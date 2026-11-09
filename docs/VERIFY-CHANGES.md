# 包内代码核对：怎么确认「改的代码真的进了 App」

> 一句话：**构建成功只说明构建脚本的退出码是 0，不说明它读的是你刚改的那份代码。**

本文写给下一次「我明明改了，真机上还是老行为」的人。所有命令都在仓库根目录执行。

---

## 0. 三条命令（急用先看）

```bash
ulimit -s 8192                                            # iSH 上跑 node 前必须；Mac 不用
node engine/tools/verify-package.mjs DshIOS-unsigned.ipa      # 人看，退出码 0/1
node engine/tools/verify-package.mjs DshIOS-unsigned.ipa --json > verify.json   # CI 读
```

它会逐个文件比对**包里 nodejs-project 的实际字节**和**仓库 engine/ 的当前字节**，
只给三种结论：一致 / 不一致（附两边哈希前 8 位）/ 包内缺失；
另外附一段不计入结论的「包内多出」（包里有、仓库里没有的文件）。

---

## 1. 为什么「构建成功」不等于「改动生效」

一个功能要进到用户手机上，中间有四道门，每一道都能静默失败：

| # | 门 | 怎么悄悄失败 | 表面现象 |
|---|---|---|---|
| 1 | 代码写进 `engine/` | 改的是另一个分支 / 另一个工作副本 | 本地测试通过，包里没有 |
| 2 | `build-engine.sh` 把它 `cp` 进 `app/build/nodejs-project` | **缓存快路径直接 `exit 0`**（今天的事故） | 构建成功，包里是旧文件 |
| 3 | Xcode 把 `nodejs-project` 塞进 `DshIOS.app` | 脚本没跑 / 跑挂了，archive 用的是上一次的 `app/build` | archive 成功，包是上一次的 |
| 4 | 装到机器上的是这个包 | 没覆盖安装、装错 IPA、AirDrop 了旧包 | 行为对不上代码 |

`build-engine.sh` 只负责第 2 道门。它的 `echo "engine: ..."` 全绿，只证明第 2 道门跑完了。

第 2 道门还有个固有缺口：**它只 `cp` 清单里的东西**。
`engine/tools/`、`engine/test/`、`engine/p1/`、`engine/proj1/` 永远不进包（见第 6 节）。

---

## 2. `build-engine.sh` 的缓存陷阱：是什么，现在怎么防

### 原来的写法（事故版本）

```bash
if [ -f ".engine-cache/nodejs-project.tar" ]; then
  tar -xf "$CACHE_TAR" -C "$out"
  echo "engine: restored from cache"
  exit 0                      # ← 后面 cp -R "$src/plugins" 整段不会执行
fi
```

只要 tar 在，就展开旧产物并退出。于是：

- 源码改了，tar 还是旧的 → **装进 App 的是旧代码**
- 构建、签名、安装、启动全绿，日志里只有一行 `restored from cache`，没有别的提示
- 你以为在验证新功能，其实在验证上一版的行为

今天真实发生过：仓库 `engine/plugins/auto-guard/index.mjs` 是 **1238 行**（有 `onTurnEnd`），
打进 App 的却一直是 **186 行**的旧版——那份旧代码里连 `onTurnEnd` 都不存在。
改了代码、构建成功、能装能用，但里面是旧代码；这个失败完全静默，浪费了十几轮迭代。
（`build-engine.sh` 的注释里还记着同一个坑的另一次发作：仓库 1237 行，包里 993 行。）

### 现在的写法：tar 必须配一份源码指纹

```bash
CACHE_TAR="$root/.engine-cache/nodejs-project.tar"
CACHE_STAMP="$root/.engine-cache/source.sha256"

src_hash() {   # engine/ 里所有源码的哈希（node_modules 除外）
  ( cd "$src" && find . -path ./node_modules -prune -o -type f \
      \( -name '*.mjs' -o -name '*.js' -o -name '*.json' -o -name '*.yml' -o -name '*.md' \) \
      -print | LC_ALL=C sort | xargs -r sha256sum | sha256sum | cut -d' ' -f1 )
}

if [ -f "$CACHE_TAR" ] && [ -f "$CACHE_STAMP" ]; then
  want="$(src_hash)"; have="$(cat "$CACHE_STAMP")"
  if [ "$want" = "$have" ]; then tar -xf "$CACHE_TAR" -C "$out"; exit 0; fi
  echo "engine: cache stale (source changed), rebuilding"
  rm -f "$CACHE_TAR" "$CACHE_STAMP"
fi
```

tar 和指纹**一起写、一起用**：指纹不匹配就删缓存重建。少了 `src_hash > "$CACHE_STAMP"`
这一行，缓存就退化成「永远命中」。

### 指纹的两个已知盲区（还没修，先记在这）

1. **只认 5 种扩展名**：`.mjs .js .json .yml .md`。
   现在 `engine/skills/handoff/preflight.sh` 是唯一的漏网文件——**改它不会让缓存失效**，
   包里的 `preflight.sh` 会一直是旧的。要么把 `-name '*.sh'` 加进去，
   要么干脆改成「除 `node_modules` 外所有文件都算」。
2. **会把不进包的文件算进去**：`test/`、`tools/`、`p1/`、`proj1/` 里的 `.md/.json` 也参与指纹，
   改测试会让缓存失效。方向是安全的（多重建一次），但要知道：
   **缓存失效 ≠ 包该变；缓存命中 ≠ 包是对的。**

指纹只能证明「这次构建读了哪份源码」，证明不了「手上这个 IPA 是哪次构建产出的」。
IPA 可能是旧的、可能是别的机器出的、可能有人手工换过 nodejs-project。
所以还要第 4 节的核对。

---

## 3. 从构建日志一眼判断走了哪条路

完整构建（真的拷了、真的 `npm install` 了、真的剪枝了）：

```
engine: cache stale (source changed), rebuilding
engine: /Users/.../app/build/nodejs-project (807 MB -> 360 MB)
engine: final 359 MB (pruned 1 MB)
engine: cached with fingerprint 3f2a...
```

走了缓存（**危险信号**，除非你确定 `engine/` 一个字节都没动）：

```
engine: restored from cache (engine/ fingerprint matches 3f2a...)
```

判据很简单：

| 日志里出现 | 含义 |
|---|---|
| `807 MB -> 360 MB`（`N MB -> M MB`） | `npm install` 跑完了 → 这次是完整构建 |
| `restored from cache` | 只是 `tar -xf`，没有安装、没有拷贝 → 用的是 tar 里的旧产物 |
| 两者都没有 | `build-engine.sh` 根本没跑到这步，Xcode 用的是上次的 `app/build` |

**CI 的注意点（截至 2026-11-09）**：`.github/workflows/unsigned-ipa.yml` 里
`Cache engine tree`（`path: .engine-cache`）排在 `Assemble engine` **之后**，
所以 CI 日志里看不到 `restored from cache` 是正常的——那一步实际上只存不取。
换句话说：**看到 `restored from cache` 基本只发生在本地重复构建时**，而这正是最容易出事的场景。

---

## 4. 自查：`engine/tools/verify-package.mjs`

### 用法

```bash
node engine/tools/verify-package.mjs <ipa路径>          # 直接在 IPA（zip）里读，不解包
node engine/tools/verify-package.mjs <已解包目录>        # 含 Payload/ 的目录、.app 目录、或 nodejs-project 本身
node engine/tools/verify-package.mjs <ipa> --json        # 机器可读
node engine/tools/verify-package.mjs <ipa> --engine ../other/engine   # 指定仓库（默认取脚本上一级）
```

退出码：`0` 一致 · `1` 不一致（有差异或缺失）· `2` 用法/读取错误。
可以直接当 CI 的闸：`node engine/tools/verify-package.mjs "$IPA"` 非 0 就别发布。

**比对范围** = `build-engine.sh` 实际 `cp` 的东西，不多不少：
`package.json` `main.mjs` `boot.mjs` `ios.patch.yml`（+ 存在才拷的 `smoke.mjs` `AGENTS.md`
`package-lock.json`）以及 `plugins/` `shims/` `runtime/` `skills/` 四棵子树。
`node_modules/` 不比对——那是 `npm install` 的产物，天然和仓库不一致。
**判据是逐文件 sha256**：不比「存在」，也不比「大小」。大小相同、内容不同（改一句常量、一个字符）
是真会发生的；本工具的自测里专门造过这种包，能抓到。

### 输出长什么样（真实输出，2026-11-09 15:06，`/tmp/chk/DshIOS-unsigned.ipa`）

```
包内引擎核对 · /tmp/chk/DshIOS-unsigned.ipa
  包内树  Payload/DshIOS.app/nodejs-project/（zip 直读，未解包）
  仓库    /var/minis/workspace/fish-pocket/engine（最近改动 11-09 15:04）
  清单    131 个文件（= build-engine.sh 的 cp 范围；node_modules 不算）

  一致 125 · 不一致 6 · 缺失 0 · 包内多出 4（不计入结论）

不一致（6）
  ✗ plugins/auto-guard/index.mjs
      仓库 70ceb466 · 57777B · 1272 行 · 改动于 11-09 15:04
      包内 796909ac · 55684B · 1238 行
      首个差异行 L403；包内少 34 行 → 包内是旧版
  ✗ runtime/bench.mjs
      仓库 89e51ef4 · 21770B · 519 行 · 改动于 11-09 13:33
      包内 9ea471c6 · 6460B · 162 行
      首个差异行 L8；包内少 357 行 → 包内是旧版

包内缺失（0）

包内多出（4，不计入结论）—— 包里有、仓库里没有
  + package-lock.json  —  npm install 产物（仓库里没有锁文件，构建时现生成），正常
  + runtime/text-decoder.mjs  —  仓库里没有这份代码：历史残留，或仓库把文件丢了

结论：包内引擎与仓库不一致（6 个文件内容不同）—— 装进 App 的不是当前仓库的代码
```

### 怎么读这段输出

- **不一致**：路径 + 两边哈希前 8 位 + 字节数 + 行数 + 仓库改动时间 + 首个差异行。
  `包内少 357 行 → 包内是旧版` 就是「哪个文件是旧的」的答案，不用再手动 diff。
- 反过来 `包内多 45 行 → 仓库里没有这部分代码` 表示两边**分叉**了：仓库里那份比包里还旧，
  或者仓库把这段代码删了而包没重建。这种情况别急着「以仓库为准重建」，先搞清楚谁是对的。
- **包内缺失**：仓库有、包里没有。多半是「加了新文件但包是旧的」。
- **包内多出**：不计入结论（`package-lock.json` 这类 npm 产物天然存在），
  但如果多出来的是 `.mjs`，要查清楚——要么是历史残留，要么是**仓库把已经进包的代码丢了**。
- 每个差异都带「仓库改动于 X」。**仓库是活的**：如果那个时间晚于 IPA 的出包时间，
  说明是包之后仓库才改的，这时「不一致」是正常的，重新打包即可，不是历史遗留问题。

### 补充：解包目录模式（可选）

```bash
unzip -q DshIOS-unsigned.ipa 'Payload/DshIOS.app/nodejs-project/*' -d /tmp/unpack
node engine/tools/verify-package.mjs /tmp/unpack
```

在 iSH 上解 114MB 的包约 5 分钟（2.5 万个文件）；Mac 上几秒。直接传 `.ipa` 更快（本机实测 6 秒），
所以平时不用解包——zip 模式只读需要的 131 个条目，不会把 node_modules 解出来。

---

## 5. 「改代码 ≠ 改进产品」

这条教训今天用两次实测换了具体的数字：

1. **事件**：`auto-guard` 在仓库里写到 1238 行（含 `onTurnEnd`），打进 App 的却是 186 行的旧版。
   构建成功、装机成功、对话正常——于是十几轮迭代都在验证一份**不在仓库里**的代码。
   所有"改了没效果"的困惑，全部来自这里。
2. **复测（同日 15:00 左右）**：
   - `/tmp/ipa7`（旧包）：`auto-guard` 只有 993 行（仓库 1238），另有 9 个文件内容不同、6 个文件包内缺失。
   - `/tmp/chk`（14:35 出的新包）：`auto-guard` 是 1238 行、与仓库**当时**的版本一致，
     但 `bench.mjs` 只有 162 行（仓库 519 行）、`prefs.mjs` 185 行（仓库 243 行），
     而 `ios-host`、`worker-main` 又比仓库**多**出代码。
   
   结论：**同一个包里，有的文件是新的、有的文件是旧的、有的比仓库还新。**
   不许假设"整体一致"，只能逐个文件核。

更值得记住的是：一个功能"写完了"要经过 写进仓库 → 被拷进树 → 被打进 .app → 真机加载
四道门。任何一道静默失败，产品一点没变，而你的测试全部通过。
**「能跑」不是证据，「包里的字节和仓库的字节相同」才是。**

补救顺序（别跳步）：

```bash
scripts/build-engine.sh                                    # 1. 重建，确认日志出现 "N MB -> M MB"
node engine/tools/verify-package.mjs <新出的 ipa>           # 2. 核对，退出码必须是 0
```

第 1 步日志里若出现 `restored from cache`，说明又是缓存命中——先确认 `engine/` 真的没变，否则删掉
`.engine-cache/` 重跑。

---

## 6. 顺带发现（2026-11-09，核对时记下来的）

**仓库里「写了但不会进包」的：**

| 路径 | 内容 | 说明 |
|---|---|---|
| `engine/tools/` | `scan-orphans.mjs`、`verify-package.mjs` | 开发机工具，`build-engine.sh` 不拷。**本工具自己也永远不会在包里**——它核对别人，不参与打包 |
| `engine/test/` | 44 个 `*.test.mjs` | 单元测试，不拷 |
| `engine/p1/`、`engine/proj1/` | `.dsh-meow/sessions/*.json`、`tmp/**/sessions/*.json` | 本地跑引擎留下的会话残留，既不该进包也不该进 git（目前是 untracked 状态） |

**反向的坑（包里有、仓库里没有）：**

- `runtime/text-decoder.mjs`（包内有、仓库没有；包内的 `worker-main.mjs` 正 import 它）
- `shims/dsh-llm-min/index.mjs`、`shims/dsh-llm-min/package.json`

也就是说：**用现在的仓库，重建不出这个 IPA 里的那份引擎**。
仓库当前的 `worker-main.mjs` 不引用 `text-decoder.mjs`，所以重建不会立刻坏，
但两边已经不是同一份代码了。这类差异只有逐文件核对才看得见。

**另外两个小问题：**

- `engine/package-lock.json` 在工作区被删了（git 里是 `D` 状态）。`build-engine.sh` 是
  `[ -f "$src/package-lock.json" ] && cp`，所以现在不拷锁文件，`npm install` 每次现解依赖——
  包里的那份 `package-lock.json` 是构建时生成的，构建因此不可复现。
- `src_hash` 只认 5 种扩展名，`skills/handoff/preflight.sh` 改动不会让缓存失效（见第 2 节）。

---

## 7. 维护约定

- **改了 `scripts/build-engine.sh` 里任何一条 `cp` / `cp -R`，必须同步改
  `engine/tools/verify-package.mjs` 顶部的 `ROOT_FILES` / `COPY_DIRS`**。
  工具不会去解析脚本：解析 shell 的失败方式太多，而且失败会伪装成「一致」。
- 新加了扩展名（比如 `.sh`、`.yaml`）到打包范围时，记得同时检查 `src_hash` 的 `-name` 列表。
- 每次出包后跑一次核对。一条命令、6 秒，换掉「改了十几轮才发现是旧代码」。
