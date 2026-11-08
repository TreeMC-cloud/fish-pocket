import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load, save, create, enqueue, pendingOutbox } from '../runtime/task-registry.mjs';

/**
 * outbox 到提醒通道的投递必须真的发生，且只发生一次。
 *
 * 背景：任务写进表里但没人通知，等于「任务凭空消失」——这正是通知文件
 * （notices.jsonl）单通道的老问题：写失败就永久丢。outbox 与任务同一次写入，
 * 由每轮 flush，迟到但不丢；ack 保证不重复。
 */
async function guardWith(dir) {
  process.env.DSH_IOS_DATA = dir;
  const { default: AutoGuard } = await import(`../plugins/auto-guard/index.mjs?t=${Date.now()}`);
  const seen = [];
  const guard = new AutoGuard({ effect: (fn) => fn(), on: () => () => {}, logger: { warn: () => {} } }, {});
  guard.notify = (message, detail) => seen.push({ message, detail });
  return { guard, seen };
}

const session = { header: { id: 's1', origin: 'user' }, ownEvents: () => [] };

test('outbox 里的通知会在下一轮被投递并 ack', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
  const state = load(dir);
  const task = create(state, { source: 'webhook', eventId: 'e1', title: '修 CI' });
  enqueue(task.state, { kind: 'task_created', message: '新任务：修 CI', taskId: task.task.taskId });
  save(task.state, dir);
  assert.equal(pendingOutbox(load(dir)).length, 1);

  const { guard, seen } = await guardWith(dir);
  guard.onTurnStart(session);

  assert.equal(seen.length, 1, '必须投递恰好一条');
  assert.equal(seen[0].message, '新任务：修 CI');
  assert.equal(pendingOutbox(load(dir)).length, 0, '投递后应 ack');
});

test('第二轮不会重复投递同一条', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
  const state = load(dir);
  const task = create(state, { source: 'user', eventId: 'e2', title: 'T' });
  enqueue(task.state, { kind: 'task_created', message: '一次性通知', taskId: task.task.taskId });
  save(task.state, dir);

  const { guard, seen } = await guardWith(dir);
  guard.onTurnStart(session);
  guard.lastDispatchCheck = 0;          // 绕过派单检查的节流，专门测 outbox
  guard.onTurnStart(session);

  assert.equal(seen.filter((s) => s.message === '一次性通知').length, 1, '不能重复提醒');
});

test('空 outbox 不产生任何提醒', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
  const { guard, seen } = await guardWith(dir);
  guard.onTurnStart(session);
  assert.equal(seen.length, 0);
});
