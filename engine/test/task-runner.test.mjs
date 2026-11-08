// task-runner.test.mjs —— Router 执行层的契约
//
// 这一层决定「队列里的任务到底有没有被投出去」。它坏掉的表现是
// 任务状态显示 succeeded 但会话里什么都没发生——比报错更糟。
// 所以每个分支都要断言"实际发生了什么"，不只看返回值。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Router } from '../runtime/router.mjs';
import { makeRunTask, buildPrompt, tick } from '../runtime/task-runner.mjs';
import { load } from '../runtime/task-registry.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));

test('正常投递：消息进到目标会话，带自动任务标记', async () => {
  const injected = [];
  const ctx = { agents: { get: (id) => ({ inject: (m) => injected.push({ id, m }) }) } };
  const runTask = makeRunTask({ ctx, createUserMessage: (x) => x });

  const r = await runTask({ threadKey: 'S1', title: '整理记忆', source: 'schedule' });
  assert.equal(r.ok, true);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].id, 'S1', '要投给 threadKey 指的会话');
  assert.equal(injected[0].m.source.kind, 'schedule', '来源必须是 schedule，不能伪装成用户说的');
  assert.match(injected[0].m.content[0].text, /整理记忆/);
});

test('消息里说明这是自动任务（否则模型会当成随口闲聊）', () => {
  const text = buildPrompt({ title: '检查构建', source: 'schedule' });
  assert.match(text, /自动任务/);
  assert.match(text, /检查构建/);
  assert.match(text, /不需要确认/);
});

test('没有目标会话的任务不执行（派给谁还没定，不该默默跑掉）', async () => {
  const injected = [];
  const ctx = { agents: { get: () => ({ inject: (m) => injected.push(m) }) } };
  const runTask = makeRunTask({ ctx, createUserMessage: (x) => x });

  const r = await runTask({ title: '无主', source: 'schedule' });
  assert.equal(r.ok, false);
  assert.match(r.error, /没有目标会话/);
  assert.equal(injected.length, 0, '不能瞎投');
});

test('ctx.agents 不可用时不崩，返回错误', async () => {
  const runTask = makeRunTask({ ctx: {}, createUserMessage: (x) => x });
  const r = await runTask({ threadKey: 'S1', title: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /agents/);
});

test('会话未加载 → retryable（不是失败，是稍后再来）', async () => {
  const ctx = { agents: { get: () => undefined } };
  const runTask = makeRunTask({ ctx, createUserMessage: (x) => x });
  const r = await runTask({ threadKey: 'S1', title: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true, '这种情况必须标 retryable，否则会进人工确认队列');
});

test('inject 抛异常时收敛成错误，不向上抛', async () => {
  const ctx = { agents: { get: () => ({ inject: () => { throw new Error('炸了'); } }) } };
  const runTask = makeRunTask({ ctx, createUserMessage: (x) => x });
  const r = await runTask({ threadKey: 'S1', title: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /炸了/);
});

test('tick 先 sweep 再 execute（顺序不能反）', async () => {
  const d = tmp();
  const order = [];
  const router = new Router({
    dataDir: d,
    maxConcurrent: 1,
    runTask: async () => { order.push('run'); return { ok: true }; },
  });
  const origSweep = router.sweep.bind(router);
  router.sweep = () => { order.push('sweep'); return origSweep(); };

  router.accept({ source: 'user', eventId: 'e1', title: 'x', threadKey: 'S1' });
  await tick(router);
  assert.deepEqual(order.slice(0, 2), ['sweep', 'run'],
    '必须先 sweep 收僵尸，把并发名额让给队列');
});

test('retryable 的任务退回队列而不是进失败队列', async () => {
  const d = tmp();
  const router = new Router({
    dataDir: d,
    maxConcurrent: 1,
    runTask: async () => ({ ok: false, error: '会话未加载', retryable: true }),
  });
  router.accept({ source: 'user', eventId: 'e1', title: 'x', threadKey: 'S1' });
  await router.execute();
  await new Promise((r) => setTimeout(r, 150));

  const t = Object.values(load(d).tasks)[0];
  assert.equal(t.status, 'queued', '应该回到队列等着，不是 needs_reconciliation');
  assert.equal(t.deferCount, 1);
  assert.ok(t.deferAfter > Date.now(), '必须有冷却时间，否则会忙循环');
});

test('完整链路：accept → tick → 注入 → succeeded', async () => {
  const d = tmp();
  const injected = [];
  const ctx = { agents: { get: (id) => ({ inject: (m) => injected.push({ id, m }) }) } };
  const router = new Router({
    dataDir: d, maxConcurrent: 2,
    runTask: makeRunTask({ ctx, createUserMessage: (x) => x }),
  });

  router.accept({ source: 'schedule', eventId: 'j1', title: '甲', threadKey: 'SA' });
  router.accept({ source: 'schedule', eventId: 'j2', title: '乙', threadKey: 'SA' });
  const r = await tick(router);
  await new Promise((res) => setTimeout(res, 200));

  assert.equal(r.started.length, 2);
  assert.equal(injected.length, 2);
  const tasks = Object.values(load(d).tasks);
  assert.equal(tasks.filter((t) => t.status === 'succeeded').length, 2);
});
