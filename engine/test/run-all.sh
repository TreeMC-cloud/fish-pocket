#!/bin/sh
# 跑能在这个环境跑的测试，汇总结果。
#
# 为什么需要它：37 个测试文件里有一批依赖原生模块（nodejs-mobile、libgit2、
# sharp），在 iSH / 开发机上必然 ERR_MODULE_NOT_FOUND。逐个手动跑、再分辨
# "失败"和"环境不支持"很容易搞混——而这个项目最怕的就是把
# "没验证"当成"验证通过"。
#
# 所以这里明确分开两种跳过：
#   SKIP  依赖原生模块，本环境跑不了（不是代码问题）
#   FAIL  真的失败
#
# ## 可移植性（踩过的坑）
#
# 第一版用了 `timeout 180 node ...`，本地 iSH 有，但 **macOS runner 没有**——
# `timeout` 属于 GNU coreutils，macOS 默认不带。结果是每个测试都拿到
# "command not found"，脚本把它们全报成 no-output 失败，一次 41 个红。
#
# 现在不用 timeout：超时判断交给 Node 自己（`--test-timeout`），
# 脚本只负责跑和归类，不依赖任何非 POSIX 命令。
#
# 用法：
#   sh test/run-all.sh              全部
#   sh test/run-all.sh task-        只跑名字里含 task- 的
set -u

cd "$(dirname "$0")/.." || exit 1

FILTER="${1:-}"
pass=0
fail=0
skipped=""
failed=""

for f in test/*.test.mjs; do
  name=$(basename "$f")
  if [ -n "$FILTER" ]; then
    case "$name" in
      *"$FILTER"*) ;;
      *) continue ;;
    esac
  fi

  # 超时由 Node 管：单个测试文件 120 秒没结束就算失败。
  # 不用 shell 的 timeout（macOS 没有）。
  #
  # rc 必须先初始化：`set -u` 下任何未定义变量都会让脚本直接退出，
  # 而 `out=$(...)` 在某些 shell 里的赋值时序不保证——CI 上就是
  # `line 61: rc: unbound variable`，整个测试步骤一行断言都没跑完就红了。
  rc=0
  out=$(node --test-timeout=120000 "$f" 2>&1) || rc=$?

  # 原生模块缺失：明确跳过，不算失败
  if echo "$out" | grep -q "ERR_MODULE_NOT_FOUND\|Cannot find module\|Cannot find package"; then
    skipped="$skipped $name"
    continue
  fi

  p=$(echo "$out" | grep -E "^# pass" | awk '{print $3}')
  fl=$(echo "$out" | grep -E "^# fail" | awk '{print $3}')
  # Node 24 默认用 spec reporter（`ℹ tests 1` / `✔ …`），不再输出 TAP 的 `# pass`。
  # 两种格式都要认，否则 CI 上每个测试都成了"没有输出汇总"。
  if [ -z "$p" ]; then
    p=$(echo "$out" | grep -E "^ℹ pass" | awk '{print $3}')
    fl=$(echo "$out" | grep -E "^ℹ fail" | awk '{print $3}')
  fi
  if [ -z "$p" ]; then
    # 再退一步：数 ✔ 的个数（spec 格式单文件汇总缺失时的兜底）
    p=$(echo "$out" | grep -c "✔")
    fl=$(echo "$out" | grep -c "✖")
    [ "$p" = "0" ] && p=""
  fi
  if [ -z "$p" ]; then
    # 没有 TAP 汇总行：把前几行打出来，否则"为什么失败"要靠猜。
    # 注意 rc 可能在部分 shell 下没被赋值（set -u 会直接退出），
    # 所以用默认值兜住：${rc:-?}
    failed="$failed $name(no-output,rc=${rc:-?})"
    fail=$((fail + 1))
    echo "  !! $name 没有输出汇总（退出码 ${rc:-?}），前几行："
    echo "$out" | head -3 | sed 's/^/     /'
    continue
  fi
  pass=$((pass + p))
  fail=$((fail + fl))
  if [ "$fl" != "0" ]; then
    failed="$failed $name(fail=$fl)"
    echo "  !! $name 失败 $fl 个"
    echo "$out" | grep -A3 "^not ok" | head -8 | sed 's/^/     /'
  fi
done

printf '\n通过 %d 个断言，失败 %d\n' "$pass" "$fail"
[ -n "$skipped" ] && printf '环境不支持（缺原生模块）:%s\n' "$skipped"
if [ -n "$failed" ]; then
  printf '有问题的文件:%s\n' "$failed"
  exit 1
fi
exit 0
