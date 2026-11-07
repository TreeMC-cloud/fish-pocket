#!/bin/sh
# 部署前差异预检（只读，不做任何写操作）。
#
# 为什么要有这个脚本：deploy_backend.py / push-*.sh 传的是「整棵本地工作树」，
# 不是「我改的那几个文件」。多个代理并行改不同文件时，谁先部署就会把别人
# 还没验完的半成品一起带上线。判据是「与远端不同的文件集合 == 我声明的改动集合」，
# 靠脚本比对，而不是靠「我记得没别人在改」。集合里出现任何没声明的文件就停手。
#
# 用法：
#   sh scripts/deploy-check.sh
#   sh scripts/deploy-check.sh --mine "engine/skills/x.mjs,docs/y.md"
#   sh scripts/deploy-check.sh --mine "a.mjs" --mine "b.md"
#   sh scripts/deploy-check.sh --mine "a.mjs" --verbose   # 展开全部细节
#
# 退出码：0 = 通过/仅列清单，1 = 差异集合与声明不一致（停手），
#         2 = 不在 git 仓库里 / 环境不具备（缺工具、参数写错）。
#
# 只读约定：只执行 git 的查询类命令（status、rev-parse、diff、log、merge-base），
# 全部加 GIT_OPTIONAL_LOCKS=0；绝不 add / commit / push / checkout / stash /
# restore，也不写工作区文件。临时比对用的文件只放在 mktemp -d 里，退出即删。
#
# 为什么用 /bin/sh + 内嵌 Python：本机（iSH / Alpine）的 /bin/sh 是 BusyBox ash，
# 没有 bash 数组、mapfile、进程替换；BusyBox awk 也不能以 NUL 作记录分隔符。
# 中文名、空格、换行的文件名必须用 git 的 -z 输出逐字节解析，Python 能可靠处理。
# 项目里 push-*.sh 已经在用 python3，说明它在目标环境可用。

set -u

# 为什么 export：让本脚本拉起的每一个 git 子进程都继承这个设置，
# 保证 status / diff 这类只读查询也不会顺手刷新索引（写 .git/index）。
GIT_OPTIONAL_LOCKS=0
export GIT_OPTIONAL_LOCKS

# 为什么关掉 quotepath：默认非 ASCII 路径会被 git 转义成 \345\234... 形式，
# 中文文件名既看不懂，也没法和 --mine 里手写的中文路径做字符串比对。
GIT='git -c core.quotepath=false'

# ---------- 参数解析（POSIX 写法，不依赖 bash 数组）----------
MINE_ARG=''
VERBOSE=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --mine)
            # 为什么要求带值：漏写值时不能静默当成「没有声明」，那会放过一个
            # 本该严格比对的部署。
            if [ "$#" -lt 2 ] || [ -z "$2" ]; then
                echo '参数错误：--mine 后面要给出文件清单，例如 --mine "engine/a.mjs,docs/b.md"' >&2
                exit 2
            fi
            if [ -n "$MINE_ARG" ]; then MINE_ARG="$MINE_ARG,$2"; else MINE_ARG="$2"; fi
            shift 2
            ;;
        --mine=*)
            v=${1#--mine=}
            if [ -z "$v" ]; then echo '参数错误：--mine= 后面不能是空的' >&2; exit 2; fi
            if [ -n "$MINE_ARG" ]; then MINE_ARG="$MINE_ARG,$v"; else MINE_ARG="$v"; fi
            shift
            ;;
        -v|--verbose)
            # 为什么加这个开关：真实仓库一次可能有几百个文件，全打印会淹掉
            # 判据结论；默认只打印决定部署与否的那一份清单，细节用摘要。
            VERBOSE=1
            shift
            ;;
        -h|--help)
            echo '用法：sh scripts/deploy-check.sh [--mine "文件1,文件2"] [--verbose]'
            echo '  不给 --mine：只列出本地与远端不同的文件，供人工确认。'
            echo '  给了 --mine：严格比对集合，完全一致才允许部署（exit 0），多出文件就停手（exit 1）。'
            echo '  --verbose：额外展开「工作区差异」和「提交差异」的完整清单。'
            exit 0
            ;;
        *)
            echo "参数错误：不认识的参数 $1" >&2
            echo '用法：sh scripts/deploy-check.sh [--mine "文件1,文件2"]' >&2
            exit 2
            ;;
    esac
done

# ---------- 环境检查 ----------
# 为什么先查工具：缺 python3 时后面的 NUL 解析会静默出错，宁可明确报错。
for tool in git python3 mktemp; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "环境错误：缺少 $tool，无法完成预检" >&2
        exit 2
    fi
done

# 为什么用 rev-parse 而不是自己找 .git：子目录、worktree、bare 仓库都要能判定。
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo '错误：当前目录不在 git 仓库里，没法做部署前预检' >&2
    exit 2
fi
# 为什么 cd 到顶层：git status 输出的路径相对顶层；从子目录调用时若不统一，
# --mine 里写的仓库内路径就会对不上。cd 只在脚本自己的进程里生效。
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo '错误：拿不到仓库根目录' >&2; exit 2;
}
cd "$REPO_ROOT" || { echo '错误：进不去仓库根目录' >&2; exit 2; }

# ---------- 临时文件 ----------
# 为什么用 mktemp -d：题目明确说过本机 /tmp 下某些目录名建不了，随机名最稳；
# 也是为了并行跑预检时互不覆盖。退出（含 Ctrl-C）一律删干净。
TMPDIR_CHECK=$(mktemp -d) || { echo '错误：建不了临时目录' >&2; exit 2; }
cleanup() { rm -rf "$TMPDIR_CHECK"; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

STATUS_Z="$TMPDIR_CHECK/status.z"      # git status --porcelain -z 原始字节
COMMIT_Z="$TMPDIR_CHECK/commit.z"      # git diff --name-status -z 原始字节
COMMIT_LOG="$TMPDIR_CHECK/commits.txt" # 未推送提交的 short hash + 标题
DIFF_TAIL="$TMPDIR_CHECK/diff-tail.txt" # --stat 的最后一行汇总
NOTES="$TMPDIR_CHECK/notes.txt"       # 降级/跳过说明
: > "$STATUS_Z"; : > "$COMMIT_Z"; : > "$COMMIT_LOG"; : > "$DIFF_TAIL"; : > "$NOTES"

# ---------- 1. 工作区差异（未提交 + 未跟踪）----------
# 为什么用 -uall：默认 status 会把整个未跟踪目录折叠成一行（如 ?? engine/p1/），
# 而部署传的是目录里的每一个文件，折叠会让差异集合漏项。
# 为什么加 --no-renames：重命名在 -z 下会多输出一条「原路径」，集合里会出现
# 一个已不在工作树上的幽灵文件；拆成 D + A 更贴近「实际会上传什么」。
$GIT status --porcelain=v1 -z -uall --no-renames > "$STATUS_Z" 2>/dev/null || {
    echo '错误：git status 执行失败' >&2; exit 2;
}

# ---------- 2. 确定 upstream，拿未推送的提交差异 ----------
# 为什么先试 @{u} 再退回 origin/main：仓库可能配了别的 upstream 名，也可能
# 只 fetch 过 origin 却没设 tracking；两者都没有就明确说明「只报工作区差异」。
UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) || UPSTREAM=''
[ "$UPSTREAM" = '@{u}' ] && UPSTREAM=''
UPSTREAM_OK=0
if [ -n "$UPSTREAM" ] && git rev-parse --verify --quiet "$UPSTREAM^{commit}" >/dev/null 2>&1; then
    UPSTREAM_OK=1
fi
if [ "$UPSTREAM_OK" -eq 0 ] &&
   git rev-parse --verify --quiet 'refs/remotes/origin/main^{commit}' >/dev/null 2>&1; then
    UPSTREAM='origin/main'
    UPSTREAM_OK=1
fi

HAS_UPSTREAM=0
if [ "$UPSTREAM_OK" -eq 1 ]; then
    HAS_UPSTREAM=1
    # 为什么先探测 merge-base：本机这个真实仓库的 origin/main 与 HEAD 历史不相关，
    # 三段点 diff 会直接 fatal: no merge base。此时降级成两段点（不必有共同祖先），
    # 语义仍是「两棵树的状态差」，且必须把降级事实打印出来，不能悄悄换判据。
    if git merge-base "$UPSTREAM" HEAD >/dev/null 2>&1; then
        DIFF_REV="$UPSTREAM...HEAD"
    else
        echo "提示：$UPSTREAM 与 HEAD 没有共同祖先，git diff --stat $UPSTREAM...HEAD 不可用，已降级为 $UPSTREAM..HEAD（比较两棵树；远端独有文件会记作 D）" >> "$NOTES"
        DIFF_REV="$UPSTREAM..HEAD"
    fi
    # 题目指定的 --stat：只留最后一行汇总，几百行明细会淹没判定结论。
    $GIT diff --stat "$DIFF_REV" 2>/dev/null | tail -n 1 > "$DIFF_TAIL" || : > "$DIFF_TAIL"
    $GIT diff --name-status -z --no-renames "$DIFF_REV" > "$COMMIT_Z" 2>/dev/null || : > "$COMMIT_Z"
    # 为什么用 ..HEAD 列提交：只列「本地领先、远端没有」的提交。
    $GIT log --format='%h %s' "$UPSTREAM..HEAD" > "$COMMIT_LOG" 2>/dev/null || : > "$COMMIT_LOG"
else
    # 没有 upstream：按题目要求跳过提交差异，只报工作区差异。
    echo '提示：没有 upstream / origin 分支，跳过「未推送的提交差异」，只比较当前工作区差异（远端状态未知，请自行确认）' >> "$NOTES"
fi

# ---------- 3~5. 解析、合并清单、比对、打印报告 ----------
# 为什么放进 Python：BusyBox awk 无法以 NUL 分记录，中文/空格/换行文件名会错位；
# Python 读 bytes 再按 UTF-8 + surrogateescape 解码，能保住原样路径。
python3 - "$STATUS_Z" "$COMMIT_Z" "$COMMIT_LOG" "$DIFF_TAIL" "$NOTES" \
         "$HAS_UPSTREAM" "$UPSTREAM" "$MINE_ARG" "$VERBOSE" <<'PY'
import sys

(status_z, commit_z, commit_log, diff_tail, notes,
 has_upstream, upstream, mine_arg, verbose) = sys.argv[1:]


def decode(b):
    """git 的路径是任意字节；surrogateescape 让中文与异常字节都能原样进出。"""
    return b.decode('utf-8', 'surrogateescape')


def read_lines(path):
    with open(path, 'r', encoding='utf-8', errors='surrogateescape') as f:
        return f.read().splitlines()


def status_code(xy):
    """把 porcelain 两位状态码压成单字母，仅用于显示。
    为什么用 in 而不是 ==：第二位可能是空格/M/D，冲突是 UU/AA 等；
    判定只按「路径集合」进行，状态码不参与相等判断。"""
    if 'U' in xy: return 'U'
    if '?' in xy: return 'A'
    if 'D' in xy: return 'D'
    if 'A' in xy: return 'A'
    if 'R' in xy or 'C' in xy: return 'R'
    return 'M'


def parse_status(raw):
    """status -z 每条形如 'XY 路径\\0'；--no-renames 保证没有第二条原路径。"""
    out = {}
    for rec in raw.split(b'\0'):
        if not rec:
            continue
        p = decode(rec[3:])
        if p:
            out[p] = status_code(decode(rec[:2]))
    return out


def parse_name_status(raw):
    """diff --name-status -z 是 [状态][路径] 成对 NUL 记录；
    --no-renames 保证不会出现 R 的三段结构。"""
    f = raw.split(b'\0')
    if f and f[-1] == b'':
        f = f[:-1]
    out = {}
    i = 0
    while i + 1 < len(f):
        st = decode(f[i]).strip()
        p = decode(f[i + 1])
        if p:
            c = st[0] if st else 'M'
            out[p] = c if c in 'MADCRTUX' else 'M'
        i += 2
    return out


def parse_mine(arg):
    """--mine 是逗号分隔的仓库内相对路径；允许 ./ 前缀、空段、重复项、包裹引号。
    为什么做 norm：用户常从 git status 复制粘贴，带 ./ 或尾随空格很常见。"""
    out, seen = [], set()
    for part in arg.split(','):
        p = part.strip()
        if len(p) >= 2 and p[0] == p[-1] and p[0] in ('"', "'"):
            p = p[1:-1].strip()
        while p.startswith('./'):
            p = p[2:]
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return out


work = parse_status(open(status_z, 'rb').read())
comm = parse_name_status(open(commit_z, 'rb').read())

# 合并：为什么用 dict 而不是列表拼接——同一文件既改了又提交过，只应算一条差异。
# 工作区状态优先，因为部署传的是工作树里的最终内容。
all_status = dict(comm)
all_status.update(work)
work_items = sorted(work.items())
commit_items = sorted(comm.items())
all_items = [(p, all_status[p]) for p in sorted(all_status)]

mine = parse_mine(mine_arg)
notes_lines = read_lines(notes)
commits = read_lines(commit_log)
stat_tail = read_lines(diff_tail)

# ---------- 输出 ----------
print('部署前预检（只读，不改任何东西）')
print()
for n in notes_lines:
    print(n)
if notes_lines:
    print()

# 总清单放在最前：它是唯一用于判定的集合，必须一眼可见。
if all_items:
    print('本地与远端不同的文件（%d 个）：' % len(all_items))
    for p, c in all_items:
        print('  %s  %s' % (c, p))
    print()
else:
    print('本地与远端不同的文件：0 个（没有检测到差异）')
    print()

# 工作区干净与否单独说清楚（题目要求的固定措辞）
if not work_items:
    print('没有未提交的改动')
else:
    print('工作区差异（%d 个）：' % len(work_items))
    if verbose == '1':
        for p, c in work_items:
            print('  %s  %s' % (c, p))
    else:
        print('  （清单已并入上面；用 --verbose 展开）')
print()

if has_upstream == '1':
    if commit_items:
        print('未推送提交带来的差异（%d 个文件）：' % len(commit_items))
        if verbose == '1':
            for p, c in commit_items:
                print('  %s  %s' % (c, p))
        else:
            print('  （清单已并入上面；用 --verbose 展开）')
        print()
    else:
        print('本地与 %s 相比，提交里没有额外改动' % upstream)
        print()
    if stat_tail:
        print('git diff --stat 汇总：%s' % stat_tail[-1].strip())
        print()
    if commits:
        print('未推送的提交：%d 个' % len(commits))
        for line in commits:
            print('  ' + line)
        print()
    else:
        print('未推送的提交：0 个')
        print()

# ---------- 判定 ----------
if not mine:
    # 没给 --mine：按题目要求只列清单 + 人工确认提示，exit 0
    print('⚠ 没给 --mine：请确认上面这些就是你自己的改动，再执行部署。')
    print('  严格模式：sh scripts/deploy-check.sh --mine "文件1,文件2"')
    sys.exit(0)

mine_set = set(mine)
all_set = set(p for p, _ in all_items)
extra = sorted(all_set - mine_set)     # 不是我改的 → 必须停手
missing = sorted(mine_set - all_set)   # 声明了但没差异 → 提醒，但不阻断

if not extra:
    print('✅ 差异集合与声明完全一致（%d 个文件），可以部署' % len(mine_set))
    if missing:
        print('  提醒：声明了但实际没有差异的文件（不影响判定）：')
        for p in missing:
            print('    ' + p)
    print()
    print('exit 0')
    sys.exit(0)

print('⚠ 声明要部署的是 %d 个文件，但实际有 %d 个不同：' % (len(mine_set), len(all_set)))
print('  不是你改的：')
for p in extra:
    print('    ' + p)
if missing:
    print('  声明了但实际没有差异：')
    for p in missing:
        print('    ' + p)
print('  → 停手。要么把它加进 --mine，要么确认它不需要部署。')
print()
print('exit 1')
sys.exit(1)
PY
RC=$?
exit "$RC"
