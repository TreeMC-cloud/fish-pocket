#!/usr/bin/env node
/**
 * task-registry.mjs —— 任务状态机（Router/Worker 的地基）
 *
 * 为什么需要它：没有持久任务记录，Router 就没有可路由的对象，Worker 就没有
 * 可执行单元，重启后也无从知道「刚才在干什么」。一切调度能力都长在这张表上。
 *
 * 设计取舍：
 *
 * 1) **状态转移用白名单校验**，不是「随便改」。
 *    非法转移直接抛错而不是静默修正——静默修正会把 bug 藏起来，等到数据
 *    错乱才发现，那时已经不知道是哪一步写坏的。
 *
 * 2) **幂等键唯一**：同一个 source + eventId 只建一个任务。
 *    Webhook 重投、轮询重叠、客户端重试都会导致同一事件来多次；没有这层，
 *    一次线上事故会被执行两遍。
 *
 * 3) **原子写**：tmp + rename。崩溃时磁盘上要么是旧版本、要么是新版本，
 *    不会读到写了一半的 JSON。
 *
 * 4) **outbox 与任务同一次写入**。
 *    这是关键：如果先写任务再写通知，进程在两步之间崩溃，任务存在但没人知道；
 *    反过来则通知指向不存在的任务。放同一个事务里，两者要么都成功要么都失败。
 *
 * 5) **不自动重跑**：`failed`/`interrupted` 不会自己回到 `queued`。
 *    有副作用的操作重跑比不跑更危险，必须经过 `needs_reconciliation` → 人工确认。
 *
 * 存法：单个 JSON 文件（任务量级在这个应用里是几十到几百，不需要数据库）。
 * 文件带 schemaVersion，为将来迁移留路。
 *
 * 用法（CLI 供人排查，代码里用导出的函数）：
 *   node task-registry.mjs list [--status running]
 *   node task-registry.mjs show <taskId>
 *   node task-registry.mjs add --source user --event-id <id> --scene <sceneId> --title "..."
 *   node task-registry.mjs move <taskId> --to running
 *   node task-registry.mjs dump-outbox [--ack <eventId>]
 *
 * 退出码：0 正常 / 1 有问题 / 2 用法错
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SCHEMA_VERSION = 1;

/** 允许的状态转移。任何不在表里的转移都是 bug。 */
export const TRANSITIONS = {
  received: ['ignored', 'awaiting_approval', 'queued', 'cancelled'],
  awaiting_approval: ['queued', 'cancelled', 'ignored'],
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'interrupted', 'cancelled'],
  // 中断/失败都不能自己回到 queued：有副作用的操作必须先核对。
  interrupted: ['needs_reconciliation', 'cancelled'],
  failed: ['needs_reconciliation', 'cancelled'],
  needs_reconciliation: ['queued', 'cancelled'],   // 人工确认后才能重新排队
  succeeded: [],
  cancelled: [],
  ignored: [],
};

export const TERMINAL = new Set(['succeeded', 'cancelled', 'ignored']);

export class TaskError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}

/** 数据目录：与 turns/trace/in-flight 同一口径。 */
export function registryPath(dataDir) {
  return path.join(dataDir || process.env.DSH_IOS_DATA || process.cwd(), 'tasks.json');
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, seq: 0, tasks: {}, idempotency: {}, outbox: [] };
}

/** 读文件；不存在/损坏都返回空状态，不让一个坏文件卡死整个调度。 */
export function load(dataDir) {
  const file = registryPath(dataDir);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.tasks) return emptyState();
    return {
      schemaVersion: parsed.schemaVersion ?? SCHEMA_VERSION,
      seq: Number.isInteger(parsed.seq) ? parsed.seq : 0,
      tasks: parsed.tasks,
      idempotency: parsed.idempotency ?? {},
      outbox: Array.isArray(parsed.outbox) ? parsed.outbox : [],
    };
  } catch {
    return emptyState();
  }
}

/** 原子写：tmp + rename，崩溃时不会留下半个 JSON。 */
export function save(state, dataDir) {
  const file = registryPath(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 0), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败无所谓 */ }
    throw new TaskError(`任务表写入失败：${error.message}`, 'io');
  }
}

/** 幂等键：来源 + 事件 id。缺一个就退化成标题哈希（仍能防重复标题的重投）。 */
function idempotencyKey(source, eventId, fallback) {
  const s = String(source ?? '').trim();
  const e = String(eventId ?? '').trim();
  if (s && e) return `${s}:${e}`;
  if (fallback) return `title:${crypto.createHash('sha1').update(String(fallback)).digest('hex').slice(0, 16)}`;
  return null;
}

/**
 * 建任务。同一幂等键重复调用返回**已存在的那个**，不新建、不报错
 * （调用方要能分辨：`created: false` 表示这次是重投）。
 */
export function create(state, input, now = Date.now()) {
  const { source, eventId, title, sceneId = null, parentTaskId = null, threadKey = null, approval = 'none' } = input ?? {};
  if (!title || !String(title).trim()) throw new TaskError('建任务必须给 title', 'usage');

  const key = idempotencyKey(source, eventId, null);
  if (key && state.idempotency[key]) {
    const existing = state.tasks[state.idempotency[key]];
    if (existing) return { state, task: existing, created: false };
  }

  state.seq = (state.seq ?? 0) + 1;
  const task = {
    taskId: `t${state.seq}-${crypto.randomUUID().slice(0, 8)}`,
    source: source ?? 'user',
    eventId: eventId ?? null,
    threadKey,
    sceneId,
    parentTaskId,
    title: String(title).trim().slice(0, 200),
    status: 'received',
    owner: 'router',
    createdAt: now,
    updatedAt: now,
    heartbeatAt: null,
    leaseUntil: null,
    approval,
    checkpoint: null,
    artifacts: [],
    lastError: null,
    history: [{ at: now, from: null, to: 'received', by: 'router' }],
  };
  state.tasks[task.taskId] = task;
  if (key) state.idempotency[key] = task.taskId;
  return { state, task, created: true };
}

/** 状态转移；非法转移抛错，不静默修正。 */
export function transition(state, taskId, to, { by = 'router', error = null, now = Date.now() } = {}) {
  const task = state.tasks[taskId];
  if (!task) throw new TaskError(`没有这个任务：${taskId}`, 'missing');
  const allowed = TRANSITIONS[task.status] ?? [];
  if (!allowed.includes(to)) {
    throw new TaskError(`非法转移：${task.status} → ${to}（允许：${allowed.join(', ') || '无'}）`, 'transition');
  }
  const from = task.status;
  task.status = to;
  task.updatedAt = now;
  if (to === 'running') task.heartbeatAt = now;
  if (error) task.lastError = String(error).slice(0, 500);
  task.history.push({ at: now, from, to, by });
  // history 无限长会拖大文件；留最近 50 条足够复盘。
  if (task.history.length > 50) task.history = task.history.slice(-50);
  return task;
}

/**
 * 把一条通知放进 outbox，与任务状态同一次写入。
 * 为什么不是直接写 notices.jsonl：先写任务再写通知之间崩溃，任务就没人知道；
 * 放同一个文件同一次 rename，两者要么都成功要么都失败。
 */
export function enqueue(state, { kind, message, taskId = null, detail = null }, now = Date.now()) {
  const event = {
    eventId: `e${now}-${crypto.randomUUID().slice(0, 8)}`,
    kind,
    message,
    taskId,
    detail,
    at: now,
    ackedAt: null,
  };
  state.outbox.push(event);
  // 上限：outbox 只存未投递的；投递成功后由 ack 删除。
  if (state.outbox.length > 500) state.outbox = state.outbox.slice(-500);
  return event;
}

/**
 * 标记已投递。重复调用必须幂等返回 true。
 *
 * ⚠ 不能像早期版本那样 ack 后立刻从 outbox 删除：删除之后第二次 ack 就找不到
 * 事件了，返回 false——调用方会以为投递失败，于是重发，造成重复提醒。
 * 正确做法是打上 ackedAt，读取时过滤；由 gc() 负责真正清理。
 */
export function ack(state, eventId, now = Date.now()) {
  const event = state.outbox.find((e) => e.eventId === eventId);
  if (!event) return false;
  if (!event.ackedAt) event.ackedAt = now;
  return true;
}

/**
 * 清理已 ack 且超过保留期的事件。
 * 保留期存在的理由：短时间内的重复 ack 要能识别，长期堆着又要占空间。
 */
export function gc(state, { now = Date.now(), keepMs = 24 * 60 * 60_000 } = {}) {
  const before = state.outbox.length;
  state.outbox = state.outbox.filter((e) => !e.ackedAt || now - e.ackedAt < keepMs);
  return before - state.outbox.length;
}

export function pendingOutbox(state) {
  return (state.outbox ?? []).filter((e) => !e.ackedAt);
}

/** 租约过期的 running 任务：watchdog 的依据。 */
export function expired(state, now = Date.now()) {
  return Object.values(state.tasks).filter(
    (t) => t.status === 'running' && t.leaseUntil !== null && t.leaseUntil < now,
  );
}

// ── CLI ───────────────────────────────────────────────────────────────

function cli(argv) {
  const dir = process.env.DSH_IOS_DATA || process.cwd();
  const state = load(dir);
  const [cmd, ...rest] = argv;
  const opt = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  switch (cmd) {
    case 'list': {
      const filter = opt('status');
      const rows = Object.values(state.tasks).filter((t) => !filter || t.status === filter);
      if (!rows.length) { console.log('没有任务'); return 0; }
      for (const t of rows.sort((a, b) => b.updatedAt - a.updatedAt)) {
        console.log(`${t.taskId}  ${t.status.padEnd(20)}  ${t.title}`);
      }
      return 0;
    }
    case 'show': {
      const id = rest[0];
      const t = state.tasks[id];
      if (!t) { console.error(`没有这个任务：${id}`); return 1; }
      console.log(JSON.stringify(t, null, 2));
      return 0;
    }
    case 'add': {
      const { task } = create(state, {
        source: opt('source') ?? 'user',
        eventId: opt('event-id'),
        sceneId: opt('scene'),
        title: opt('title'),
      });
      save(state, dir);
      console.log(task.taskId);
      return 0;
    }
    case 'move': {
      const id = rest[0];
      const to = opt('to');
      try {
        transition(state, id, to, { by: opt('by') ?? 'cli' });
        save(state, dir);
        console.log(`✓ ${id} → ${to}`);
        return 0;
      } catch (error) {
        console.error(error.message);
        return 1;
      }
    }
    case 'dump-outbox': {
      const ackId = opt('ack');
      if (ackId) { ack(state, ackId); save(state, dir); console.log(`✓ ack ${ackId}`); return 0; }
      const rows = pendingOutbox(state);
      if (!rows.length) { console.log('outbox 空'); return 0; }
      for (const e of rows) console.log(`${e.eventId}  ${e.kind}  ${e.message}`);
      return 0;
    }
    default:
      console.error('用法: task-registry.mjs <list|show|add|move|dump-outbox> [参数]');
      return 2;
  }
}

const isDirect = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isDirect) process.exit(cli(process.argv.slice(2)));
