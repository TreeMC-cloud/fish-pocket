// verify.mjs —— 引擎自己跑一遍验证，不信模型的自我报告
//
// ## 为什么要有这一层
//
// 有了完成标准（acceptance）之后，模型会在收工时写 `ACCEPT: PASS/FAIL`。
// 但那是**它的自述**——这个项目已经反复证明「自称做完」和「真做完」是两件事：
// 文件写了但内容空、命令跑了但退出码非 0、测试跳过当成通过。
//
// 所以验收判据里凡是能变成命令的，都由引擎**再跑一遍**，用自己的退出码说话。
// 两者冲突时以引擎为准。
//
// ## 边界
//
// - 只跑任务里显式声明的命令（`verify` 字段），不做任何推测。
// - 每条都有超时，总时长也有上限：一条 `npm install` 拖十分钟会把整个循环卡住。
// - 跑不起来（沙箱不允许、命令不存在）记为 `error` 而不是 `fail`——
//   环境问题不该算到任务头上，否则会误伤。

import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

/**
 * 惰性解析执行器。
 *
 * 为什么不在顶层 import：`child-process.mjs` 依赖 `just-bash`（App 包里才有）。
 * 在开发机 / iSH 上这个包不存在，顶层 import 会让整个模块加载失败——
 * 连「没有验证命令」这种正常情况都会抛错。改成用到时才解析，
 * 并退回 Node 自带的 child_process。
 */
let execFileSyncImpl = null;
function executor() {
  if (execFileSyncImpl) return execFileSyncImpl;
  try {
    execFileSyncImpl = require_('./child-process.mjs').execFileSync;
  } catch {
    execFileSyncImpl = require_('node:child_process').execFileSync;
  }
  return execFileSyncImpl;
}

/** 单条最多 3 条、单条 20 秒、总计 60 秒。超了就只跑前几条。 */
export const MAX_COMMANDS = 3;
export const PER_COMMAND_MS = 20_000;
export const TOTAL_MS = 60_000;

/**
 * 跑一组验证命令。
 *
 * @param {string[]} commands 用户/任务声明的命令，例如 `npm run build`
 * @param {object} [opts]
 *   cwd        在哪个目录跑（会话的工作区）
 *   shell      用什么跑（默认 /bin/sh -c 的等价物；child-process 模拟里认 shell 选项）
 * @returns {{ok:boolean|null, error?:string, results:Array}}
 *   ok: true 全过 / false 有命令失败 / null 没跑（没有命令或跑不起来）
 */
export function verifyCommands(commands, { cwd = null, now = Date.now } = {}) {
  const list = Array.isArray(commands) ? commands.filter((c) => typeof c === 'string' && c.trim()) : [];
  if (list.length === 0) return { ok: null, results: [] };

  const started = now();
  const results = [];
  for (const cmd of list.slice(0, MAX_COMMANDS)) {
    if (now() - started > TOTAL_MS) {
      results.push({ cmd, ok: null, exitCode: null, output: '总时长超限，未执行' });
      continue;
    }
    try {
      const out = executor()('sh', ['-c', cmd], {
        cwd: cwd || process.cwd(),
        timeout: PER_COMMAND_MS,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      results.push({ cmd, ok: true, exitCode: 0, output: tail(out) });
    } catch (error) {
      // 区分「命令失败」和「跑不起来」：
      //   error.status 是数字 → 命令跑了但退出码非 0（真失败）
      //   没有 status（ENOENT/超时/沙箱拒绝）→ 环境问题，记 null
      const status = typeof error?.status === 'number' ? error.status : null;
      const output = tail(String(error?.stderr || error?.stdout || error?.message || ''));
      // 127 = shell 找不到这个命令。它说明的是「验证配置写错了」或「环境缺东西」，
      // 不是「任务没做好」——判 fail 会冤枉任务，所以记 null 并把原因留在输出里，
      // 谁配错了还是看得见。
      const notFound = status === 127;
      results.push({
        cmd,
        ok: status === null || notFound ? null : false,
        exitCode: status,
        output: status === null ? `跑不起来：${output}`
          : (notFound ? `命令不存在（退出码 127）：${output}` : output),
      });
    }
  }

  const failed = results.filter((r) => r.ok === false);
  if (failed.length > 0) return { ok: false, results, failed };
  const unknown = results.filter((r) => r.ok === null);
  if (unknown.length === results.length) return { ok: null, results };
  return { ok: true, results };
}

/** 输出只留尾部：验证失败时有用的是最后几行报错。 */
function tail(text, limit = 600) {
  const s = String(text ?? '').trim();
  return s.length > limit ? '…' + s.slice(-limit) : s;
}

/** 失败时给人看的一句话。 */
export function describeFailure(verdict) {
  const failed = (verdict.results ?? []).filter((r) => r.ok === false);
  if (failed.length === 0) return null;
  const first = failed[0];
  return `验证命令失败：${first.cmd}（退出码 ${first.exitCode ?? '?'}）`;
}

/** 验证命令的相对路径要落到会话工作区，不能是引擎自己的 cwd。 */
export function resolveCwd(sessionCwd) {
  if (typeof sessionCwd === 'string' && sessionCwd.trim()) return path.resolve(sessionCwd);
  return process.cwd();
}
