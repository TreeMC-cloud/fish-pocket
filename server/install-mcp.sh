#!/bin/sh
# 工作台 MCP 服务器 · 一键部署到客户自己的 Linux
#
# 用法（在客户服务器上）：
#   curl -fsSL <这个脚本的地址> | sh
# 或本地：
#   sh install-mcp.sh
#
# 装完会打印连接信息，客户把它填进 App 的「设置 → 远程工作台」即可。
set -eu

WB_DIR="${WB_DIR:-/opt/wb}"
PORT="${PORT:-8092}"
SERVICE=/etc/systemd/system/wb-mcp.service

say() { printf '%s\n' "$*"; }
die() { printf '错误: %s\n' "$*" >&2; exit 1; }

say "== 工作台 MCP 服务器安装 =="

# ---- 前置检查 ----
command -v node >/dev/null 2>&1 || die "没有 node。先装 Node.js 18+（node -v 确认）"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Node 版本太低（$(node -v)），需要 18 以上"
say "node: $(node -v)"

# ---- 工作台在不在 ----
if [ ! -f "$WB_DIR/app.mjs" ]; then
  die "没找到工作台（$WB_DIR/app.mjs）。先部署 sigma-agent 工作台，或用 WB_DIR=路径 指定"
fi
say "工作台: $WB_DIR"

KEY_FILE="$WB_DIR/data/.access.key"
if [ -f "$KEY_FILE" ]; then
  say "口令文件: 已存在（$(wc -c < "$KEY_FILE" | tr -d ' ') 字节）"
else
  say "口令文件: 不存在，跳过鉴权（工作台也没配口令）"
fi

# ---- 放文件 ----
if [ -f "$(dirname "$0")/mcp_server.mjs" ]; then
  cp "$(dirname "$0")/mcp_server.mjs" "$WB_DIR/mcp_server.mjs"
  say "已复制 mcp_server.mjs"
elif [ -f /tmp/mcp_server.mjs ]; then
  cp /tmp/mcp_server.mjs "$WB_DIR/mcp_server.mjs"
  say "已从 /tmp 复制 mcp_server.mjs"
else
  [ -f "$WB_DIR/mcp_server.mjs" ] || die "找不到 mcp_server.mjs，把它和本脚本放同一目录"
fi

# ---- 语法自检：坏文件不要装进服务 ----
node --check "$WB_DIR/mcp_server.mjs" || die "mcp_server.mjs 语法错误"
say "语法检查: 通过"

# ---- 端口占用 ----
if command -v ss >/dev/null 2>&1 && ss -tln 2>/dev/null | grep -q ":$PORT "; then
  die "端口 $PORT 已被占用。用 PORT=其他端口 重试"
fi

# ---- systemd 服务 ----
if [ -d /etc/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  cat > "$SERVICE" <<EOF
[Unit]
Description=sigma-agent 工作台 MCP 服务器
After=network.target

[Service]
Type=simple
WorkingDirectory=$WB_DIR
Environment=PORT=$PORT
Environment=WB_URL=http://127.0.0.1:8091
ExecStart=$(command -v node) $WB_DIR/mcp_server.mjs
Restart=always
RestartSec=3
StandardOutput=append:/var/log/wb-mcp.log
StandardError=append:/var/log/wb-mcp.log

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable wb-mcp >/dev/null 2>&1 || true
  systemctl restart wb-mcp
  sleep 2
  if systemctl is-active --quiet wb-mcp; then
    say "systemd 服务: 已启动并设为开机自启"
  else
    say "systemd 服务启动失败，日志："
    tail -20 /var/log/wb-mcp.log 2>/dev/null || journalctl -u wb-mcp -n 20 --no-pager 2>/dev/null || true
    die "见上方日志"
  fi
else
  say "没有 systemd，手动启动："
  say "  cd $WB_DIR && PORT=$PORT nohup node mcp_server.mjs > /var/log/wb-mcp.log 2>&1 &"
  cd "$WB_DIR" && PORT=$PORT nohup node mcp_server.mjs > /var/log/wb-mcp.log 2>&1 &
  sleep 2
fi

# ---- 自检 ----
say ""
say "== 自检 =="
if command -v curl >/dev/null 2>&1; then
  OUT=$(curl -sS -m 5 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)
  if [ -n "$OUT" ]; then
    say "本地健康检查: $OUT"
  else
    die "健康检查没有响应，服务可能没起来"
  fi
fi

# ---- 对外地址 ----
IP=$( (command -v curl >/dev/null 2>&1 && curl -sS -m 5 https://api.ipify.org 2>/dev/null) || echo "你的服务器IP")
say ""
say "== 装好了，把下面填进 App =="
say ""
say "  服务器地址: http://$IP:$PORT"
if [ -f "$KEY_FILE" ]; then
  say "  访问口令:   $(cat "$KEY_FILE")"
else
  say "  访问口令:   留空"
fi
say ""
say "  路径：App → 设置 → 远程工作台 → 填上面两项 → 测试连接 → 保存"
say "  然后从后台划掉 App 重开一次，Agent 就会拿到远程工具。"
say ""
say "  注意："
say "   - 端口 $PORT 要在防火墙/安全组放行，否则手机连不上"
say "   - 建议前面挂 Nginx 加 HTTPS，口令走明文有风险"
say "   - 停服务: systemctl stop wb-mcp"
say "   - 看日志: tail -f /var/log/wb-mcp.log"
