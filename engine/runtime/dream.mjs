// dream.mjs —— 离线整理：把散乱的 trace 变成结构化的经验
//
// 为什么需要它：distill 是"一次性提炼"，跑一次产几条候选就完了。
// 真正需要的是一套**定期整理**：
//   - 积累到一定量才跑（避免每次都提炼出噪声）
//   - 一次只处理有限量（有预算，不能把 App 拖死）
//   - 同一时间只允许一个 Dream 在跑（有锁，避免并发写坏库）
//   - 每次改动都留审计（能回答"这条技能是哪次整理产生的"）
//   - 只写候选库，绝不直接激活（人确认后才生效）
//
// 这一层对齐 Phase 4 的「预算/锁/审计/取消；只改候选库」。

import fs from 'node:fs';
import path from 'node:path';
import { distill as defaultDistill } from './consolidate.mjs';

/** Dream 的默认预算：单次最多处理多少条 trace。 */
export const DEFAULT_BUDGET = 200;
/** 至少积累这么多新 trace 才值得跑一次。 */
export const MIN_NEW = 20;
/** 锁超过这么久视为僵死（崩溃留下的），可以抢占。 */
export const LOCK_STALE_MS = 10 * 60_000;

const file = (dataDir, name) => path.join(dataDir || process.env.DSH_IOS_DATA || process.cwd(), name);

/** Dream 状态：上次跑到哪、上次什么时候跑的。 */
function readState(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(file(dataDir, '.dream-state.json'), 'utf8'));
    return {
      lastRunAt: Number(raw.lastRunAt) || 0,
      lastTraceAt: Number(raw.lastTraceAt) || 0,
      runs: Number(raw.runs) || 0,
    };
  } catch {
    return { lastRunAt: 0, lastTraceAt: 0, runs: 0 };
  }
}

function writeState(dataDir, state) {
  const target = file(dataDir, '.dream-state.json');
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/** 加锁。返回 {acquired, heldBy} */
export function acquireLock(dataDir, { now = Date.now() } = {}) {
  const lockFile = file(dataDir, '.dream.lock');
  try {
    const raw = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const age = now - (Number(raw.at) || 0);
    if (age < LOCK_STALE_MS) {
      // 锁还新鲜：说明真有一个 Dream 在跑
      return { acquired: false, heldBy: raw.pid ?? '?', ageMs: age };
    }
    // 锁过期：上一个 Dream 崩了，抢占
  } catch {
    // 没有锁文件，正常
  }
  const tmp = `${lockFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: now }), { mode: 0o600 });
  fs.renameSync(tmp, lockFile);
  return { acquired: true };
}

export function releaseLock(dataDir) {
  try { fs.rmSync(file(dataDir, '.dream.lock'), { force: true }); } catch { /* 清不掉不影响下次 */ }
}

/** 读 trace，只取有明确 ok 的（模糊的轮次不进学习）。 */
function readTraces(dataDir) {
  const target = file(dataDir, '.trace.jsonl');
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.ok === true || obj.ok === false) rows.push(obj);
    } catch { /* 坏行跳过：trace 是追加写的，尾部可能截断 */ }
  }
  return rows;
}

/**
 * 判断现在该不该跑 Dream。
 *
 * @returns {{shouldRun: boolean, reason: string, newCount: number}}
 */
export function shouldRun(dataDir, { now = Date.now(), minNew = MIN_NEW, minIntervalMs = 60 * 60_000 } = {}) {
  const state = readState(dataDir);

  // 先看间隔，再看新增量。
  // 顺序反了会失效：整理完 lastTraceAt 被设成最新一条 trace 的时间，
  // 此时「新 trace」永远是 0，于是永远停在"数量不够"那一条，
  // 间隔限制看起来存在、实际从未生效过。
  if (state.lastRunAt && now - state.lastRunAt < minIntervalMs) {
    const mins = Math.max(1, Math.round((minIntervalMs - (now - state.lastRunAt)) / 60000));
    return { shouldRun: false, reason: `距上次整理不到 ${Math.round(minIntervalMs / 60000)} 分钟（还差 ${mins} 分）`, newCount: 0 };
  }

  const traces = readTraces(dataDir);
  const fresh = traces.filter((t) => (Number(t.at) || 0) > state.lastTraceAt);
  if (fresh.length < minNew) {
    return { shouldRun: false, reason: `新 trace 只有 ${fresh.length} 条（需 ≥${minNew}）`, newCount: fresh.length };
  }
  return { shouldRun: true, reason: `有 ${fresh.length} 条新 trace 待整理`, newCount: fresh.length };
}

/**
 * 执行一次整理。
 *
 * 默认用 consolidate.distill（聚类 + 成功率门槛），产出**写入记忆库**，
 * 而不是只返回一个数组——早先那版整理完就丢了，等于白跑。
 *
 * @param {object} opts
 *   distill  注入的提炼函数（默认 consolidate.distill）
 *   store    {write} 记忆库写入器；不传则只返回不落盘（用于测试/预览）
 */
export function runDream(dataDir, {
  now = Date.now(),
  budget = DEFAULT_BUDGET,
  distill = null,
  minNew = MIN_NEW,
  store = null,
} = {}) {
  const gate = shouldRun(dataDir, { now, minNew });
  if (!gate.shouldRun) {
    return { ran: false, reason: gate.reason };
  }

  const lock = acquireLock(dataDir, { now });
  if (!lock.acquired) {
    return { ran: false, reason: `另一个 Dream 正在跑（pid ${lock.heldBy}，${Math.round((lock.ageMs ?? 0) / 1000)}秒前开始）` };
  }

  const startedAt = now;
  const audit = (entry) => {
    const line = JSON.stringify({ at: now, ...entry }) + '\n';
    try { fs.appendFileSync(file(dataDir, '.dream-audit.jsonl'), line, { mode: 0o600 }); } catch { /* 审计失败不影响整理 */ }
  };

  try {
    const traces = readTraces(dataDir);
    // 预算：只取最近 budget 条，避免一次处理几年的数据
    const slice = traces.slice(-budget);
    // 默认提炼器：聚类 + 成功率门槛。产出是带 successRate 的技能记忆。
    const refine = typeof distill === 'function' ? distill : defaultDistill;
    const produced = refine(slice) ?? [];

    // 写入记忆库。早先那版只 return，整理完就丢了——
    // 整理过的东西必须能被下一轮检索到，否则这套流程没有意义。
    let stored = 0;
    if (store && typeof store.write === 'function') {
      for (const skill of produced) {
        try {
          const r = store.write({
            kind: 'procedural',
            text: skill.text,
            tags: skill.tags,
            meta: {
              successRate: skill.successRate,
              sampleCount: skill.samples,
              source: 'dream',
              // verified 恒为 false：进记忆库不等于被信任，检索时会带这个标记
              verified: false,
            },
            source: 'trace',
          });
          if (r && r.id && !r.deduped) stored += 1;
        } catch { /* 单条写失败不中断整轮整理 */ }
      }
    }

    const newestTraceAt = slice.reduce((max, t) => Math.max(max, Number(t.at) || 0), 0);
    writeState(dataDir, {
      lastRunAt: startedAt,
      lastTraceAt: newestTraceAt,
      runs: readState(dataDir).runs + 1,
    });

    audit({ event: 'dream', processed: slice.length, produced: produced.length, stored, budget });
    return { ran: true, processed: slice.length, produced, stored };
  } catch (error) {
    audit({ event: 'dream-error', error: String(error?.message ?? error).slice(0, 200) });
    return { ran: false, reason: `整理失败：${error?.message ?? error}` };
  } finally {
    releaseLock(dataDir);
  }
}

/** 最近几次整理的审计记录。 */
export function recentAudit(dataDir, limit = 10) {
  try {
    const lines = fs.readFileSync(file(dataDir, '.dream-audit.jsonl'), 'utf8').trim().split('\n');
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}
