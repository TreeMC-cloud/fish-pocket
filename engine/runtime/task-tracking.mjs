// task-tracking.mjs —— 把「一轮对话」当成一个任务来记账
//
// 为什么需要：Task Registry 写好了整套状态机（received → queued → running →
// succeeded/failed/interrupted，带 lease 和幂等键），但**从来没有调用者**。
// 结果是 `.tasks.json` 永远是空的，能力地图只能显示「还没开始干活」。
//
// 这里的职责只有一条：把真实发生的事件翻译成任务状态转移。
//
// 设计的三个约束：
//
// 1. **一轮 = 一个任务**。用户的每次发言就是一个任务单元，
//    幂等键是 `sessionId:turn`，重复事件不会建出两个任务。
//
// 2. **状态转移必须合法**。task-registry 的 TRANSITIONS 表不允许
//    running → queued 这类跳跃，非法转移会抛错。这里所有转移都先查当前状态，
//    不合法就跳过（记一笔 debug），绝不去 catch 后硬改——状态机被绕过一次，
//    之后所有统计都不可信。
//
// 3. **写失败不影响对话**。记账是副产物，磁盘满或权限错都不该让用户发不出话。
//
// 为什么用 turn 而不是 callId 做任务粒度：callId 是「一次工具调用」，
// 一轮里可能有几十次，全部记成任务会把任务表变成日志；而用户心智里的
// 「一件事」就是一问一答。工具级的明细走 trace，不走任务表。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as registry from './task-registry.mjs';

/** turn/end 的 reason 落成任务终态。 */
const OUTCOME = {
  completed: 'succeeded',
  'max-tokens': 'succeeded',   // 输出到上限，但这轮的工作是完成的
  aborted: 'interrupted',
  interrupted: 'interrupted',
  error: 'failed',
};

/**
 * 一轮结束时该转到哪个状态。未知 reason 返回 null：不认识就不动，
 * 让任务停在 running（并由 lease 过期去发现它），比乱记一个终态好。
 */
export function outcomeOf(reasonKind) {
  return OUTCOME[reasonKind] ?? null;
}

/** 幂等键：同一会话的同一轮只建一个任务。
 *
 *  必须和 registry.create 内部拼出来的完全一致（`${source}:${eventId}`），
 *  否则 onTurnEnd 查不到 turn/start 建的那个任务——任务会永远停在 running。
 *  这是踩过的坑：这里写 `turn:s1:1`，registry 存的是 `session:s1:turn:s1:1`。
 */
const SOURCE = (sessionId) => `session:${sessionId}`;
const EVENT = (sessionId, turn) => `turn:${sessionId}:${turn}`;
const keyOf = (sessionId, turn) => `${SOURCE(sessionId)}:${EVENT(sessionId, turn)}`;

/**
 * 一轮开始：建任务（或复用），并推进到 running。
 *
 * @returns {{taskId: string|null, created: boolean}}
 */
export function onTurnStart(dataDir, { sessionId, turn, title }, now = Date.now()) {
  if (!sessionId || !Number.isInteger(turn)) return { taskId: null, created: false };
  let state;
  try { state = registry.load(dataDir); } catch { return { taskId: null, created: false }; }

  let taskId = state.idempotency?.[keyOf(sessionId, turn)] ?? null;
  let created = false;

  if (!taskId) {
    try {
      const input = {
        source: SOURCE(sessionId),
        eventId: EVENT(sessionId, turn),
        title: (title || `第 ${turn} 轮`).slice(0, 200),
        threadKey: sessionId,
      };
      const r = registry.create(state, input, now);
      state = r.state;
      taskId = r.task.taskId;
      created = r.created;
    } catch {
      return { taskId: null, created: false };
    }
  }

  // received → queued → running 两步走。
  // 状态机不允许 received 直接跳 running（TRANSITIONS 表里
  // received 只能去 ignored/awaiting_approval/queued/cancelled）——
  // 「收到」和「排队」和「在跑」是三件事，跳过 queued 就等于
  // 把「还没轮到它」这个信息丢了。这里按表来，不硬改。
  const task = state.tasks[taskId];
  if (task) {
    for (const to of ['queued', 'running']) {
      if (task.status === to) break;
      try { registry.transition(state, taskId, to, { by: 'auto-guard', now }); }
      catch { break; /* 状态机拒绝就停在当前状态 */ }
    }
  }

  try { registry.save(state, dataDir); } catch { /* 记账失败不影响对话 */ }
  return { taskId, created };
}

/**
 * 一轮结束：按 turn/end 的真实原因收尾。
 *
 * 失败/中断**不直接回到 queued**——有副作用的操作必须先人工核对，
 * 这是状态机本来的意图（needs_reconciliation）。
 */
export function onTurnEnd(dataDir, { sessionId, turn, reasonKind, error, acceptance = null }, now = Date.now()) {
  if (!sessionId || !Number.isInteger(turn)) return null;
  let state;
  try { state = registry.load(dataDir); } catch { return null; }

  // 轮次键只对「每轮一个」的任务有效。外部投递的任务幂等键是
  // `external:<eventId>`，用 turn 键查不到——所以找不到时**不能直接返回**，
  // 否则收尾、投递结果、自检结果全都写不进去（外部任务永远停在「已投递」）。
  const taskId = state.idempotency?.[keyOf(sessionId, turn)] ?? null;
  const task = taskId ? state.tasks[taskId] : null;

  const to = outcomeOf(reasonKind);
  let transitioned = null;
  if (task && to && task.status === 'running') {
    try {
      registry.transition(state, taskId, to, { by: 'auto-guard', error: error ?? null, now });
      transitioned = to;
      try { registry.save(state, dataDir); } catch { /* 同上 */ }
    } catch { /* 转移失败：下面照样做投递/自检回写 */ }
  }

  // 顺手把「投递型」任务的真实结果补上。
  // Router 的任务在 agent.inject() 后就标 succeeded 了——那只代表消息投进去了。
  // 这一轮真实跑完的成败，只有 turn/end 知道。不回写的话，任务表永远停在
  // 「已投递」，会话失败它也显示正常，账本就不可信了。
  const reconciled = reconcileDelivered(state, { sessionId, reasonKind, now });

  // 自检结果：模型在最后一行写的 `ACCEPT: PASS / FAIL <原因>`。
  // 没有这个标记就说明它没按格式收工——记为 null（未评），不硬判失败：
  // 老任务、闲聊轮次本来就没有完成标准。
  if (acceptance && typeof acceptance === 'object') {
    const ok = setAcceptance(state, {
      sessionId, result: acceptance.result, reason: acceptance.reason, now,
    });
    if (ok > 0) reconciled && (state._acceptanceWritten = true);
  }

  if (reconciled > 0 || acceptance != null) {
    try { registry.save(state, dataDir); } catch { /* 尽力而为 */ }
  }
  // 什么都没做就返回 null：调用方（auto-guard）靠这个判断「这一轮无需记账」，
  // 也方便测试断言「重复事件 / 未知 reason 不该产生动作」。
  if (transitioned == null && reconciled === 0 && acceptance == null) return null;
  return { taskId, status: transitioned, reconciled };
}

/**
 * 把同一会话里、最近投递过、还没拿到结果的任务补上 `turnOutcome`。
 *
 * 为什么用「最近 N 分钟内 + 同一会话」而不是精确配对：注入时机在 turn 开始之前，
 * 那时还没有 turn 号。能做到的可靠关联只有会话 + 时间窗。多个命中时取最新的那个
 * （同会话同一时间只会有一轮在跑）。
 *
 * 刻意**不改 status**：succeeded 是终态，状态机的 TRANSITIONS 不允许回退，
 * 而且"投递成功"本身也是事实。所以只加一个 `turnOutcome` 字段表示后续结果。
 */
/**
 * 把「自检结果」写进最近一条投递型任务。
 *
 * 只认投递型：普通轮次任务（每轮一个）没有完成标准，不该被标记。
 * 也只在还没写过时写——同一轮重复的 turn/end 不该覆盖第一次判定。
 */
export function setAcceptance(state, { sessionId, result, reason = null, now = Date.now(), windowMs = 30 * 60_000 } = {}) {
  if (!sessionId || (result !== 'pass' && result !== 'fail')) return 0;
  let count = 0;
  for (const task of Object.values(state.tasks ?? {})) {
    if (task?.deliveredOnly !== true) continue;
    if (task.threadKey !== sessionId) continue;
    if (task.acceptanceResult != null) continue;      // 已评过
    if (now - (task.updatedAt ?? 0) > windowMs) continue;
    task.acceptanceResult = result;
    task.acceptanceReason = reason ? String(reason).slice(0, 300) : null;
    task.acceptanceAt = now;
    count += 1;
  }
  return count;
}

/**
 * 引擎自己跑一遍验证命令，不信模型的自我报告。
 *
 * 为什么必须独立跑：模型说「ACCEPT: PASS」只代表它认为自己做到了。
 * 这个项目见过太多次「写完文件就宣布完成」，而文件是空的、
 * 命令退出码不是 0、测试被跳过。验收判据能变成命令的，就由引擎说话。
 *
 * 冲突处理：命令失败 → 强制判 fail（覆盖模型的 PASS），因为退出码是事实。
 * 跑不起来（沙箱拒绝/命令不存在）→ 记为 null，不冤枉任务。
 *
 * @returns {{ran:boolean, ok?:boolean|null, results?:Array, error?:string}}
 */
export function recordVerification(dataDir, { sessionId, cwd = null, now = Date.now(), windowMs = 30 * 60_000 } = {}) {
  if (!sessionId) return { ran: false, error: '没有 sessionId' };
  let state;
  try { state = registry.load(dataDir); } catch { return { ran: false, error: '任务表读不到' }; }

  // 找「最近一条、还没验过、带验证命令」的投递型任务。
  const candidates = Object.values(state.tasks ?? {})
    .filter((t) => t?.deliveredOnly === true)
    .filter((t) => t.threadKey === sessionId)
    .filter((t) => Array.isArray(t?.verify) && t.verify.length > 0)
    .filter((t) => t?.verifyResults == null)
    .filter((t) => now - (t.updatedAt ?? 0) <= windowMs)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const task = candidates[0];
  if (!task) return { ran: false, error: '没有待验证的任务' };

  // 懒加载：child-process 那套模拟很重，别在插件初始化时就付这份成本。
  let verdict;
  try {
    const require_ = createRequire(import.meta.url);
    const mod = require_('./verify.mjs');
    verdict = mod.verifyCommands(task.verify, { cwd: mod.resolveCwd(cwd) });
  } catch (error) {
    verdict = { ok: null, results: [], error: String(error?.message ?? error) };
  }

  task.verifyResults = verdict.results ?? [];
  task.verifiedAt = now;
  if (verdict.ok === false) {
    // 引擎判定优先：退出码是事实，模型的 PASS 是可陈述。
    task.acceptanceResult = 'fail';
    task.acceptanceReason = `验证命令失败：${(verdict.results.find((r) => r.ok === false)?.cmd ?? '').slice(0, 160)}`;
    task.acceptanceAt = now;
  }
  task.updatedAt = now;
  try { registry.save(state, dataDir); } catch { /* 尽力而为 */ }
  return { ran: true, ok: verdict.ok, results: verdict.results, taskId: task.taskId };
}

export function reconcileDelivered(state, { sessionId, reasonKind, now = Date.now(), windowMs = 30 * 60_000 } = {}) {
  if (!sessionId) return 0;
  let count = 0;
  for (const task of Object.values(state.tasks ?? {})) {
    if (task?.deliveredOnly !== true) continue;
    if (task.threadKey !== sessionId) continue;
    if (task.turnOutcome !== undefined && task.turnOutcome !== null) continue;  // 已经配过
    if (now - (task.updatedAt ?? 0) > windowMs) continue;                       // 太久，可能不是这一轮
    task.turnOutcome = reasonKind ?? 'unknown';
    task.turnAt = now;
    count += 1;
  }
  return count;
}

/** 只读统计，给 capability-status 用（避免它自己解析任务文件格式）。 */
export function summarize(dataDir) {
  let state;
  try { state = registry.load(dataDir); } catch { return { ok: false, reason: '读不到任务表', total: 0, byStatus: {} }; }
  const tasks = state?.tasks;
  // 空对象要算「还没有记录」，不能算「有记录但为 0」。
  // `load()` 对不存在的文件返回 emptyState()（tasks: {}），它满足 `typeof === 'object'`，
  // 只查类型会让全新安装显示成"0 个任务"——而面板的空状态文案是"还没开始干活"，
  // 两者说的不是一回事。判据必须是「有没有任务」，不是「有没有这个字段」。
  const count = tasks && typeof tasks === 'object' ? Object.keys(tasks).length : 0;
  if (count === 0) {
    return { ok: false, reason: '还没有任务记录', total: 0, byStatus: {} };
  }
  const byStatus = {};
  for (const t of Object.values(tasks)) {
    const s = t?.status ?? 'unknown';
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  return { ok: true, total: count, byStatus };
}
