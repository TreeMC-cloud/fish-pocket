// cost.mjs —— 每轮花了多少 token，看得见才好谈优化
//
// ## 为什么需要
//
// 之前只知道「跑了多少轮」，不知道每轮烧多少。于是：
//   · 说「这次改动值得吗」没有依据
//   · 说「哪类任务最贵」只能靠感觉
//   · 上下文快满了也看不出来（压缩是被动的）
//
// ## 数据从哪来
//
// 引擎拿不到每轮的 token 用量（那在会话投影里，turn/end 这一刻读不全），
// 所以由 **App 侧**在 turn/end 时把用量增量写进 `<data>/usage.jsonl`。
// 引擎这边只做聚合——聚合逻辑最该被测试，也最容易写错。
//
// 行的形状（App 写入）：
//   {at, session, turn, input, output, cacheRead}
//
// ## 只做聚合，不做判断
//
// 这里不算钱：单价随 provider/模型变，写死会误导。只给 token 数，
// 换算留给用的人（界面上显示「约」并说明按什么单价算）。

import fs from 'node:fs';
import path from 'node:path';

export const USAGE_FILE = 'usage.jsonl';
/** 只保留最近多少天：久了没人看，还占地方。 */
const KEEP_DAYS = 30;

function usagePath(dataDir) { return path.join(dataDir, USAGE_FILE); }

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * 聚合用量。
 *
 * @returns {{ok:boolean, total:object, today:object, days:number, lastAt:number, sessions:number}}
 */
export function summarize(dataDir, { now = Date.now() } = {}) {
  const rows = readJsonl(usagePath(dataDir));
  if (rows.length === 0) {
    return { ok: false, reason: '还没有用量记录', total: zero(), today: zero(), days: 0, lastAt: 0, sessions: 0 };
  }

  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();

  const total = zero();
  const today = zero();
  const days = new Set();
  const sessions = new Set();
  let lastAt = 0;

  for (const r of rows) {
    const at = Number(r.at) || 0;
    const input = num(r.input);
    const output = num(r.output);
    const cacheRead = num(r.cacheRead);
    total.input += input; total.output += output; total.cacheRead += cacheRead; total.turns += 1;
    if (at >= dayStartMs) { today.input += input; today.output += output; today.cacheRead += cacheRead; today.turns += 1; }
    if (at > 0) days.add(new Date(at).toISOString().slice(0, 10));
    if (typeof r.session === 'string') sessions.add(r.session);
    if (at > lastAt) lastAt = at;
  }

  return { ok: true, total, today, days: days.size, lastAt, sessions: sessions.size };
}

function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }
function zero() { return { input: 0, output: 0, cacheRead: 0, turns: 0 }; }

/** 人话一句，给 headline 用。 */
export function describe(cost) {
  if (!cost?.ok) return null;
  const t = cost.today;
  if (t.turns === 0) return null;
  return `今日 ${fmt(t.input + t.cacheRead)} 进 / ${fmt(t.output)} 出`;
}

/** 12345 → 12.3k */
export function fmt(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(1)}k`;
  return `${(v / 1_000_000).toFixed(2)}M`;
}

/**
 * 清理过期记录。
 *
 * 由调度循环偶尔调用。为什么保留 30 天：够看出「最近是不是越用越贵」，
 * 又不至于让文件无限长（每轮一行，一年就是几万行）。
 */
export function prune(dataDir, { now = Date.now(), keepDays = KEEP_DAYS } = {}) {
  const file = usagePath(dataDir);
  const rows = readJsonl(file);
  if (rows.length === 0) return { kept: 0, dropped: 0 };
  const cutoff = now - keepDays * 24 * 60 * 60_000;
  const kept = rows.filter((r) => (Number(r.at) || 0) >= cutoff);
  const dropped = rows.length - kept.length;
  if (dropped === 0) return { kept: kept.length, dropped: 0 };
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { return { kept: rows.length, dropped: 0 }; }
  return { kept: kept.length, dropped };
}
