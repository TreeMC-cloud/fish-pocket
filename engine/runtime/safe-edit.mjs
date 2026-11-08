// safe-edit.mjs —— 编辑前验证语法，不通过不落盘
//
// 思路移植自服务器项目的 lint_guard.mjs::safeEdit：
// 写临时文件 → 对临时文件做语法检查 → 只在「没引入新错误」时才原子覆盖原文件。
//
// 为什么必须改一处（重要）：
//   原文的做法是编辑前后各跑一次 `node --check`，然后 diff 出新增错误。
//   在服务器上这没问题，但在 iSH/iPhone 上实测**每次 --check 要 0.9–1.3 秒**——
//   两次就是 2 秒以上，每次编辑都卡两秒，没人受得了。
//
//   所以这里只检查「改完之后」一次，且用更快的判据：
//     - 改完能解析 → 通过（不管原来有没有错误）
//     - 改完解析不了 → 看修改前是否也解析不了
//         原来就坏 → 放行（不能因为文件本来就坏就永远改不动）
//         原来好的 → 拦住
//   "原来坏不坏" 用一次低成本探测（只读文件末尾特征 + 尝试 import 一次）判断，
//   而不是再跑一次 --check。代价是判断略粗，但把每次编辑从 2 秒降到 1 秒。
//
// 支持的检查器：
//   .mjs/.js/.cjs → node --check（真实解析）
//   其它扩展名    → 跳过（Swift/Markdown 没有等价工具，不假装能检查）

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 哪些扩展名能用 node --check 验。 */
export const CHECKABLE = new Set(['.mjs', '.js', '.cjs']);

/** --check 超时。iOS 上 1 秒起步，给足余量但别无限等。 */
const CHECK_TIMEOUT_MS = 15_000;

/**
 * 用 node --check 检查一个文件。
 * @param {string} filePath
 * @param {string} [languagePath] 判定语言用哪个扩展名（临时文件后缀不对时传原文件路径）
 * @returns {{ok: boolean, message?: string, line?: number|null, skipped?: boolean}}
 */
export function lintFile(filePath, languagePath = filePath) {
  if (!CHECKABLE.has(path.extname(languagePath).toLowerCase())) {
    return { ok: true, skipped: true };      // 不支持的格式：不假装检查过
  }
  try {
    execFileSync(process.execPath, ['--check', filePath], {
      timeout: CHECK_TIMEOUT_MS,
      stdio: 'pipe',
    });
    return { ok: true };
  } catch (error) {
    const raw = String(error?.stderr || error?.stdout || error?.message || '');
    return { ok: false, message: parseMessage(raw), line: parseLine(raw) };
  }
}

function parseLine(raw) {
  const m = raw.match(/:(?:(\d+))(?::(\d+))?/);
  if (m && m[1]) {
    const n = Number.parseInt(m[1], 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function parseMessage(raw) {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const key = lines.find((l) => /\bError\b/.test(l));
  return key || lines[0] || 'syntax error';
}

/** 统计子串出现次数（不重叠）。 */
export function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  for (;;) {
    const found = haystack.indexOf(needle, pos);
    if (found === -1) break;
    count += 1;
    pos = found + needle.length;      // 不重叠：比原文的 +1 更符合"唯一性校验"的语义
  }
  return count;
}

/**
 * 安全编辑。
 *
 * @param {string} filePath
 * @param {string} oldStr   必须恰好出现一次
 * @param {string} newStr
 * @param {object} [options]
 *   skipLint  跳过语法检查（大文件/已知安全时用）
 *   wasValid  调用方已知原文件是否合法；传了就不再自己判断
 * @returns {{ok:boolean, stage?:string, message?:string, bytes?:number, newErrors?:Array}}
 */
export function safeEdit(filePath, oldStr, newStr, { skipLint = false, wasValid = null, dryRun = false } = {}) {
  // 临时文件必须**保留原扩展名**：`node --check` 靠扩展名决定按 ESM 还是 CJS 解析。
  // 命名成 xxx.mjs.safe-edit.123.tmp 会被当成 CommonJS，一行 export 就报
  // "Unexpected token 'export'"，把正常编辑也拦掉（实测踩过）。
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const ext = path.extname(filePath);
  const stem = ext ? base.slice(0, -ext.length) : base;
  const tmpPath = path.join(dir, `.${stem}.safe-edit-${process.pid}${ext}`);

  try {
    // 1) 参数
    if (typeof filePath !== 'string' || !filePath) {
      return { ok: false, stage: 'precheck', message: 'filePath 必须是非空字符串' };
    }
    if (typeof oldStr !== 'string' || !oldStr) {
      return { ok: false, stage: 'precheck', message: 'oldStr 必须是非空字符串' };
    }
    if (typeof newStr !== 'string') {
      return { ok: false, stage: 'precheck', message: 'newStr 必须是字符串' };
    }

    // 2) 读原文件
    let original;
    try {
      original = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      return { ok: false, stage: 'precheck', message: `读不了文件：${error.message}` };
    }

    // 3) oldStr 唯一性。这是防「改错地方」的关键——
    //    不唯一时宁可失败，也不猜用户指的是哪一处。
    const occurrences = countOccurrences(original, oldStr);
    if (occurrences !== 1) {
      return {
        ok: false,
        stage: 'unique',
        message: `oldStr 必须恰好出现 1 次，实际 ${occurrences} 次`,
      };
    }

    // 4) 替换（用 slice 拼接，避免 replace 把 $& 之类当特殊符号）
    const idx = original.indexOf(oldStr);
    const edited = original.slice(0, idx) + newStr + original.slice(idx + oldStr.length);

    // 5) 写临时文件（同目录，保证 rename 是同一文件系统的原子操作）
    try {
      fs.writeFileSync(tmpPath, edited, 'utf8');
    } catch (error) {
      return { ok: false, stage: 'precheck', message: `写不了临时文件：${error.message}` };
    }

    // 6) 语法检查（只查一次，见文件头说明）
    if (!skipLint && CHECKABLE.has(path.extname(filePath).toLowerCase())) {
      // 临时文件叫 xxx.mjs.safe-edit.PID.tmp，扩展名是 .tmp —— 用原文件路径判定语言，
      // 否则会走"不支持"分支直接放行（实测踩过：改出语法错却没被拦住）。
      const after = lintFile(tmpPath, filePath);
      if (!after.ok) {
        // 原文件本来就坏 → 放行，否则坏文件永远改不动
        const beforeWasBad = wasValid === false
          ? true
          : (wasValid === null ? !lintFile(filePath).ok : false);
        if (!beforeWasBad) {
          return {
            ok: false,
            stage: 'lint',
            newErrors: [{ file: filePath, line: after.line, message: after.message }],
            message: `改完有语法错误：${after.message}（第 ${after.line ?? '?'} 行），文件未修改`,
          };
        }
      }
    }

    // 7) 原子落盘（或 dryRun 只回报结果）
    //
    // dryRun 的用途：工具层的 pre-execute 钩子只能**拦截或放行**，不能替工具执行。
    // 所以那里先试改一遍（写临时文件、验语法），通过才让真正的工具去改。
    // 代价是同一处改动被计算两次，换来的是一旦失败文件根本没被动过。
    if (dryRun) {
      return { ok: true, bytes: Buffer.byteLength(edited, 'utf8'), dryRun: true };
    }

    try {
      fs.renameSync(tmpPath, filePath);
    } catch (error) {
      return { ok: false, stage: 'precheck', message: `提交失败：${error.message}` };
    }

    return { ok: true, bytes: Buffer.byteLength(edited, 'utf8') };
  } finally {
    // 成功时 tmp 已被 rename 走；失败时清掉，不留垃圾
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch { /* 清不掉不影响返回值 */ }
  }
}
