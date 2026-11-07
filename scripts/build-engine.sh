#!/usr/bin/env bash
# Assemble the engine tree the iOS app bundles as `nodejs-project/`.
# iOS cannot load native addons or run downloaded executables, so the
# install skips lifecycle scripts, resolves platform packages for ios/arm64
# (none exist, so no prebuilt binaries land), and prunes what cannot run
# there or only serves development.
#
# CI 提速：产出树按 engine 内容的哈希缓存（actions/cache）。engine/ 没变时
# 直接恢复，跳过 npm install 和剪枝这两步（省 2-4 分钟/次）。
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/engine"
out="$root/app/build/nodejs-project"

rm -rf "$out"
mkdir -p "$out"
if [ -f "$root/.engine-cache/nodejs-project.tar" ]; then
  tar -xf "$root/.engine-cache/nodejs-project.tar" -C "$out"
  echo "engine: restored from cache (engine/ unchanged)"
  exit 0
fi
cp "$src/package.json" "$src/main.mjs" "$src/boot.mjs" "$src/ios.patch.yml" "$out/"
# 全局铁律：main.mjs 在启动时把它复制到 $DSH_HOME/AGENTS.md，每轮注入。
# 漏了这个文件，规则就只是文档里的一句话，不会真的进模型。
[ -f "$src/AGENTS.md" ] && cp "$src/AGENTS.md" "$out/"
cp -R "$src/plugins" "$out/plugins"
cp -R "$src/shims" "$out/shims"
cp -R "$src/runtime" "$out/runtime"
cp -R "$src/skills" "$out/skills"
[ -f "$src/package-lock.json" ] && cp "$src/package-lock.json" "$out/"

# 不再用 --legacy-peer-deps：它会让 npm 跳过全部 peer 依赖，
# 上一版就是这样缺了 @deepseek-ai/cordis-plugin-group，引擎起不来。
# 现在的做法是显式声明所有 peer，并把 dsh-llm 换成本地最小 shim
# （file:./shims/dsh-llm = 真包 0.2.2-rc.1 完整代码，仅摘除会与宿主冲突的 peer 声明）。
# 注意：不能用「只实现 3 个函数」的最小 shim —— dsh-web 等几十个插件要从 dsh-llm
# import HarnessError 等大量符号，最小 shim 会让它们全部加载失败（真机实测教训）。
# 双保险：严格装失败（含 npm 自身崩溃，如 null reading 'matches'）时
# 自动降级到 --legacy-peer-deps 重试一次 —— 现在 5 个 peer 是显式依赖，
# legacy 模式不会漏装它们，安全。
if ! (cd "$out" && npm install --omit=dev --os=ios --cpu=arm64 --ignore-scripts --no-audit --no-fund --loglevel=error 2>&1 | tee /tmp/npm-install.log); then
  echo "engine: strict install failed, retrying with --legacy-peer-deps..."
  (cd "$out" && npm install --omit=dev --os=ios --cpu=arm64 --ignore-scripts --no-audit --no-fund --legacy-peer-deps --loglevel=error)
fi

# npm 把 file: 依赖装成符号链接（node_modules/@deepseek-ai/dsh-llm → ../../shims/...）。
# 构建机上链接有效，但 Xcode 打进 .app 时不保留符号链接 —— 链接整个丢失，
# 真机就报 ERR_MODULE_NOT_FOUND（上一版真机起不来的另一半原因）。
# 所以装完立刻物化成真实目录，不依赖链接。
for dep in dsh-llm node-addon-require-builtin-ios-arm64; do
  d="$out/node_modules/@deepseek-ai/$dep"
  [ "$dep" = node-addon-require-builtin-ios-arm64 ] && d="$out/node_modules/$dep"
  if [ -L "$d" ]; then
    tgt=$(readlink "$d")
    rm "$d"
    case "$tgt" in /*) src_shim="$tgt";; *) src_shim="$(cd "$(dirname "$d")" && cd "$tgt" && pwd)";; esac
    cp -R "$src_shim" "$d"
    echo "engine: materialized symlink $dep -> real copy"
  fi
done

nm="$out/node_modules"
before=$(du -sk "$nm" | cut -f1)
# Native code: Mach-O/ELF addons and executables for other platforms.
find "$nm" -type f \( -name '*.node' -o -name '*.dylib' -o -name '*.so' -o -name '*.so.*' -o -name '*.dll' -o -name '*.exe' \) -delete
# Platform packages npm still placed (no `os` field) and native-only stacks.
rm -rf "$nm"/@deepseek-ai/libreoffice-kit-* "$nm"/sherpa-onnx-* "$nm"/@img/sharp-* \
       "$nm"/node-pty/build "$nm"/node-pty/deps "$nm"/node-pty/prebuilds "$nm"/node-pty/third_party \
       "$nm"/@vscode/ripgrep/bin "$nm"/koffi/build
# Optional for just-bash and useless without its native half; tar -J reports xz as unavailable either way.
rm -rf "$nm"/node-liblzma
# Development-only payload. Licence texts stay: their terms require shipping them.
# skills/ 下的 .md 必须留：dsh-plugin-recommendations 和 dsh-creation-recommendations
# 在运行时用 readFile(new URL('../skills/xxx.md')) 读它当提示词，删了这两个插件就废
# （真机教训：这是 *.md 剪枝里唯一有运行时语义的一类）。
find "$nm" -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.md' -o -name '*.markdown' \) \
  ! -iname 'licen[cs]e*' ! -iname 'notice*' ! -iname 'copying*' ! -path "$nm/*/skills/*" -delete
find "$nm" -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name example -o -name examples \) -prune -exec rm -rf {} +
# Any remaining Mach-O would fail App Store validation and cannot load anyway.
{ find "$nm" -type f -size +1k -print0 | xargs -0 file --mime-type 2>/dev/null | grep -E 'application/x-(mach-binary|executable|sharedlib)' || true; } | cut -d: -f1 | while read -r f; do rm -f "$f"; done
# Bin links into what was pruned above: a dangling link in the bundle fails App Store validation.
find "$nm" -type l ! -exec test -e {} \; -delete
# TypeScript 源码：运行时只跑编译后的 .js，.ts 源码是给 IDE/编译用的。
# zod 的 src/ 尤其严重：被嵌套复制 60+ 次（每个 dsh-* 包一份），共 7k+ 个文件。
find "$nm" -type f -name '*.ts' -delete
# 删空的 src 目录 —— 但绝不能删「main/exports 指向 src 里 .js」的包！
# 教训（真机日志）：debug 的 main 是 ./src/index.js、human-signals 是
# ./build/src/main.js、@opentelemetry/api-logs 是 build/src/index.js。
# 整目录 rm -rf 会让这 3 个包 23 处 import 全断（16+4+3 个插件起不来）。
# 所以只删「真变空了」的 src 目录，自然就避开了这些包。
find "$nm" -mindepth 3 -type d -name src -path '*node_modules*' -empty -delete 2>/dev/null || true

# 浏览器 devtools（lighthouse worker 等）：iOS App 内没有浏览器 devtools 场景。
rm -rf "$nm"/@deepseek-ai/dsh-experimental-inspector
# 嵌套的重复 zod 副本：顶层已有一份，嵌套副本只是 npm 历史解析残留。
# -mindepth 5 保证只删 @deepseek-ai/xxx/node_modules/zod 这种嵌套副本，
# 顶层 node_modules/zod（深度 3）不受影响。
find "$nm" -mindepth 5 -type d -name zod -path '*node_modules*' -exec rm -rf {} + 2>/dev/null || true

# meow-memory 必须出现在 dsh 包的 dependencies 里：
# app-boot 的 INSTALL_ANCHOR = node_modules/@deepseek-ai/dsh/package.json，
# installation scope 从它 BFS 遍历 dependencies，只有落在这个闭包里的包，
# 才会被注入 profile（/home/dsh/.dsh/profiles/web）的模块解析范围。
# 只写在根 package.json 里，profile 侧 import 'meow-memory' 会 ERR_MODULE_NOT_FOUND
# —— 真机日志里 4 次 "Cannot find package 'meow-memory' imported from .../profiles/web/" 就是它。
python3 - "$out" << 'PYINJECT'
import json, os, sys
out = sys.argv[1]
anchor = os.path.join(out, 'node_modules/@deepseek-ai/dsh/package.json')
meow = os.path.join(out, 'node_modules/meow-memory/package.json')
if os.path.isfile(anchor) and os.path.isfile(meow):
    d = json.load(open(anchor))
    ver = json.load(open(meow))['version']
    deps = d.setdefault('dependencies', {})
    if 'meow-memory' not in deps:
        deps['meow-memory'] = ver
        json.dump(d, open(anchor, 'w'), indent=2)
        print('engine: injected meow-memory@%s into dsh install anchor' % ver)
    else:
        print('engine: dsh anchor already declares meow-memory')
else:
    print('engine: WARN anchor or meow-memory missing, skip injection')
PYINJECT

after=$(du -sk "$nm" | cut -f1)
echo "engine: $out ($((before/1024)) MB -> $((after/1024)) MB)"

# ---- 体积裁剪：确认零引用的大包（2026-11-08 实测静态/动态 import + require 均 0 处）----
# pnpm: 只被 `dsh plugin add` CLI 转发使用（App 内无此场景）；npm null/matches 崩溃嫌疑。
# sql.js/typescript/openai/@anthropic-ai/@google/@smithy: DSH 全树零引用的传递依赖。
rm -rf "$nm"/sql.js "$nm"/typescript "$nm"/pnpm "$nm"/openai "$nm"/@anthropic-ai \
       "$nm"/@google "$nm"/@smithy
# 剪枝后冒烟必须放在这里：验证的是“最终形态”（物化目录 + 无链接 + 已裁剪），
# CI 验证过的树 ≠ 打进 .app 的树，真机跑的是后者。
# dsh-web 是必须测的：它从 dsh-llm import HarnessError，最小 shim 时代就是它先炸。
(cd "$out" && node --input-type=module -e "
  const llm = await import('@deepseek-ai/dsh-llm');
  if (typeof llm.HarnessError !== 'function') throw new Error('dsh-llm shim missing HarnessError');
  await import('@deepseek-ai/dsh-app-boot');
  await import('@deepseek-ai/dsh-web');
  await import('@deepseek-ai/dsh-tools');   // peer: dsh-scope 等
  await import('@deepseek-ai/dsh-session-persistence');
  await import('@deepseek-ai/dsh-spill-local');
  await import('meow-memory');
  // 下面三个是真机日志里 23 处报错的包：它们的 main 就在 src/ 下，
  // 曾被我们的 src 剪枝规则误删。冒烟必须覆盖，否则同样的事还会再发生。
  await import('debug');
  await import('human-signals');
  await import('@opentelemetry/api-logs');
" > /tmp/engine-smoke.log 2>&1) || { echo "engine: smoke import failed:" >&2; grep -v 'Warning' /tmp/engine-smoke.log >&2 || cat /tmp/engine-smoke.log >&2; exit 1; }
echo "engine: post-prune smoke OK"
after2=$(du -sk "$nm" | cut -f1)
echo "engine: final $((after2/1024)) MB (pruned $(( (after-after2)/1024 )) MB)"

# CI 提速：产出树归档一份供 actions/cache 缓存。
mkdir -p "$root/.engine-cache"
tar -cf "$root/.engine-cache/nodejs-project.tar" -C "$out" .
