// selfcheck.mjs —— 引擎自检：一条命令确认各闭环是否真的接上了
//
// 为什么需要它：这个项目反复出现「代码写了但没生效」，而且失败是静默的——
// 不报错、不崩溃，只是功能没用。人只有在事后发现「面板一直是空的」时才回头查。
//
// 这个模块的判断标准只有一个：**文件/包真的在那儿、真的能被读、真的新鲜**。
// 它不猜「应该没问题」，也不把「读不到」当成「没问题」——读不到就是没接上。
//
// 设计取舍：
//   1. 每项独立 try/catch。一项抛异常只影响它自己，不能让整张体检表消失。
//   2. 只读业务数据 + 一个可写性探针。除了临时文件，不写任何东西。
//   3. 路径全部从 dataDir 参数推算，不写死任何绝对路径。
//   4. 超时/陈旧要跟「不存在」分开说：两者修法完全不同。
//      不存在 → 没接线；陈旧 → 接了线但循环没在跑。混成一句话，人就会修错地方。
//
// 用法：
//   node engine/runtime/selfcheck.mjs <dataDir>

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** capability.json 超过这个时长没更新就判「陈旧」。
 *  界面每 3 秒轮询一次、调度循环 15 秒一跳，10 分钟没更新说明循环已经停了。 */
export const CAPABILITY_STALE_MS = 10 * 60 * 1000;

/** 自检结果落盘的文件名（App 侧按同名读）。 */
export const SELFCHECK_FILE = 'selfcheck.json';

const at = (dataDir, name) => path.join(dataDir, name);

/**
 * 数 jsonl 行数。
 * 只数非空行，不解析 JSON：这里的目的是「有没有在记」，不是「记的对不对」。
 * 一条坏行算一条记录——真要查内容，有 trace-accuracy 那一层在管。
 */
function countLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  let n = 0;
  for (const line of text.split('\n')) if (line.trim()) n += 1;
  return n;
}

/** 把毫秒时长说成人话，用于「多久没更新」。 */
function humanAge(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} 小时`;
  return `${(ms / 86_400_000).toFixed(1)} 天`;
}

// ── 1. 提示词 ────────────────────────────────────────────────────────────
// 提示词随 meow-memory 包发布，不在本仓库里。所以必须从**包解析结果**反推
// 目录，而不是拼一个 ../node_modules 的相对路径——提升、软链、打包都会让
// 相对路径指向一个空目录，而 fs.existsSync 对空目录同样返回 false，
// 结果就是「提示词丢了」却查不出到底丢在哪。
function checkPrompts() {
  let pkgFile;
  try {
    const require = createRequire(import.meta.url);
    pkgFile = require.resolve('meow-memory/package.json');
  } catch (err) {
    return { ok: false, detail: `找不到 meow-memory 包（${err.code ?? err.message}），提示词无从加载` };
  }
  const promptFile = path.join(path.dirname(pkgFile), 'lib', 'prompts', 'zh', 'tools.md');
  if (!fs.existsSync(promptFile)) {
    return { ok: false, detail: `包在 ${path.dirname(pkgFile)}，但缺 lib/prompts/zh/tools.md` };
  }
  const size = fs.statSync(promptFile).size;
  if (size === 0) return { ok: false, detail: 'tools.md 存在但是空文件' };
  return { ok: true, detail: `提示词就位（${size} 字节）` };
}

// ── 2. 任务表 ────────────────────────────────────────────────────────────
// 文件必须叫 tasks.json（没有前导点）：task-registry 写这个名字，
// 早先 capability 读的是 `.tasks.json`，差一个点就永远显示「还没开始干活」。
function checkTasks(dataDir) {
  const file = at(dataDir, 'tasks.json');
  if (!fs.existsSync(file)) return { ok: false, detail: 'tasks.json 不存在，任务从没被记录过' };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, detail: `tasks.json 无法解析：${err.message.slice(0, 80)}` };
  }
  const tasks = parsed?.tasks;
  if (Array.isArray(tasks)) return { ok: true, detail: `任务表可读，${tasks.length} 个任务` };
  if (tasks && typeof tasks === 'object') {
    const n = Object.keys(tasks).length;
    return { ok: true, detail: `任务表可读，${n} 个任务` };
  }
  // 能 parse 但结构不对，等于写了半截或换了格式：仍然算没接上。
  return { ok: false, detail: 'tasks.json 能解析但缺 tasks 字段，格式对不上' };
}

// ── 3. 能力快照 ──────────────────────────────────────────────────────────
// 这里的关键不是「文件在不在」，而是「是不是新鲜的」。
// 文件在、但一小时没更新，说明生成循环已经停了，面板会一直显示过期的数字，
// 比完全没有面板更误导人。所以过期的判定词必须是「陈旧」，不是「不存在」。
function checkCapability(dataDir, now) {
  const file = at(dataDir, 'capability.json');
  if (!fs.existsSync(file)) return { ok: false, detail: 'capability.json 不存在，面板没有数据源' };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, detail: `capability.json 无法解析：${err.message.slice(0, 80)}` };
  }
  const generatedAt = Number(parsed?.generatedAt);
  if (!Number.isFinite(generatedAt) || generatedAt <= 0) {
    return { ok: false, detail: 'capability.json 缺 generatedAt，无法判断新鲜度' };
  }
  const age = Math.max(0, now - generatedAt);
  if (age > CAPABILITY_STALE_MS) {
    return { ok: false, detail: `快照陈旧：已 ${humanAge(age)} 未更新（阈值 10 分钟）` };
  }
  return { ok: true, detail: `快照新鲜，${humanAge(age)}前更新` };
}

// ── 4. 定时任务视图 ──────────────────────────────────────────────────────
// schedule-view.json 由 auto-guard 的调度循环写。它不在 = 那一跳没接上，
// 界面上「定时任务」永远是空的，而 DSH 自己其实照常在投递。
function checkSchedule(dataDir) {
  const file = at(dataDir, 'schedule-view.json');
  if (!fs.existsSync(file)) return { ok: false, detail: 'schedule-view.json 不存在，定时任务没被读取过' };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, detail: `schedule-view.json 无法解析：${err.message.slice(0, 80)}` };
  }
  const rows = Array.isArray(parsed?.rows) ? parsed.rows.length : null;
  if (rows === null) return { ok: false, detail: 'schedule-view.json 缺 rows 数组，格式对不上' };
  return { ok: true, detail: `调度视图可读，${parsed?.total ?? rows} 条定时任务` };
}

// ── 5/6. 经验记录与轮次 ──────────────────────────────────────────────────
// trace 与 turns 都是「只追加」的账本，0 行是合法的初始状态：
// 刚装好、还没聊过，本来就不该有记录。所以 0 行判 ok，但 detail 必须写
// 「还没记录」——把「空」和「没接上」分开，否则真断线时也会显示正常。
function checkLedger(dataDir, name, label) {
  const file = at(dataDir, name);
  if (!fs.existsSync(file)) return { ok: false, detail: `${name} 不存在，${label}一次都没写过` };
  let n = 0;
  try {
    n = countLines(file);
  } catch (err) {
    return { ok: false, detail: `${name} 读不了：${err.message.slice(0, 80)}` };
  }
  if (n === 0) return { ok: true, detail: `${name} 是空账本，还没记录（正常初始状态）` };
  return { ok: true, detail: `${name} 有 ${n} 行记录` };
}

// ── 7. 可写性 ────────────────────────────────────────────────────────────
// 最容易被忽略的一项：iOS 上 cwd 常是只读的包目录，路径算错就会写到那里，
// 写失败还会被上层 try/catch 吞掉。真写一次再删掉，是唯一可信的判据。
function checkWritable(dataDir) {
  if (!fs.existsSync(dataDir)) return { ok: false, detail: `数据目录不存在：${dataDir}` };
  const probe = path.join(dataDir, `.selfcheck-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(probe, 'selfcheck', { mode: 0o600 });
    const back = fs.readFileSync(probe, 'utf8');
    if (back !== 'selfcheck') return { ok: false, detail: '写入后读回内容不一致' };
    return { ok: true, detail: '数据目录可写（临时文件已清理）' };
  } catch (err) {
    // 权限/只读挂载/目录被删都在这里现形，给一句能直接照做的说明。
    return { ok: false, detail: `写不进去（${err.code ?? 'ERROR'}）：${String(err.message ?? '').slice(0, 100)}` };
  } finally {
    try { fs.unlinkSync(probe); } catch { /* 删不掉不影响「能写」这个结论 */ }
  }
}

/**
 * 跑一遍自检。
 *
 * @param {string} dataDir 数据目录（通常是 DSH_IOS_DATA）。不存在也不抛，逐项如实报告。
 * @param {{ now?: number }} [opts] 注入当前时间，便于测试「陈旧」判定。
 * @returns {Promise<{ok: boolean, items: Array<{id, ok, detail}>, summary: object}>}
 */
export async function runSelfCheck(dataDir, opts = {}) {
  const now = opts.now ?? Date.now();
  if (!dataDir || typeof dataDir !== 'string') {
    throw new TypeError('runSelfCheck(dataDir)：dataDir 必须是非空字符串');
  }
  const dir = path.resolve(dataDir);

  // 每项都包一层：单项炸掉只能让该项 ok=false，不能吞掉整张表。
  // 这是本模块存在的前提——体检工具自己静默失败，比没有体检更糟。
  const runOne = (id, fn) => {
    try {
      const r = fn();
      return { id, ok: r?.ok === true, detail: String(r?.detail ?? '') };
    } catch (err) {
      return { id, ok: false, detail: `检查本身抛错：${String(err?.message ?? err).slice(0, 120)}` };
    }
  };

  const items = [
    runOne('prompts', () => checkPrompts()),
    runOne('tasks', () => checkTasks(dir)),
    runOne('capability', () => checkCapability(dir, now)),
    runOne('schedule', () => checkSchedule(dir)),
    runOne('trace', () => checkLedger(dir, '.trace.jsonl', '经验记录')),
    runOne('turns', () => checkLedger(dir, '.turns.jsonl', '轮次')),
    runOne('writable', () => checkWritable(dir)),
  ];

  const passed = items.filter((i) => i.ok).length;
  const failed = items.length - passed;
  return {
    ok: failed === 0,
    items,
    summary: {
      total: items.length,
      passed,
      failed,
      // 一句话结论，给日志/面板直接显示，不用人自己数。
      headline: failed === 0 ? `全部就绪（${passed}/${items.length}）` : `${failed} 项未就绪（${passed}/${items.length} 就绪）`,
      checkedAt: now,
      dataDir: dir,
    },
  };
}

/**
 * 跑自检并原子落盘到 `<dataDir>/selfcheck.json`。
 * tmp + rename：App 轮询时要么读到上一份完整结果，要么读到这一份，
 * 不会读到写了一半的 JSON。写失败不抛，只把错误信息带上（体检本身不该让调用方崩）。
 */
export async function writeSelfCheck(dataDir) {
  const dir = path.resolve(String(dataDir ?? ''));
  const result = await runSelfCheck(dir);
  const target = path.join(dir, SELFCHECK_FILE);
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, target);
    return { ...result, file: target };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 没生成 tmp 也无所谓 */ }
    return { ...result, file: null, writeError: String(err?.message ?? err) };
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────
// 人排查时只想要一张表：哪项 ✗、为什么。所以每项压成一行，末尾一句总结论。
export function formatSelfCheck(result) {
  const lines = [];
  const width = Math.max(...result.items.map((i) => i.id.length));
  for (const item of result.items) {
    const mark = item.ok ? '✓' : '✗';
    lines.push(`${mark} ${item.id.padEnd(width)}  ${item.detail}`);
  }
  lines.push('');
  const { passed, total, failed } = result.summary;
  lines.push(failed === 0 ? `结论：${passed}/${total} 就绪，闭环都接上了 ✓` : `结论：${passed}/${total} 就绪，${failed} 项未就绪 ✗`);
  return lines.join('\n');
}

// 直接运行的判定要留一条兜底：iSH 上 `process.argv[1]` 可能是 undefined
// （Node 的 argv 填充依赖某些系统调用），只比 argv[1] 会让脚本静默什么都不做——
// 退出码 0、零输出，看起来像"跑过了没问题"，比报错更危险。
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry) {
    try { return pathToFileURL(path.resolve(entry)).href === import.meta.url; } catch { /* 落到下面 */ }
  }
  // 兜底：脚本名出现在 argv 里且本文件被当作主模块加载
  return process.argv.some((a) => a && a.endsWith('selfcheck.mjs'));
})();

if (invokedDirectly) {
  const dataDir = process.argv[2] || process.env.DSH_IOS_DATA || os.homedir();
  const result = await runSelfCheck(dataDir);
  console.log(`引擎自检 · ${result.summary.dataDir}`);
  console.log('─'.repeat(48));
  console.log(formatSelfCheck(result));
  // 有未就绪项返回 1，方便脚本/冒烟测试直接看退出码。
  process.exitCode = result.ok ? 0 : 1;
}
