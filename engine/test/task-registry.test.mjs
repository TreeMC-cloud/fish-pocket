import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  load, save, create, transition, enqueue, ack, gc, pendingOutbox, expired,
  TRANSITIONS, TaskError,
} from '../runtime/task-registry.mjs';

/**
 * Task Registry 是 Router/Worker 的地基。这里钉住四件事：
 *   1. 幂等：同一事件重投只建一个任务
 *   2. 状态机：非法转移必须抛错，不能静默修正
 *   3. outbox 与任务同一次写入（崩溃不会只成功一半）
 *   4. 原子写：写一半崩溃不能留下坏文件
 */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-'));

test('缺文件时返回空状态，坏文件也不崩', () => {
  const dir = tmp();
  assert.deepEqual(load(dir).tasks, {});
  fs.writeFileSync(path.join(dir, 'tasks.json'), '{ 半个 json');
  assert.deepEqual(load(dir).tasks, {}, '损坏的文件应退化成空，而不是抛错');
});

test('同一 source+eventId 重投只建一个任务', () => {
  const dir = tmp();
  let state = load(dir);
  const a = create(state, { source: 'webhook', eventId: 'gh-1', title: '修 CI' });
  const b = create(a.state, { source: 'webhook', eventId: 'gh-1', title: '修 CI（重投）' });
  assert.equal(a.created, true);
  assert.equal(b.created, false, '重投不应新建');
  assert.equal(b.task.taskId, a.task.taskId);
  assert.equal(Object.keys(b.state.tasks).length, 1);
});

test('不同事件建不同任务', () => {
  let state = load(tmp());
  const a = create(state, { source: 'webhook', eventId: 'a', title: 'A' });
  const b = create(a.state, { source: 'webhook', eventId: 'b', title: 'B' });
  assert.notEqual(a.task.taskId, b.task.taskId);
  assert.equal(Object.keys(b.state.tasks).length, 2);
});

test('非法转移抛错，且不改状态', () => {
  const a = create(load(tmp()), { source: 'user', eventId: '1', title: 'T' });
  assert.throws(
    () => transition(a.state, a.task.taskId, 'succeeded'),
    (e) => e instanceof TaskError && e.code === 'transition',
    'received 不能直接 succeeded',
  );
  assert.equal(a.state.tasks[a.task.taskId].status, 'received', '抛错后状态必须原样');
});

test('中断的任务必须先核对才能重排（不许自动重跑）', () => {
  const a = create(load(tmp()), { source: 'user', eventId: '1', title: 'T' });
  const id = a.task.taskId;
  transition(a.state, id, 'queued');
  transition(a.state, id, 'running');
  transition(a.state, id, 'interrupted');

  assert.throws(() => transition(a.state, id, 'running'), /非法转移/,
    'interrupted 直接回 running 会让有副作用的操作重跑');
  assert.throws(() => transition(a.state, id, 'queued'), /非法转移/);

  // 正确路径：人工核对后回到队列
  transition(a.state, id, 'needs_reconciliation');
  transition(a.state, id, 'queued');
  assert.equal(a.state.tasks[id].status, 'queued');
});

test('终态不能再离开', () => {
  for (const terminal of ['succeeded', 'cancelled', 'ignored']) {
    assert.deepEqual(TRANSITIONS[terminal], [], `${terminal} 应是终态`);
  }
});

test('outbox 与任务一起写盘，ack 后移除', () => {
  const dir = tmp();
  let state = load(dir);
  const a = create(state, { source: 'user', eventId: '1', title: 'T' });
  const event = enqueue(a.state, { kind: 'task_created', message: '新任务', taskId: a.task.taskId });
  save(a.state, dir);

  const reloaded = load(dir);
  assert.equal(reloaded.outbox.length, 1, '任务和通知必须在同一次写入里');
  assert.equal(pendingOutbox(reloaded)[0].eventId, event.eventId);

  ack(reloaded, event.eventId);
  save(reloaded, dir);
  assert.equal(pendingOutbox(load(dir)).length, 0, 'ack 后不应再算待投递');
  assert.equal(load(dir).outbox.length, 1, '记录保留，供重复 ack 幂等识别');
});

test('gc 只清已 ack 且超过保留期的', () => {
  const state = load(tmp());
  const old = enqueue(state, { kind: 'x', message: 'old' }, 1000);
  const fresh = enqueue(state, { kind: 'y', message: 'fresh' }, 90_000);
  ack(state, old.eventId, 1000);
  ack(state, fresh.eventId, 90_000);

  // 返回值在加了任务回收之后从数字变成了 { outbox, tasks } 两个计数。
  // 这里断言 outbox 那部分，另外补一条「任务回收」的测试（见下一个用例）。
  const reclaimed = gc(state, { now: 100_000, keepMs: 50_000 });
  assert.equal(reclaimed.outbox, 1);
  assert.deepEqual(state.outbox.map((e) => e.message), ['fresh'], '未过期的要留着');
});

test('gc 回收过期终态任务，但保留失败待处理的和新任务', () => {
  const dir = tmp();
  let state = load(dir);
  const now = 10_000_000;
  const old = now - 25 * 3600_000;   // 超过 24 小时保留期

  // 一个很久以前成功的：该被回收
  const done = create(state, { source: 'u', eventId: 'done', title: '旧成功' });
  state = done.state;
  for (const to of ['queued', 'running', 'succeeded']) transition(state, done.task.taskId, to);
  state.tasks[done.task.taskId].updatedAt = old;

  // 一个很久以前失败、等人处理的：必须留着——那是用户还要做的事
  const failed = create(state, { source: 'u', eventId: 'fail', title: '旧失败' });
  state = failed.state;
  for (const to of ['queued', 'running', 'failed', 'needs_reconciliation']) transition(state, failed.task.taskId, to);
  state.tasks[failed.task.taskId].updatedAt = old;

  // 一个刚成功的：必须留着
  const fresh = create(state, { source: 'u', eventId: 'fresh', title: '新成功' });
  state = fresh.state;
  for (const to of ['queued', 'running', 'succeeded']) transition(state, fresh.task.taskId, to);
  state.tasks[fresh.task.taskId].updatedAt = now;

  const reclaimed = gc(state, { now });
  assert.equal(reclaimed.tasks, 1, '只该回收那一个过期终态任务');
  assert.ok(!state.tasks[done.task.taskId], '过期成功任务应被删');
  assert.ok(state.tasks[failed.task.taskId], '失败待处理的任务不能删');
  assert.ok(state.tasks[fresh.task.taskId], '新任务不能删');
  // 幂等键要跟着一起清，否则同一条事件再来会被当成已处理
  assert.ok(!state.idempotency['u:done'], '被回收任务的幂等键也要清掉');
});

test('ack 不存在的 id 返回 false，重复 ack 幂等', () => {
  const state = load(tmp());
  assert.equal(ack(state, 'nope'), false);
  const e = enqueue(state, { kind: 'x', message: 'm' });
  assert.equal(ack(state, e.eventId), true);
  assert.equal(ack(state, e.eventId), true, '重复 ack 不应报错');
});

test('租约过期的 running 任务能被找出来（watchdog 依据）', () => {
  const a = create(load(tmp()), { source: 'user', eventId: '1', title: 'T' });
  const id = a.task.taskId;
  transition(a.state, id, 'queued');
  transition(a.state, id, 'running');
  a.state.tasks[id].leaseUntil = 1000;
  assert.equal(expired(a.state, 2000).length, 1);
  assert.equal(expired(a.state, 500).length, 0, '没到期不算');
});

test('写盘是原子的：不留下临时文件', () => {
  const dir = tmp();
  const state = load(dir);
  create(state, { source: 'user', eventId: '1', title: 'T' });
  save(state, dir);
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], '不应留下 .tmp 文件');
});

test('history 只保留最近 50 条，防止无限膨胀', () => {
  const a = create(load(tmp()), { source: 'user', eventId: '1', title: 'T' });
  const id = a.task.taskId;
  transition(a.state, id, 'queued');
  // 在 queued/running/cancelled 之间反复不可能，用合法循环跑满 60 次
  for (let i = 0; i < 30; i += 1) {
    transition(a.state, id, 'running');
    transition(a.state, id, 'interrupted');
    transition(a.state, id, 'needs_reconciliation');
    transition(a.state, id, 'queued');
  }
  assert.ok(a.state.tasks[id].history.length <= 50, `history 应被截断，实际 ${a.state.tasks[id].history.length}`);
});

// ── 版本与迁移（Phase 1/2 规范要求）────────────────────────

test('没有 schemaVersion 的旧文件能正常读（按 v1 处理）', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'tasks.json'),
    JSON.stringify({ seq: 3, tasks: { a: { taskId: 'a', title: 'T' } }, outbox: [] }));
  const state = load(dir);
  assert.equal(state.tasks.a.title, 'T');
  assert.equal(state.seq, 3);
});

test('文件版本比代码新时拒绝加载，不静默按旧格式读', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'tasks.json'),
    JSON.stringify({ schemaVersion: 99, seq: 0, tasks: {}, outbox: [] }));
  assert.throws(() => load(dir), /版本 99.*比当前代码支持的/,
    '降级安装时必须报错，否则会按错误理解改数据');
});

test('坏 JSON 会先备份再当空处理，不丢原始数据', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'tasks.json'), '{broken');
  const state = load(dir);
  assert.deepEqual(state.tasks, {});
  const backups = fs.readdirSync(dir).filter((f) => f.includes('corrupt'));
  assert.equal(backups.length, 1, '必须留一份原始文件');
});
