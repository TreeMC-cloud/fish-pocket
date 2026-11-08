// task-control.mjs —— 人工确认任务的入口
//
// ## 为什么需要它
//
// Task Registry 的状态机刻意不让失败任务自动重跑（有副作用的操作重来可能更糟），
// 失败的任务会停在 `needs_reconciliation` 等人确认。这是对的设计。
//
// 但「等人工」必须配一个「人工在哪点」。没有这个入口，那些任务就永远卡在那里，
// 而用户根本不知道它们存在——状态机再正确也没用。
//
// ## 为什么用文件而不是 RPC
//
// Swift 侧只能调用 DSH 宿主注册过的 RPC（`session/*`、`commands/*` 等），
// 那些不是我们能注册的。给引擎加一个新 RPC 要改宿主包，版本耦合太重。
//
// 而这个项目已经有一个成熟的模式：`debug-inbox.mjs` 用「App 落文件、引擎扫目录」
// 的方式在真机上跑调试脚本。这里照同样的做法，只是语义更窄、更可控：
//
//   <data>/task-control/<id>.json   请求（App 写）
//   <data>/task-control/<id>.out    结果（引擎写）
//
// 扫描到 `.json` 且没有同名 `.out` 就处理一次，处理完写 `.out`。
// 幂等靠文件名：同一个 id 只会被处理一次，重复写同名文件不会重复执行。

import fs from 'node:fs';
import path from 'node:path';

/** 允许的动作。白名单，未知动作直接拒绝（不让文件变成任意代码执行）。 */
const ACTIONS = new Set(['requeue', 'cancel', 'list']);

export function controlDir(dataDir) {
  return path.join(dataDir, 'task-control');
}

/**
 * 处理一个请求文件。
 * @returns {object} 写进 `.out` 的结果
 */
export function handle(router, request) {
  const action = String(request?.action ?? '');
  if (!ACTIONS.has(action)) {
    return { ok: false, error: `未知动作：${action || '(空)'}` };
  }

  if (action === 'list') {
    const state = router.state();
    const rows = Object.values(state.tasks ?? {}).map((t) => ({
      taskId: t.taskId,
      title: t.title,
      status: t.status,
      lastError: t.lastError ?? null,
      updatedAt: t.updatedAt ?? 0,
    }));
    return { ok: true, total: rows.length, tasks: rows.slice(0, 200) };
  }

  const taskId = String(request?.taskId ?? '');
  if (!taskId) return { ok: false, error: '缺少 taskId' };

  try {
    if (action === 'requeue') {
      const t = router.requeue(taskId, { by: 'user' });
      return { ok: true, taskId, status: t.status };
    }
    // cancel
    const t = router.cancel(taskId, { by: 'user', force: true });
    return { ok: true, taskId, status: t?.status ?? null };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * 扫一遍控制目录，处理未完成的请求。
 *
 * 处理失败也要写 `.out`——否则一个坏请求会让调度循环每 15 秒重试它，
 * 而且永远不消失。写清失败原因，让人能看出哪里不对。
 */
export function drain(router, dataDir) {
  const dir = controlDir(dataDir);
  let handled = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return { handled: 0 }; }

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    const out = `${file.slice(0, -5)}.out`;
    if (fs.existsSync(out)) continue;   // 已处理过

    let result;
    try {
      const text = fs.readFileSync(file, 'utf8');
      result = handle(router, JSON.parse(text));
    } catch (error) {
      result = { ok: false, error: `请求格式错误：${error?.message ?? error}` };
    }
    try {
      fs.writeFileSync(out, JSON.stringify({ at: Date.now(), ...result }), { mode: 0o600 });
      handled += 1;
    } catch { /* 写不出结果也不阻塞其它请求 */ }
  }
  return { handled };
}
