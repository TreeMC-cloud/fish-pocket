/**
 * 提醒准入：两级过滤，决定哪些事件该打扰用户。
 *
 * 这一层治的是「提醒太密，用户干脆全关掉」——那是比不提醒更糟的结果，
 * 因为连真正重要的红线和失败也没人看了。所以不是简单限流，而是分级：
 *
 *   ALWAYS：必须让用户知道，且**不受冷却**。
 *     任务被中断、外部内容投毒、任务失败、需要批准——这些是「已经出事了」，
 *     每一条都对应一个用户需要做的决定。给它们加冷却等于「同一个坑踩第二次就不报了」。
 *
 *   THROTTLED：同类重复出现价值递减，按会话+类型冷却。
 *     轮次超限、工具连续失败、上下文压缩——第一次有意义，第二第三次是噪音。
 *
 *   （其余一律不放行：只留在 engine.log，不打扰用户）
 *
 * 之前的问题就在这：把 interrupted / injection 一起放进冷却名单，结果
 * 中断横幅和注入告警要么被拦、要么十分钟内只报一次，功能等于没有。
 */

/** 出事类：必须送达，不受冷却。 */
const ALWAYS = new Set([
  'interrupted',
  'injection',
  'task_failed',
  'task_interrupted',
  'approval_needed',
]);

/** 高频类：按会话 + 类型冷却。 */
const THROTTLED = new Set([
  'turns',
  'repeat',
  'compaction',
  'dispatch',
]);

export function createNoticeAdmission({ cooldownMs = 10 * 60_000, now = Date.now } = {}) {
  const lastSent = new Map();

  return function admit(message) {
    if (!message || message.type !== 'dsh-ios/notice') return false;
    const kind = message.detail?.kind;
    if (typeof message.message !== 'string' || !message.message.trim()) return false;

    // 出事类：直接放行。没有冷却——同一个任务连续失败两次也要报两次。
    if (ALWAYS.has(kind)) return true;

    if (!THROTTLED.has(kind)) return false;

    const session = String(message.detail?.session ?? 'global');
    const key = `${session}:${kind}`;
    const time = now();
    const previous = lastSent.get(key);
    if (previous !== undefined && time - previous < cooldownMs) return false;
    lastSent.set(key, time);

    // 限制内存：会话多时不能无限增长。
    if (lastSent.size > 256) {
      const cutoff = time - cooldownMs;
      for (const [entry, at] of lastSent) if (at < cutoff) lastSent.delete(entry);
      while (lastSent.size > 256) lastSent.delete(lastSent.keys().next().value);
    }
    return true;
  };
}
