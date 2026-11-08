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
  [ -n "$FILTER" ] && case "$name" in *"$FILTER"*) ;; *) continue ;; esac

  out=$(timeout 180 node "$f" 2>&1)
  rc=$?

  # 原生模块缺失：明确跳过，不算失败
  if echo "$out" | grep -q "ERR_MODULE_NOT_FOUND\|Cannot find module\|Cannot find package"; then
    skipped="$skipped $name"
    continue
  fi
  # 超时
  if [ $rc -eq 124 ]; then
    failed="$failed $name(timeout)"
    fail=$((fail + 1))
    continue
  fi

  p=$(echo "$out" | grep -E "^# pass" | awk '{print $3}')
  fl=$(echo "$out" | grep -E "^# fail" | awk '{print $3}')
  if [ -z "$p" ]; then
    failed="$failed $name(no-output)"
    fail=$((fail + 1))
    continue
  fi
  pass=$((pass + p))
  fail=$((fail + fl))
  [ "$fl" != "0" ] && failed="$failed $name(fail=$fl)"
done

printf '\n通过 %d 个断言，失败 %d\n' "$pass" "$fail"
[ -n "$skipped" ] && printf '环境不支持（缺原生模块）:%s\n' "$skipped"
if [ -n "$failed" ]; then
  printf '有问题的文件:%s\n' "$failed"
  exit 1
fi
exit 0
