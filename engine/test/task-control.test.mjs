// task-control.test.mjs —— 人工确认入口的契约
//
// 这个入口是失败任务唯一的出路。它坏掉的表现：任务永远卡在
// needs_reconciliation，而用户在界面上点了「重排」什么也不会发生，
// 也没有任何报错——所以每个动作都要正向、反向两侧断言。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Router } from '../runtime/router.mjs';
import * as ctl from '../runtime/task-control.mjs';
import { load } from '../runtime/task-registry.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tc-'));

/** 造一个停在 needs_reconciliation 的任务。 */
async function failedTask(dir) {
  const router = new Router({
    dataDir: dir,
    maxConcurrent: 1,
    runTask: async () => ({ ok: false, error: 'boom' }),
  });
  router.accept({ source: 'user', eventId: 'e1', title: '会失败的任务', threadKey: 'S1' });
  await router.execute();
  await new Promise((r) => setTimeout(r, 120));
  const task = Object.values(router.state().tasks)[0];
  return { router, task };
}

function writeRequest(dir, id, body) {
  const d = ctl.controlDir(dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${id}.json`), JSON.stringify(body));
  return d;
}

test('list 返回全部任务', () => {
  const d = tmp();
  const router = new Router({ dataDir: d, runTask: async () => ({ ok: true }) });
  router.accept({ source: 'user', eventId: 'e1', title: 'a', threadKey: 'S1' });
  writeRequest(d, 'r1', { action: 'list' });
  assert.equal(ctl.drain(router, d).handled, 1);

  const out = JSON.parse(fs.readFileSync(path.join(ctl.controlDir(d), 'r1.out'), 'utf8'));
  assert.equal(out.ok, true);
  assert.equal(out.total, 1);
  assert.equal(out.tasks[0].title, 'a');
});

test('requeue 把失败任务放回队列，并清掉残留状态', async () => {
  const d = tmp();
  const { router, task } = await failedTask(d);
  assert.equal(task.status, 'needs_reconciliation');

  writeRequest(d, 'r1', { action: 'requeue', taskId: task.taskId });
  ctl.drain(router, d);

  const after = load(d).tasks[task.taskId];
  assert.equal(after.status, 'queued', '重排后应回到队列');
  // 三样残留必须清掉，否则重排会立刻再失败
  assert.equal(after.failCount, 0, 'failCount 不清就会一下到改道阈值');
  assert.equal(after.lastFailReason, null);
  assert.equal(after.lastError, null, 'lastError 不清，界面会一直显示旧错误');
  assert.equal(after.deferCount, 0);
  assert.equal(after.leaseUntil, null, 'leaseUntil 不清会被 sweep 当成僵尸');
});

test('requeue 之后任务真的能重新跑起来', async () => {
  const d = tmp();
  let shouldFail = true;
  let runs = 0;
  const router = new Router({
    dataDir: d, maxConcurrent: 1,
    runTask: async () => { runs += 1; return shouldFail ? { ok: false, error: 'boom' } : { ok: true }; },
  });
  router.accept({ source: 'user', eventId: 'e1', title: '先失败', threadKey: 'S1' });
  await router.execute();
  await new Promise((r) => setTimeout(r, 120));
  const taskId = Object.values(router.state().tasks)[0].taskId;

  shouldFail = false;
  writeRequest(d, 'r1', { action: 'requeue', taskId });
  ctl.drain(router, d);
  await router.execute();
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(load(d).tasks[taskId].status, 'succeeded');
  assert.equal(runs, 2, '应该执行了两次（失败一次 + 重排后成功一次）');
});

test('cancel 能取消任务', () => {
  const d = tmp();
  const router = new Router({ dataDir: d, runTask: async () => ({ ok: true }) });
  const { task } = router.accept({ source: 'user', eventId: 'e1', title: 'x', threadKey: 'S1' });
  writeRequest(d, 'r1', { action: 'cancel', taskId: task.taskId });
  ctl.drain(router, d);
  assert.equal(load(d).tasks[task.taskId].status, 'cancelled');
});

test('未知动作被白名单拒绝（文件不能变成任意代码执行）', () => {
  const d = tmp();
  const router = new Router({ dataDir: d, runTask: async () => ({ ok: true }) });
  writeRequest(d, 'r1', { action: 'rm -rf /' });
  ctl.drain(router, d);
  const out = JSON.parse(fs.readFileSync(path.join(ctl.controlDir(d), 'r1.out'), 'utf8'));
  assert.equal(out.ok, false);
  assert.match(out.error, /未知动作/);
});

test('缺少 taskId 的动作被拒绝', () => {
  const d = tmp();
  const router = new Router({ dataDir: d, runTask: async () => ({ ok: true }) });
  writeRequest(d, 'r1', { action: 'requeue' });
  ctl.drain(router, d);
  const out = JSON.parse(fs.readFileSync(path.join(ctl.controlDir(d), 'r1.out'), 'utf8'));
  assert.equal(out.ok, false);
  assert.match(out.error, /缺少 taskId/);
});

test('坏 JSON 也写回结果（否则会每轮重试到永远）', () => {
  const d = tmp();
  const router = new Router({ dataDir: d, runTask: async () => ({ ok: true }) });
  const dir = ctl.controlDir(d);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ 这不是 JSON');

  assert.equal(ctl.drain(router, d).handled, 1);
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'bad.out'), 'utf8'));
  assert.equal(out.ok, false);
  assert.match(out.error, /请求格式错误/);
});

test('幂等：同一个请求不会处理两次', () => {
  const d = tmp();
  const router = new Router({ dataDir: d, runTask: async () => ({ ok: true }) });
  router.accept({ source: 'user', eventId: 'e1', title: 'x', threadKey: 'S1' });
  writeRequest(d, 'r1', { action: 'list' });

  assert.equal(ctl.drain(router, d).handled, 1);
  assert.equal(ctl.drain(router, d).handled, 0, '已处理过的不该再处理');
});

test('控制目录不存在时不抛异常', () => {
  const d = tmp();
  const router = new Router({ dataDir: d, runTask: async () => ({ ok: true }) });
  assert.doesNotThrow(() => ctl.drain(router, d));
  assert.equal(ctl.drain(router, d).handled, 0);
});
