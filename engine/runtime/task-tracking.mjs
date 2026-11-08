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
export function onTurnEnd(dataDir, { sessionId, turn, reasonKind, error }, now = Date.now()) {
  if (!sessionId || !Number.isInteger(turn)) return null;
  let state;
  try { state = registry.load(dataDir); } catch { return null; }

  const taskId = state.idempotency?.[keyOf(sessionId, turn)];
  if (!taskId) return null;
  const task = state.tasks[taskId];
  if (!task) return null;

  const to = outcomeOf(reasonKind);
  if (!to) return null;                       // 不认识的 reason：不动
  if (task.status !== 'running') return null; // 已经收尾过（重复事件）

  try {
    registry.transition(state, taskId, to, { by: 'auto-guard', error: error ?? null, now });
  } catch {
    return null;
  }
  try { registry.save(state, dataDir); } catch { /* 同上 */ }
  return { taskId, status: to };
}

/** 只读统计，给 capability-status 用（避免它自己解析任务文件格式）。 */
export function summarize(dataDir) {
  let state;
  try { state = registry.load(dataDir); } catch { return { ok: false, reason: '读不到任务表', total: 0, byStatus: {} }; }
  const tasks = state?.tasks;
  if (!tasks || typeof tasks !== 'object') {
    return { ok: false, reason: '还没有任务记录', total: 0, byStatus: {} };
  }
  const byStatus = {};
  for (const t of Object.values(tasks)) {
    const s = t?.status ?? 'unknown';
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  return { ok: true, total: Object.keys(tasks).length, byStatus };
}
