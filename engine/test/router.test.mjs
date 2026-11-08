import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from '../runtime/router.mjs';
import { load, save, create, transition } from '../runtime/task-registry.mjs';

/**
 * Router 是调度层，不是执行层。这里钉住它的边界：
 *   1. 准入：来源白名单、空标题、需要审批的高风险来源
 *   2. 幂等：重复事件不重复建任务
 *   3. 并发预算：同时执行数不超过 maxConcurrent
 *   4. 失败不自动重跑：进 needs_reconciliation 而不是回队列
 *   5. watchdog：租约过期 → interrupted，同样不重跑
 */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'router-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('准入：来源白名单 / 空标题 / 需要审批', () => {
  const r = new Router({ dataDir: tmp() });
  assert.equal(r.decide({ source: 'user', title: '做点事' }).action, 'enqueue');
  assert.equal(r.decide({ source: 'evil', title: '做点事' }).action, 'ignore');
  assert.equal(r.decide({ source: 'user', title: '   ' }).action, 'ignore');
  assert.equal(r.decide({ source: 'webhook', title: 'issue' }, { requireApproval: ['webhook'] }).action, 'await_approval');
});

test('重复事件不重复建任务', () => {
  const r = new Router({ dataDir: tmp() });
  const a = r.accept({ source: 'user', eventId: 'e1', title: '修构建' });
  const b = r.accept({ source: 'user', eventId: 'e1', title: '修构建' });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.task.taskId, b.task.taskId);
});

test('需要审批的任务挂在 awaiting_approval，不会自己跑', () => {
  const r = new Router({ dataDir: tmp() });
  const a = r.accept({ source: 'webhook', eventId: 'w1', title: '线上告警' }, { requireApproval: ['webhook'] });
  assert.equal(a.action, 'await_approval');
  assert.equal(a.task.status, 'awaiting_approval');
  assert.equal(r.runnable().length, 0, '等审批的任务不该被调度');
  assert.deepEqual(r.pending().map((e) => e.kind), ['approval_needed']);
});

test('批准后才进入队列', () => {
  const r = new Router({ dataDir: tmp() });
  const a = r.accept({ source: 'webhook', eventId: 'w1', title: '线上告警' }, { requireApproval: ['webhook'] });
  r.approve(a.task.taskId);
  assert.equal(r.state().tasks[a.task.taskId].status, 'queued');
  assert.equal(r.runnable().length, 1);
});

test('并发不超过 maxConcurrent', async () => {
  let active = 0;
  let peak = 0;
  const r = new Router({
    dataDir: tmp(),
    maxConcurrent: 2,
    runTask: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await wait(40);
      active -= 1;
      return { ok: true };
    },
  });
  for (let i = 0; i < 5; i += 1) r.accept({ source: 'user', eventId: `e${i}`, title: `任务${i}` });
  await r.execute();
  await wait(400);
  assert.equal(peak, 2, `并发峰值应等于上限，实际 ${peak}`);
  const done = Object.values(r.state().tasks).filter((t) => t.status === 'succeeded');
  assert.equal(done.length, 5, '所有任务最终都应完成');
});

test('失败任务进 needs_reconciliation，不自动回队列', async () => {
  const r = new Router({ dataDir: tmp(), runTask: async () => ({ ok: false, error: '构建失败' }) });
  r.accept({ source: 'user', eventId: 'f1', title: '会失败的' });
  await r.execute();
  await wait(150);

  const task = Object.values(r.state().tasks)[0];
  assert.equal(task.status, 'needs_reconciliation');
  assert.equal(task.lastError, '构建失败');
  assert.equal(r.runnable().length, 0, '失败任务不能自己回到可调度状态');
  assert.ok(r.pending().some((e) => e.kind === 'task_failed'), '失败要通知');
});

test('runTask 抛异常也不拖垮 Router', async () => {
  const r = new Router({ dataDir: tmp(), runTask: async () => { throw new Error('炸了'); } });
  r.accept({ source: 'user', eventId: 'x1', title: '会炸的' });
  await r.execute();
  await wait(150);
  const task = Object.values(r.state().tasks)[0];
  assert.equal(task.status, 'needs_reconciliation');
  assert.match(task.lastError, /炸了/);
});

test('watchdog：租约过期 → interrupted，且不自动重跑', () => {
  const dir = tmp();
  let state = load(dir);
  const a = create(state, { source: 'user', eventId: 's1', title: '卡住的' });
  transition(a.state, a.task.taskId, 'queued');
  transition(a.state, a.task.taskId, 'running');
  a.state.tasks[a.task.taskId].leaseUntil = Date.now() - 1000;
  save(a.state, dir);

  const r = new Router({ dataDir: dir });
  const swept = r.sweep();
  assert.deepEqual(swept, [a.task.taskId]);
  assert.equal(r.state().tasks[a.task.taskId].status, 'interrupted');
  assert.equal(r.runnable().length, 0, '中断的任务不能自动回到队列');
  assert.ok(r.pending().some((e) => e.kind === 'task_interrupted'));
});

test('未过期的租约不会被误回收', () => {
  const dir = tmp();
  let state = load(dir);
  const a = create(state, { source: 'user', eventId: 's2', title: '还在跑' });
  transition(a.state, a.task.taskId, 'queued');
  transition(a.state, a.task.taskId, 'running');
  a.state.tasks[a.task.taskId].leaseUntil = Date.now() + 60_000;
  save(a.state, dir);

  assert.deepEqual(new Router({ dataDir: dir }).sweep(), []);
});

test('心跳延长租约', () => {
  const dir = tmp();
  let state = load(dir);
  const a = create(state, { source: 'user', eventId: 'h1', title: '长任务' });
  transition(a.state, a.task.taskId, 'queued');
  transition(a.state, a.task.taskId, 'running');
  save(a.state, dir);

  const r = new Router({ dataDir: dir });
  assert.equal(r.heartbeat(a.task.taskId), true);
  assert.ok(r.state().tasks[a.task.taskId].leaseUntil > Date.now());
  assert.equal(r.heartbeat('不存在'), false);
});

test('没注入 runTask 时只报告将要跑什么，不执行', async () => {
  const r = new Router({ dataDir: tmp() });
  r.accept({ source: 'user', eventId: 'n1', title: 'T' });
  const result = await r.execute();
  assert.deepEqual(result.started, []);
  assert.equal(result.wouldStart.length, 1);
});

test('并发满时给出可读原因', async () => {
  const r = new Router({
    dataDir: tmp(),
    maxConcurrent: 1,
    runTask: async () => { await wait(200); return { ok: true }; },
  });
  r.accept({ source: 'user', eventId: 'c1', title: 'A' });
  r.accept({ source: 'user', eventId: 'c2', title: 'B' });
  await r.execute();
  const again = await r.execute();
  assert.match(again.skipped, /并发已满/);
});
