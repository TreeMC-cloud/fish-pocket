import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from '../runtime/router.mjs';
import { load, save, transition } from '../runtime/task-registry.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
const wait = (ms = 150) => new Promise((s) => setTimeout(s, ms));

/** 建一个会按给定序列返回结果的 Router。 */
async function setup(results) {
  const dir = tmp();
  let i = 0;
  const r = new Router({
    dataDir: dir,
    runTask: async () => results[Math.min(i++, results.length - 1)],
  });
  r.accept({ source: 'user', eventId: 'e1', title: 'T' });
  const id = Object.keys(r.state().tasks)[0];
  return { r, dir, id };
}

/** 人工确认后重新排队（模拟 needs_reconciliation 被处理）。 */
function requeue(dir, id) {
  const st = load(dir);
  transition(st, id, 'queued');
  save(st, dir);
}

test('第一次失败记 1 次，通知是普通失败', async () => {
  const { r, id } = await setup([{ ok: false, error: '同样的错' }]);
  await r.execute();
  await wait();
  const t = r.state().tasks[id];
  assert.equal(t.failCount, 1);
  assert.ok(r.pending().some((e) => e.kind === 'task_failed'));
});

test('同因连续失败 2 次触发改道', async () => {
  const { r, dir, id } = await setup([{ ok: false, error: '同样的错' }]);
  await r.execute();
  await wait();
  requeue(dir, id);
  await r.execute();
  await wait();

  const t = r.state().tasks[id];
  assert.equal(t.failCount, 2);
  assert.ok(r.pending().some((e) => e.kind === 'task_needs_redesign'), '该改道却没改道');
});

test('不同原因不累加（是新问题，不是老病复发）', async () => {
  const { r, dir, id } = await setup([
    { ok: false, error: '错误 A' },
    { ok: false, error: '错误 B' },
  ]);
  await r.execute();
  await wait();
  requeue(dir, id);
  await r.execute();
  await wait();

  const t = r.state().tasks[id];
  assert.equal(t.failCount, 1, '不同原因应重新计数');
  assert.equal(r.pending().some((e) => e.kind === 'task_needs_redesign'), false);
});

test('中间成功过就清零（不算连续）', async () => {
  const { r, dir, id } = await setup([
    { ok: false, error: '同样的错' },
    { ok: true },
  ]);
  await r.execute();
  await wait();
  requeue(dir, id);
  await r.execute();
  await wait();

  const t = r.state().tasks[id];
  assert.equal(t.status, 'succeeded');
  assert.equal(t.failCount, 0, '成功后必须清零');
});

test('改道后仍保持 needs_reconciliation，不自动重跑', async () => {
  const { r, dir, id } = await setup([{ ok: false, error: '同样的错' }]);
  await r.execute();
  await wait();
  requeue(dir, id);
  await r.execute();
  await wait();

  const t = r.state().tasks[id];
  assert.equal(t.status, 'needs_reconciliation');
  assert.equal(r.runnable().length, 0, '改道不等于自动重跑');
});

test('改道通知里带上连续次数和原因', async () => {
  const { r, dir, id } = await setup([{ ok: false, error: 'xcodebuild 退出码 65' }]);
  await r.execute();
  await wait();
  requeue(dir, id);
  await r.execute();
  await wait();

  const note = r.pending().find((e) => e.kind === 'task_needs_redesign');
  assert.ok(note);
  assert.equal(note.detail.consecutiveFailures, 2);
  assert.match(note.detail.reason, /xcodebuild/);
  assert.match(note.message, /别再原样重试/);
});
