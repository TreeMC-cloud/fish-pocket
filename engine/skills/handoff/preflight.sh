#!/bin/sh
# 换会话前的总检查 —— 把三个工具串成一道闸门。
#
# 治的是最危险的一种情况：轮次超线了必须换会话，但交接没写。
# 这时候换 = 进度直接丢掉，而且没人会发现（新会话读不到交接，会当成全新任务）。
#
# 三个工具各自只回答一个问题，单独跑很容易漏掉某个：
#   turns.mjs   —— 是不是该换会话了
#   handoff.mjs —— 交接写好了吗
#   sentinel.mjs —— 有没有人在等我 / 我发出去没回的
#
# 这个脚本按固定顺序跑完，任一不通过就挡住。
#
# 用法：
#   sh preflight.sh [工作目录]
#
# 退出码：0 可以换会话 / 1 不能换（看上面哪条没过）/ 2 用法错误

set -u
DIR="${1:-.}"
TOOLS="${DSH_TOOLS:-$(cd "$(dirname "$0")/../.." && pwd)/skills}"

if [ ! -d "$DIR" ]; then
  echo "错误：目录不存在：$DIR"
  exit 2
fi

echo "=== 换会话前检查 ==="
echo

BLOCKERS=0
WARNINGS=0

# ---- 1. 轮次：是不是该换了 ----
echo "[1/3] 会话轮次"
TURNS_OUT=$(node "$TOOLS/cost-guard/turns.mjs" status 2>&1)
TURNS_CODE=$?
echo "$TURNS_OUT" | sed 's/^/      /'
case $TURNS_CODE in
  0) ;; # 安全区，不用换
  1) # 超线，该换 —— 但必须先写交接
     WARNINGS=$((WARNINGS + 1))
     ;;
  2) echo "      ✗ turns.mjs 无法运行（用法或数据问题）"
     BLOCKERS=$((BLOCKERS + 1))
     ;;
esac
echo

# ---- 2. 交接：写好了吗 ----
echo "[2/3] 交接文件"
HANDOFF_OUT=$(node "$TOOLS/handoff/handoff.mjs" check "$DIR" 2>&1)
HANDOFF_CODE=$?
echo "$HANDOFF_OUT" | sed 's/^/      /'
if [ $HANDOFF_CODE -ne 0 ]; then
  BLOCKERS=$((BLOCKERS + 1))
fi
echo

# ---- 3. 台账：有没有人卡着 ----
echo "[3/3] 派单台账"
OPEN_OUT=$(node "$TOOLS/dispatch-protocol/sentinel.mjs" open 2>&1)
OPEN_CODE=$?
if [ $OPEN_CODE -eq 1 ]; then
  echo "$OPEN_OUT" | sed 's/^/      /'
  WARNINGS=$((WARNINGS + 1))
else
  echo "      没有未回执的派单"
fi
AWAIT_OUT=$(node "$TOOLS/dispatch-protocol/sentinel.mjs" awaited 2>&1)
AWAIT_CODE=$?
if [ $AWAIT_CODE -eq 1 ]; then
  echo "$AWAIT_OUT" | sed 's/^/      /'
  WARNINGS=$((WARNINGS + 1))
fi
echo

# ---- 结论 ----
echo "=== 结论 ==="
if [ $BLOCKERS -gt 0 ]; then
  echo "❌ 不能换会话：交接不合格，换了会丢进度"
  echo "   先把进度、下一步、卡点写进 $DIR/HANDOFF.md，再跑一次本脚本"
  echo "   写不出「下一步」说明这一轮白干了 —— 别急着换"
  exit 1
fi

if [ $TURNS_CODE -eq 1 ]; then
  echo "✅ 可以换会话（交接已合格）"
  echo "   执行：node \"$TOOLS/cost-guard/turns.mjs\" reset --reason \"已交接\""
  [ $WARNINGS -gt 1 ] && echo "   ⚠ 还有 $((WARNINGS - 1)) 项未回执，换之前最好先处理"
  exit 0
fi

if [ $WARNINGS -gt 0 ]; then
  echo "⚠ 还没到换会话的时候，但有 $WARNINGS 项需要处理"
  exit 1
fi

echo "✅ 一切正常，继续干活"
exit 0
