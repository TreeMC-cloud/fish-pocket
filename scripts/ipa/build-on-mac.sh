#!/bin/bash
# 在 Mac 上一键编译 Fish Pocket 的未签名 IPA。复制整段粘贴到终端即可。
#
# 设计原则：每一步都先检查再动手，失败立刻说清楚原因，不让人对着日志猜。
# 中途可以 Ctrl-C，重跑会从断点继续（已下载/已编译的不会重来）。

set -uo pipefail

RED='\033[0;31m'; GRN='\033[0;32m'; YEL='\033[0;33m'; NC='\033[0m'
ok()   { printf "${GRN}✓${NC} %s\n" "$*"; }
warn() { printf "${YEL}!${NC} %s\n" "$*"; }
die()  { printf "${RED}✗${NC} %s\n" "$*"; exit 1; }
step() { printf "\n${GRN}==>${NC} %s\n" "$*"; }

WORK=~/fish-pocket-build
REPO=https://github.com/TreeMC-cloud/fish-pocket.git

printf "\n"
printf "  Fish Pocket · Mac 本地编译\n"
printf "  ─────────────────────────────\n"

# ---------- 1. 环境检查 ----------
step "1/7 检查环境"

if ! xcode-select -p >/dev/null 2>&1; then
  die "没装 Xcode 命令行工具。先装 Xcode（App Store），再跑：sudo xcode-select --switch /Applications/Xcode.app"
fi
XCODE_PATH=$(xcode-select -p)
ok "Xcode: $XCODE_PATH"
XCODE_VER=$(xcodebuild -version 2>/dev/null | head -1)
ok "$XCODE_VER"

# 大版本要 ≥ 26（App 用了 iOS 26 的 BGContinuedProcessingTask 等 API）
MAJOR=$(echo "$XCODE_VER" | grep -oE '[0-9]+' | head -1)
if [ "${MAJOR:-0}" -lt 26 ]; then
  warn "Xcode 主版本是 $MAJOR，项目要 26。继续试，但可能因为缺 iOS 26 SDK 编译失败。"
fi

for c in git node npm xcodegen; do
  case $c in
    git)     command -v git >/dev/null || die "缺 git：xcode-select --install" ;;
    node)    command -v node >/dev/null || die "缺 node：去 https://nodejs.org 装 LTS 版（要 18+）" ;;
    npm)     command -v npm >/dev/null || die "缺 npm（通常跟 node 一起来）" ;;
    xcodegen) command -v xcodegen >/dev/null || { warn "缺 xcodegen，尝试用 Homebrew 装"; command -v brew >/dev/null && brew install xcodegen || die "缺 xcodegen 且没有 Homebrew。先装 Homebrew：https://brew.sh" ; } ;;
  esac
done
ok "git $(git --version | grep -oE '[0-9.]+' | head -1)"
ok "node $(node -v)"
ok "npm $(npm -v)"
ok "xcodegen $(xcodegen --version 2>/dev/null | grep -oE '[0-9.]+' | head -1)"

# ---------- 2. 拉代码 ----------
step "2/7 取代码"
if [ -d "$WORK/.git" ]; then
  cd "$WORK"
  ok "已有仓库，拉最新"
  git fetch origin main --quiet 2>/dev/null || warn "拉取失败，用本地已有的版本继续"
  git reset --hard origin/main --quiet 2>/dev/null || true
else
  mkdir -p "$(dirname "$WORK")"
  git clone --depth 1 "$REPO" "$WORK" 2>&1 | tail -2
  cd "$WORK"
fi
[ -f "$WORK/app/project.yml" ] || die "仓库结构不对：$WORK/app/project.yml 不存在"
ok "代码在 $WORK"
ok "当前提交 $(git rev-parse --short HEAD) — $(git log -1 --format=%s | head -c 50)"

# ---------- 3. 引擎依赖 ----------
step "3/7 nodejs-mobile（约 300MB，只下一次）"
if [ -d "$WORK/vendor/nodejs-mobile/rooted" ]; then
  ok "已存在，跳过"
else
  warn "首次下载，要几分钟"
  "$WORK/scripts/fetch-nodejs-mobile.sh" || die "下载失败。可能是网络问题，重跑本脚本会继续。"
  ok "下载完成"
fi

# ---------- 4. libgit2 ----------
step "4/7 libgit2（要编译 C 库，首次约 5-10 分钟）"
if [ -d "$WORK/vendor/libgit2/Libgit2.xcframework" ]; then
  ok "已存在，跳过"
else
  warn "首次编译，泡杯茶"
  "$WORK/scripts/build-libgit2.sh" || die "libgit2 编译失败。看上面报错，通常是缺 cmake：brew install cmake"
  ok "编译完成"
fi

# ---------- 5. 组装引擎 ----------
step "5/7 组装 engine（npm install + 剪枝）"
"$WORK/scripts/build-engine.sh" || die "engine 组装失败"
ok "engine 就绪"

# ---------- 6. 生成工程 ----------
step "6/7 生成 Xcode 工程"
cd "$WORK/app"
xcodegen generate --quiet || die "xcodegen 失败：检查 app/project.yml"
ok "DshIOS.xcodeproj 已生成"

# ---------- 7. 编译 + 打包 ----------
step "7/7 编译真机包（约 3-6 分钟）"
START=$(date +%s)
xcodebuild -project DshIOS.xcodeproj -scheme DshIOS \
  -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath build/DerivedData \
  -skipPackagePluginValidation \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=NO \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  build 2>&1 | tail -20
BUILD_CODE=${PIPESTATUS[0]}
END=$(date +%s)
DUR=$((END - START))

[ "$BUILD_CODE" -eq 0 ] || die "编译失败（看上面 20 行）。耗时 ${DUR}s"
ok "编译完成，耗时 ${DUR}s"

APP="$WORK/app/build/DerivedData/Build/Products/Release-iphoneos/DshIOS.app"
[ -d "$APP" ] || die "找不到产物：$APP"

# ad-hoc 重签嵌入的 framework，否则装到设备上 dyld 拒绝加载
step "打包 IPA"
find "$APP/Frameworks" -maxdepth 1 -name '*.framework' -type d 2>/dev/null | while read -r fw; do
  name=$(basename "$fw" .framework)
  [ -f "$fw/$name" ] && codesign --force --sign - --timestamp=none "$fw/$name" 2>/dev/null
  codesign --force --sign - --timestamp=none "$fw" 2>/dev/null
done
for ext in "$APP"/PlugIns/*.appex; do
  [ -d "$ext" ] && codesign --force --sign - --timestamp=none "$ext" 2>/dev/null
done
codesign --force --sign - --timestamp=none "$APP" 2>/dev/null

OUT="$HOME/Desktop/DshIOS-unsigned.ipa"
rm -rf /tmp/fp-payload
mkdir -p /tmp/fp-payload/Payload
cp -R "$APP" /tmp/fp-payload/Payload/
(cd /tmp/fp-payload && zip -qry "$OUT" Payload)
rm -rf /tmp/fp-payload

[ -f "$OUT" ] || die "打包失败"
SIZE=$(du -h "$OUT" | cut -f1)
ok "IPA 在桌面：$OUT（$SIZE）"

# 自检：第一项必须是 Payload/
FIRST=$(unzip -l "$OUT" | sed -n '4p' | awk '{print $4}')
case "$FIRST" in
  Payload/*) ok "结构正确（$FIRST）" ;;
  *) warn "结构异常，第一项是 $FIRST —— 可能装不上" ;;
esac

printf "\n"
printf "  ${GRN}完成${NC}\n"
printf "  IPA：$OUT\n"
printf "  用爱思助手 / Sideloadly 拖进去，用你的 Apple ID 重签安装。\n"
printf "\n"
printf "  下次改代码后只需重跑本脚本，前面几步会跳过，只编译（3-6 分钟）。\n"
printf "\n"
