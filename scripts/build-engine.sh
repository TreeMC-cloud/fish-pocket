#!/usr/bin/env bash
# Assemble the engine tree the iOS app bundles as `nodejs-project/`.
# iOS cannot load native addons or run downloaded executables, so the
# install skips lifecycle scripts, resolves platform packages for ios/arm64
# (none exist, so no prebuilt binaries land), and prunes what cannot run
# there or only serves development.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/engine"
out="$root/app/build/nodejs-project"

rm -rf "$out"
mkdir -p "$out"
cp "$src/package.json" "$src/main.mjs" "$src/boot.mjs" "$src/ios.patch.yml" "$out/"
cp -R "$src/plugins" "$out/plugins"
cp -R "$src/shims" "$out/shims"
cp -R "$src/runtime" "$out/runtime"
cp -R "$src/skills" "$out/skills"
[ -f "$src/package-lock.json" ] && cp "$src/package-lock.json" "$out/"

(cd "$out" && npm install --omit=dev --os=ios --cpu=arm64 --ignore-scripts --no-audit --no-fund --loglevel=error)

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
