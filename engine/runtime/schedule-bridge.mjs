// schedule-bridge.mjs —— 读取 DSH 定时任务的状态（只读，不接管投递）
//
// ## 为什么是只读
//
// 曾经写过一个「把到期任务收进 Router 队列」的版本，是**错的**：
// DSH 的 schedule 自带完整的自动投递循环（runtime.requestDrive + setTimeout +
// timer.unref），App 活着时它自己到点投递、自己推进 scheduledAt。
// Router 再收一遍，同一个任务会被执行两次；而且 Router 绕过 DSH 投递之后
// scheduledAt 不推进，同一个任务每 15 秒都会"重新到期"。
//
// 判断某个来源该不该由 Router 接管，先看它**有没有自己的执行者**：
// 有 → 只观察；没有（失败重排、子任务回收）→ 才接管。
//
// ## 所以这个文件只剩两件事
//
// 1. 如实判断「这条 schedule 记录现在该不该跑」（与 DSH 同一判据），
//    给能力地图显示用，不参与决策。
// 2. 把 schedule 的负载翻译成任务表能显示的形状（标题、目标会话）。
//
// 不导出任何会改变 schedule 状态的函数。

/** 一条 schedule 记录是否到期。与 dsh-schedule 的 runtime.drive 同一判据。 */
export function isDue(entry, now = Date.now()) {
  if (!entry || entry.status !== 'active') return false;
  const scheduledAt = entry.scheduledAt;
  if (typeof scheduledAt !== 'string') return false;
  const at = Date.parse(scheduledAt);
  return Number.isFinite(at) && at <= now;
}

/**
 * 记录 → Router 的事件。
 *
 * 幂等键用 `schedule:<id>:<scheduledAt>`：同一个任务在同一个到期时刻
 * 只会入队一次。**注意不能用只有 id**——那样这个任务第二次到期时
 * 会因为幂等被挡掉，从此再也不执行。
 */
export function toEvent(entry) {
  const id = String(entry?.id ?? '');
  const at = String(entry?.scheduledAt ?? '');
  if (!id || !at) return null;

  // 目标会话：`target.sessionId`（recurring 投给已有会话）。
  // 没有目标的是一次性新建会话任务——那种 Router 不接（它需要先建会话，
  // 属于 DSH 自己的能力），这里跳过并如实说明。
  const sessionId = entry?.target?.sessionId ?? entry?.involvedSessionIds?.[0] ?? null;

  return {
    source: 'schedule',
    eventId: `${id}:${at}`,
    title: String(entry?.title ?? entry?.prompt ?? '').slice(0, 200) || `定时任务 ${id}`,
    threadKey: sessionId,
    detail: {
      scheduleId: id,
      scheduledAt: at,
      kind: entry?.kind ?? null,
    },
  };
}

/**
 * 一条 schedule 记录的展示形状（给能力地图用，不改变任何状态）。
 */
export function summarize(entry) {
  if (!entry) return null;
  return {
    id: entry.id ?? null,
    title: String(entry.title ?? entry.prompt ?? '').slice(0, 120),
    status: entry.status ?? null,
    scheduledAt: entry.scheduledAt ?? null,
    targetSessionId: entry.target?.sessionId ?? entry.involvedSessionIds?.[0] ?? null,
  };
}
