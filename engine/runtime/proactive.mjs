// proactive.mjs —— 让它自己决定要做什么
//
// ## 为什么需要这一层
//
// 在此之前它只会「被动响应」：你说话，它干活；外部投一条任务，它干活。
// 没有第三种来源。所以「主动」这个词一直没有落点。
//
// ## iOS 上「主动」的边界（先说清楚，别抱错期待）
//
// 真正的常驻主动需要一台一直在跑的机器。App 被系统杀掉后 Node 一起没了，
// 这段时间什么都不可能发生——这是平台限制，不是没写。
//
// 所以这里做的是：**App 活着的时候，每几分钟看一遍状态，自己决定要不要动。**
// 用户一天用两三次 App，每次停留几分钟，那么这几分钟里它能自己发现
// 「这个坑又踩了」「有东西等你确认」并采取动作。
//
// ## 三条硬约束（防止它变成烧钱机器）
//
// 1. **只做判定，不做决定**：判定规则在代码里，不让模型自由发挥。
// 2. **有预算**：自动派活每小时最多 1 个、每天最多 3 个，超了只提醒不派。
// 3. **要有真实证据**：每条触发都必须能说出「依据是什么」，
//    说不出来的不触发——凭感觉主动比被动更糟。
//
// ## 判断哪些事该自动做、哪些只该提醒
//
// | 情形 | 动作 | 为什么 |
// |---|---|---|
// | 同一个坑反复失败 | **自动派活**去查 | 有明确证据、结果是只读分析，不会破坏现场 |
// | 有候选技能待确认 | 只提醒 | 要不要固化成技能得人判断 |
// | 任务卡住等人确认 | 只提醒 | 有副作用，自动重跑可能更糟 |
// | 中断残留 | 只提醒（已有） | 同理 |
//
// 一句话：**能自己做的自己做，需要人拍板的只提醒。**

import fs from 'node:fs';
import path from 'node:path';

const AUDIT = '.proactive.jsonl';
const STATE = '.proactive-state.json';

/** 自动派活的预算：每小时 1 个、每天 3 个。 */
const MIN_ENQUEUE_GAP_MS = 60 * 60_000;
const MAX_ENQUEUE_PER_DAY = 3;

/** 各条规则的冷却：同一件事不要反复提醒。 */
const COOLDOWN = {
  repeat_fail_topic: 6 * 60 * 60_000,     // 6 小时
  pending_candidates: 24 * 60 * 60_000,   // 1 天
  stalled_tasks: 6 * 60 * 60_000,         // 6 小时
};

function file(dataDir, name) { return path.join(dataDir, name); }

function readJson(file_, fallback) {
  try { return JSON.parse(fs.readFileSync(file_, 'utf8')); } catch { return fallback; }
}

function readJsonl(file_) {
  try {
    return fs.readFileSync(file_, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function writeJson(file_, value) {
  try {
    fs.mkdirSync(path.dirname(file_), { recursive: true });
    const tmp = `${file_}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file_);
    return true;
  } catch { return false; }
}

function appendAudit(dataDir, entry) {
  try {
    fs.appendFileSync(file(dataDir, AUDIT), JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch { /* 审计失败不影响判定 */ }
}

/**
 * 评估当前状态，给出「该做什么」。
 *
 * 纯函数式判定：只读文件、不产生副作用，方便测试和事后复盘。
 *
 * @returns {Array<{id:string, kind:string, action:'enqueue'|'notify', reason:string, payload?:object}>}
 */
export function evaluate(dataDir, { now = Date.now() } = {}) {
  const triggers = [];

  // ── 1. 同一个话题反复失败 → 自动派活去查 ──
  //
  // 判据刻意严格：最近 40 条 trace 里，同一标签失败 ≥3 次，
  // 而且**最近 10 条里还在失败**。只满足前者可能是历史遗留，
  // 已经自己好了；两种情况都派活就是浪费。
  {
    const traces = readJsonl(file(dataDir, '.trace.jsonl')).slice(-40);
    const recent = traces.slice(-10);
    const failsByTag = new Map();
    const recentFailTags = new Set();
    for (const t of traces) {
      for (const tag of t.tags ?? []) {
        if (t.ok === false) failsByTag.set(tag, (failsByTag.get(tag) ?? 0) + 1);
      }
    }
    for (const t of recent) {
      for (const tag of t.tags ?? []) if (t.ok === false) recentFailTags.add(tag);
    }
    for (const [tag, count] of failsByTag) {
      if (count < 3 || !recentFailTags.has(tag)) continue;
      triggers.push({
        id: `repeat_fail_topic:${tag}`,
        kind: 'repeat_fail_topic',
        action: 'enqueue',
        reason: `「${tag}」最近 ${count} 次失败，且还在继续`,
        payload: { tag, count },
      });
    }
  }

  // ── 2. 有候选技能挂了一天没人看 → 提醒 ──
  {
    const candidates = readJsonl(file(dataDir, '.skill-candidates.jsonl'))
      .filter((c) => c.verified !== true);
    const stale = candidates.filter((c) => now - (Number(c.at) || 0) > 24 * 60 * 60_000);
    if (stale.length > 0) {
      triggers.push({
        id: 'pending_candidates',
        kind: 'pending_candidates',
        action: 'notify',
        reason: `${stale.length} 条候选技能挂了一天以上，没人确认`,
        payload: { count: stale.length, tags: stale.slice(0, 3).map((c) => c.tag) },
      });
    }
  }

  // ── 3. 任务卡在等人确认 → 提醒 ──
  // 不自动重跑：失败任务多半有副作用，重来可能更糟。这一条只提醒。
  {
    const state = readJson(file(dataDir, 'tasks.json'), null);
    const tasks = state?.tasks ?? {};
    const stuck = Object.values(tasks).filter((t) =>
      t.status === 'needs_reconciliation' && now - (Number(t.updatedAt) || 0) > 2 * 60 * 60_000);
    if (stuck.length > 0) {
      triggers.push({
        id: 'stalled_tasks',
        kind: 'stalled_tasks',
        action: 'notify',
        reason: `${stuck.length} 个任务卡了两小时以上没处理`,
        payload: { count: stuck.length, titles: stuck.slice(0, 3).map((t) => t.title) },
      });
    }
  }

  return triggers;
}

/** 今天已经自动派了几个活。 */
function enqueuedToday(state, now) {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  return (state.enqueuedAt ?? []).filter((t) => t >= dayStart.getTime()).length;
}

/**
 * 跑一遍：按冷却与预算决定哪些真的执行。
 *
 * @param {object} deps
 *   enqueue({sessionId, text, eventId})  派活（由调用方接到 Router）
 *   notify({kind, message})              提醒（由调用方接到通知通道）
 *   sessionId                            派给哪个会话
 * @returns {{acted:Array, skipped:Array}}
 */
export function runProactive(dataDir, {
  now = Date.now(),
  enqueue = null,
  notify = null,
  sessionId = null,
} = {}) {
  const state = readJson(file(dataDir, STATE), {}) ?? {};
  state.sentAt = state.sentAt ?? {};
  state.enqueuedAt = Array.isArray(state.enqueuedAt) ? state.enqueuedAt : [];

  const triggers = evaluate(dataDir, { now });
  const acted = [];
  const skipped = [];

  const lastEnqueueAt = state.enqueuedAt.length > 0
    ? Math.max(...state.enqueuedAt)
    : 0;
  const budgetLeft = MAX_ENQUEUE_PER_DAY - enqueuedToday(state, now);

  for (const trigger of triggers) {
    const cool = COOLDOWN[trigger.kind] ?? 6 * 60 * 60_000;
    const last = Number(state.sentAt[trigger.id] ?? 0);
    if (last && now - last < cool) { skipped.push({ ...trigger, why: '冷却中' }); continue; }

    if (trigger.action === 'enqueue') {
      if (!enqueue || !sessionId) { skipped.push({ ...trigger, why: '没有可投递的会话' }); continue; }
      if (budgetLeft <= 0) { skipped.push({ ...trigger, why: '今日自动派活额度已用完' }); continue; }
      if (lastEnqueueAt && now - lastEnqueueAt < MIN_ENQUEUE_GAP_MS) {
        skipped.push({ ...trigger, why: '距上次自动派活不到 1 小时' });
        continue;
      }
      try {
        enqueue({
          sessionId,
          eventId: `${trigger.id}:${Math.floor(now / 3_600_000)}`,
          text: buildTaskText(trigger),
        });
        state.enqueuedAt.push(now);
        state.sentAt[trigger.id] = now;
        acted.push(trigger);
        appendAudit(dataDir, { at: now, id: trigger.id, action: 'enqueue', reason: trigger.reason });
      } catch (error) {
        skipped.push({ ...trigger, why: `派活失败：${String(error?.message ?? error).slice(0, 80)}` });
      }
      continue;
    }

    if (!notify) { skipped.push({ ...trigger, why: '没有通知通道' }); continue; }
    try {
      notify({ kind: noticeKind(trigger.kind), message: trigger.reason });
      state.sentAt[trigger.id] = now;
      acted.push(trigger);
      appendAudit(dataDir, { at: now, id: trigger.id, action: 'notify', reason: trigger.reason });
    } catch (error) {
      skipped.push({ ...trigger, why: `提醒失败：${String(error?.message ?? error).slice(0, 80)}` });
    }
  }

  // 只留最近 7 天的记录，避免状态文件无限长。
  const cutoff = now - 7 * 24 * 60 * 60_000;
  state.enqueuedAt = state.enqueuedAt.filter((t) => t >= cutoff);
  writeJson(file(dataDir, STATE), state);

  return { acted, skipped, triggers };
}

/** 自动派出去的任务说什么。 */
function buildTaskText(trigger) {
  if (trigger.kind === 'repeat_fail_topic') {
    return [
      `你最近在「${trigger.payload.tag}」这件事上反复失败（最近 ${trigger.payload.count} 次）。`,
      '',
      '请做一次只读排查：',
      '1. 从最近的日志/记录里找出失败的具体原因，不要凭印象；',
      '2. 如果已经有现成的解法步骤，说清楚是哪一步漏了；',
      '3. 结论写成一条可复用的经验（一句话），不要改任何文件。',
      '',
      '这是你主动发起的排查，不需要等我确认。',
    ].join('\n');
  }
  return trigger.reason;
}

/** 内部触发器 → App 认识的通知类型。都放进冷却类，不打扰。 */
function noticeKind(kind) {
  switch (kind) {
    case 'pending_candidates': return 'repeat';
    case 'stalled_tasks': return 'task_failed';
    default: return 'repeat';
  }
}

/** 最近的自动动作，给界面看。 */
export function recentActions(dataDir, limit = 20) {
  return readJsonl(file(dataDir, AUDIT)).slice(-limit);
}
