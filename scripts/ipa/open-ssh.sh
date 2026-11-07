#!/bin/bash
# 在这台 Mac 上跑，帮我（AI）建立一条能远程执行命令的 SSH 通道。
#
# 为什么需要这个：ToDesk / UU 是图形远程桌面，AI 这边只有命令行，
# 没法用它们。SSH 是两边都能用的唯一通道。
#
# 这个脚本做三件事：
#   1. 打开 macOS 的远程登录（SSH）
#   2. 生成一把只用于这台机器的密钥，把公钥装进授权列表
#   3. 打印我需要的信息（地址 / 用户名 / 私钥）
#
# 跑法：复制下面这一整行到终端，回车，输入密码。
#   bash -c "$(curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/TreeMC-cloud/fish-pocket/main/scripts/ipa/open-ssh.sh)"

set -uo pipefail

G='\033[0;32m'; Y='\033[0;33m'; R='\033[0;31m'; N='\033[0m'
ok()  { printf "${G}✓${N} %s\n" "$*"; }
warn(){ printf "${Y}!${N} %s\n" "$*"; }
die() { printf "${R}✗${N} %s\n" "$*"; exit 1; }

printf "\n=== 1/3 打开远程登录（SSH）===\n"

# macOS 上开启 SSH 需要 sudo
if ! sudo -n true 2>/dev/null; then
  warn "需要管理员密码来开启 SSH（会提示输入）"
fi

# 用 launchctl 直接加载 sshd（比 systemsetup 快，且不依赖 GUI）
if sudo systemsetup -getremotelogin 2>/dev/null | grep -q "On"; then
  ok "远程登录已经是开的"
else
  warn "正在开启…"
  sudo systemsetup -setremotelogin on 2>&1 | tail -1
  sudo launchctl load -w /System/Library/LaunchDaemons/ssh.plist 2>/dev/null || true
  sudo systemctl start ssh 2>/dev/null || true
fi

# 验证真的在监听
if ! (nc -z 127.0.0.1 22 2>/dev/null || lsof -iTCP:22 -sTCP:LISTEN >/dev/null 2>&1); then
  die "SSH 没起来。手动开：系统设置 → 通用 → 共享 → 远程登录 → 打开"
fi
ok "SSH 在 22 端口监听"

printf "\n=== 2/3 生成一把临时密钥（只给这台机器用）===\n"

KEYDIR="$HOME/.ssh"
KEYFILE="$KEYDIR/fish-pocket-ai"
mkdir -p "$KEYDIR"
chmod 700 "$KEYDIR"

if [ -f "$KEYFILE" ]; then
  warn "密钥已存在，复用"
else
  ssh-keygen -t ed25519 -f "$KEYFILE" -N "" -C "fish-pocket-build" -q
  ok "已生成 $KEYFILE"
fi

# 装进授权列表
touch "$KEYDIR/authorized_keys"
chmod 600 "$KEYDIR/authorized_keys"
if grep -qF "$(cat "$KEYFILE.pub")" "$KEYDIR/authorized_keys" 2>/dev/null; then
  ok "公钥已在授权列表里"
else
  cat "$KEYFILE.pub" >> "$KEYDIR/authorized_keys"
  ok "公钥已加入 authorized_keys"
fi

# macOS 的 sshd 有时要求目标文件权限严格
chmod 600 "$KEYDIR/authorized_keys"
chmod 700 "$KEYDIR"

printf "\n=== 3/3 你要发给我的信息 ===\n\n"

USERNAME=$(whoami)
HOSTNAME_LOCAL=$(hostname)

# 找最可能的局域网地址（en0 通常是 Wi-Fi，en1 是有线）
LAN_IP=""
for iface in en0 en1 en2; do
  IP=$(ipconfig getifaddr "$iface" 2>/dev/null)
  if [ -n "$IP" ]; then LAN_IP="$IP"; break; fi
done

# 公网 IP
WAN_IP=$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || echo "")

printf "把下面这一整块复制发给我：\n\n"
printf -- "----- 复制开始 -----\n"
printf "用户名: %s\n" "$USERNAME"
printf "主机名: %s\n" "$HOSTNAME_LOCAL"
printf "局域网 IP: %s\n" "${LAN_IP:-（没找到）}"
printf "公网 IP: %s\n" "${WAN_IP:-（拿不到）}"
printf "SSH 端口: 22\n"
printf "\n私钥内容（粘给我就行）：\n"
cat "$KEYFILE"
printf -- "----- 复制结束 -----\n\n"

printf "${Y}注意${N}：\n"
printf "  · 私钥等于这台机器的钥匙，只发给我这一次，用完可以删：\n"
printf "    rm ~/.ssh/fish-pocket-ai ~/.ssh/fish-pocket-ai.pub\n"
printf "  · 如果 Mac 在路由器后面（大概率），我需要公网 IP + 端口转发，\n"
printf "    或者你先在手机上开个内网穿透（比如 Tailscale / cloudflared）。\n"
printf "  · 关掉 SSH：系统设置 → 通用 → 共享 → 远程登录 → 关\n\n"
