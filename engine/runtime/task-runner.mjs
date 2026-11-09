// task-runner.mjs —— 让 Router 真的能执行无主任务
//
// 背景：Router（准入 / 并发 / 租约 / 失败改道）和 Task Registry（状态机）
// 都写好了，但一直没有调用者——因为它们需要有人告诉它"该跑什么"。
//
// 这里补上那一环：把排队的任务真正送进 DSH 会话执行。
//
// ## iOS 上的现实边界（必须先说清楚）
//
// DSH 的 schedule 用 setTimeout 驱动，App 被系统杀掉后定时器一起消失。
// 所以这个模块**不能**保证"到点一定执行"。它保证的是：
//
//   App 活着时：队列里的任务会被真正推起来、失败会按规则改道、超时会被发现
//   App 被杀后：什么都不发生（重启后由 sweep 把僵尸任务标成 interrupted）
//
// 把它当"常驻调度器"用会失望；当"App 存活期间的可靠执行队列"用是对的。
//
// ## 为什么用 agent.inject 而不是 session/prompt
//
// `session/prompt` 是给客户端的 RPC，走的是「用户发消息」那条路。而 Router 执行的是
// **无人在场**的任务，DSH 对这类消息有专门的语义：`source: { kind: 'schedule' }`，
// 会走 withoutInitiator，不会伪装成用户说的话。抄 DSH 自己的做法，不另造一套。
//
// 依赖 `ctx.agents`（与 dsh-schedule 相同），拿不到就不干活、只记日志。

/**
 * 造一个 Router 的 runTask 回调。
 *
 * @param {object} deps
 * @param {object} deps.ctx        插件上下文（需要 ctx.agents）
 * @param {function} deps.createUserMessage  消息构造器（来自 dsh-llm）
 * @param {function} [deps.logger]
 * @returns {function} runTask(task) → Promise<{ok:boolean, error?:string}>
 */
export function makeRunTask({ ctx, createUserMessage, logger = null }) {
  return async function runTask(task) {
    // 任务里记的是目标会话（threadKey 存 sessionId）。
    // 没有目标会话的任务不在这里执行——它属于"派给谁还没定"，不该被默默跑掉。
    const sessionId = task?.threadKey;
    if (!sessionId) {
      return { ok: false, error: '任务没有目标会话（threadKey 为空），不执行' };
    }

    const agents = ctx?.agents;
    if (!agents || typeof agents.get !== 'function') {
      return { ok: false, error: 'ctx.agents 不可用，无法投递任务' };
    }

    const agent = agents.get(sessionId);
    if (agent === undefined) {
      // 会话没加载进内存：这是最常见的情况（App 刚启动 / 会话被回收）。
      // 不是错误，是这个任务现在做不了——保持 queued 等下一轮。
      return { ok: false, error: `会话 ${sessionId} 未加载，稍后重试`, retryable: true };
    }

    const text = buildPrompt(task);
    try {
      agent.inject(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'schedule' },
      }));
      // ⚠ 这里的 ok 只代表「消息投进去了」，**不代表这一轮做完了**。
      // inject 是异步投递：返回时 turn 还没开始跑，后面失败/中断都与这里无关。
      // 明确标 delivered，让任务表能如实显示「已投递」而不是「已完成」。
      // 投递成功却在表里写"成功"，是最容易骗过自己的那种状态。
      return { ok: true, delivered: true };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  };
}

/**
 * 任务 → 投递文本。
 *
 * 为什么带上标题和来源：模型看到的是「一条消息」，如果不说明这是自动化派来的，
 * 它会把任务当成用户随口说的话来回应（"好的，你需要我做什么？"）。
 * 明确写出来源，它才知道这是要执行的活。
 */
export function buildPrompt(task) {
  // 正文优先用 note：title 只有 200 字，装不下一条完整指令。
  const title = String(task?.note ?? task?.title ?? '').trim();
  const source = String(task?.source ?? '');
  const origin = source.startsWith('session:') ? '自动重排' : source;
  return [
    `[自动任务 · ${origin}]`,
    title || '（无标题任务）',
    '',
    '这是任务队列派下来的工作，直接执行，不需要确认。',
  ].join('\n');
}

/**
 * 一次调度循环：sweep（收僵尸）→ execute（推队列）。
 *
 * 顺序不能反：先 sweep 才能把超时任务腾出的并发名额让给队列里的下一个。
 * 反过来的话，一个卡死的 running 会永远占着槽位。
 *
 * @returns {{swept: string[], started: string[], reason?: string}}
 */
export async function tick(router) {
  let swept = [];
  try { swept = router.sweep(); } catch { swept = []; }
  let started = [];
  let reason;
  try {
    const r = await router.execute();
    started = r?.started ?? [];
    reason = r?.skipped;
  } catch (error) {
    reason = `调度异常：${error?.message ?? error}`;
  }
  return { swept, started, reason };
}
