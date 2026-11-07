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
# （file:./shims/dsh-llm-min），从根上消除版本冲突，严格解析就能过。
# 双保险：严格装失败（含 npm 自身崩溃，如 null reading 'matches'）时
# 自动降级到 --legacy-peer-deps 重试一次 —— 现在 5 个 peer 是显式依赖，
# legacy 模式不会漏装它们，安全。
if ! (cd "$out" && npm install --omit=dev --os=ios --cpu=arm64 --ignore-scripts --no-audit --no-fund --loglevel=error 2>&1 | tee /tmp/npm-install.log); then
  echo "engine: strict install failed, retrying with --legacy-peer-deps..."
  (cd "$out" && npm install --omit=dev --os=ios --cpu=arm64 --ignore-scripts --no-audit --no-fund --legacy-peer-deps --loglevel=error)
fi

# 装完必须能真的 import —— 上一版只查了语法和依赖存在，没查“装完能不能起”。
smoke() {
  (cd "$out" && node --input-type=module -e "
    await import('@deepseek-ai/dsh-app-boot');
    await import('meow-memory');
  " 2>&1 | grep -v Warning)
}
if ! smoke; then
  echo "engine: smoke import failed — aborting, see errors above" >&2
  exit 1
fi

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
find "$nm" -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.md' -o -name '*.markdown' \) \
  ! -iname 'licen[cs]e*' ! -iname 'notice*' ! -iname 'copying*' -delete
find "$nm" -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name example -o -name examples \) -prune -exec rm -rf {} +
# Any remaining Mach-O would fail App Store validation and cannot load anyway.
{ find "$nm" -type f -size +1k -print0 | xargs -0 file --mime-type 2>/dev/null | grep -E 'application/x-(mach-binary|executable|sharedlib)' || true; } | cut -d: -f1 | while read -r f; do rm -f "$f"; done
# Bin links into what was pruned above: a dangling link in the bundle fails App Store validation.
find "$nm" -type l ! -exec test -e {} \; -delete
after=$(du -sk "$nm" | cut -f1)
echo "engine: $out ($((before/1024)) MB -> $((after/1024)) MB)"

# CI 提速：产出树归档一份供 actions/cache 缓存。
mkdir -p "$root/.engine-cache"
tar -cf "$root/.engine-cache/nodejs-project.tar" -C "$out" .
