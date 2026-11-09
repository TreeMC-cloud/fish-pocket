// proactive.test.mjs —— 主动层的三条硬约束
//
// 它容易出的错不是「不干活」，是**干太多**：反复派活、忘了冷却、
// 把该等人拍板的事自己做掉。所以这里的断言大多在守「不该做什么」。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evaluate, runProactive } from '../runtime/proactive.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));

/**
 * 造 trace。
 * @param failsAt 哪几条失败：'recent' = 最近几条还在失败；'old' = 只有最早几条失败（已经好了）
 */
function seedTraces(dir, tag, { total = 8, fails = 6, failsAt = 'recent' } = {}) {
  const lines = [];
  const base = Date.now() - total * 1000;
  for (let i = 0; i < total; i += 1) {
    // 'recent'：最后 fails 条失败；'old'：最前 fails 条失败
    const bad = failsAt === 'recent' ? i >= total - fails : i < fails;
    lines.push(JSON.stringify({ at: base + i * 1000, ok: !bad, summary: bad ? '依赖缺失' : '正常', tags: [tag] }));
  }
  fs.writeFileSync(path.join(dir, '.trace.jsonl'), lines.join('\n') + '\n');
}

test('同一话题反复失败且仍在失败 → 自动派活', () => {
  const d = tmp();
  seedTraces(d, '构建', { total: 8, fails: 6, failsAt: 'recent' });
  let enqueued = 0;
  const r = runProactive(d, { sessionId: 'S1', enqueue: () => { enqueued += 1; }, notify: () => {} });
  assert.equal(enqueued, 1, '该主动派一次活去查为什么一直失败');
  assert.equal(r.acted[0].kind, 'repeat_fail_topic');
});

test('历史上失败过但最近已经好了 → 不派活', () => {
  const d = tmp();
  seedTraces(d, '构建', { total: 14, fails: 4, failsAt: 'old' });
  let enqueued = 0;
  runProactive(d, { sessionId: 'S1', enqueue: () => { enqueued += 1; }, notify: () => {} });
  assert.equal(enqueued, 0, '已经自己好了，不该再派活');
});

test('冷却期内不重复派活', () => {
  const d = tmp();
  seedTraces(d, '构建', { total: 8, fails: 6, failsAt: 'recent' });
  let enqueued = 0;
  runProactive(d, { sessionId: 'S1', enqueue: () => { enqueued += 1; }, notify: () => {} });
  runProactive(d, { sessionId: 'S1', enqueue: () => { enqueued += 1; }, notify: () => {} });
  assert.equal(enqueued, 1, '同一件事 6 小时内只该派一次');
});

test('没有活跃会话时只提醒不派活（不投给不存在的会话）', () => {
  const d = tmp();
  seedTraces(d, '构建', { total: 8, fails: 6, failsAt: 'recent' });
  let enqueued = 0;
  const r = runProactive(d, { sessionId: null, enqueue: () => { enqueued += 1; }, notify: () => {} });
  assert.equal(enqueued, 0);
  assert.ok(r.skipped.some((s) => s.why.includes('会话')));
});

test('每日自动派活不超过 3 个', () => {
  const d = tmp();
  // 三个不同话题都在反复失败
  const lines = [];
  const base = Date.now() - 30_000;
  for (const tag of ['甲', '乙', '丙', '丁']) {
    for (let i = 0; i < 6; i += 1) {
      lines.push(JSON.stringify({ at: base + i * 100, ok: i === 5 ? false : i % 3 !== 0, summary: '失败', tags: [tag] }));
    }
  }
  fs.writeFileSync(path.join(d, '.trace.jsonl'), lines.join('\n') + '\n');

  let enqueued = 0;
  // 每次推进 2 小时（跳过 1 小时间隔与 6 小时冷却中的前者）
  for (let hour = 0; hour < 6; hour += 1) {
    runProactive(d, {
      now: Date.now() + hour * 60 * 60_000,
      sessionId: 'S1',
      enqueue: () => { enqueued += 1; },
      notify: () => {},
    });
  }
  assert.ok(enqueued <= 3, `一天最多派 3 个，实际派了 ${enqueued}`);
});

test('候选技能挂了一天 → 只提醒，不自动提升成技能', () => {
  const d = tmp();
  const old = Date.now() - 30 * 60 * 60_000;
  fs.writeFileSync(path.join(d, '.skill-candidates.jsonl'),
    JSON.stringify({ at: old, tag: '构建', problem: 'x', verified: false }) + '\n');
  let notified = 0;
  let enqueued = 0;
  runProactive(d, { sessionId: 'S1', enqueue: () => { enqueued += 1; }, notify: () => { notified += 1; } });
  assert.equal(notified, 1, '要提醒有人该看一眼');
  assert.equal(enqueued, 0, '要不要固化成技能必须人判断，不能自动派活');
});

test('失败任务卡住 → 只提醒，不自动重跑', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'tasks.json'), JSON.stringify({
    schemaVersion: 1,
    tasks: { t1: { taskId: 't1', title: '会失败的任务', status: 'needs_reconciliation',
                    updatedAt: Date.now() - 3 * 60 * 60_000 } },
  }));
  let notified = 0;
  let enqueued = 0;
  runProactive(d, { sessionId: 'S1', enqueue: () => { enqueued += 1; }, notify: () => { notified += 1; } });
  assert.equal(notified, 1);
  assert.equal(enqueued, 0, '有副作用的失败任务不能自动重跑');
});

test('状态干净时什么都不做', () => {
  const d = tmp();
  const r = runProactive(d, { sessionId: 'S1', enqueue: () => {}, notify: () => {} });
  assert.equal(r.acted.length, 0);
  assert.equal(evaluate(d).length, 0);
});

test('自动派出的任务写清了依据，不是一句「你去看看」', () => {
  const d = tmp();
  seedTraces(d, '构建', { total: 8, fails: 6, failsAt: 'recent' });
  let text = '';
  runProactive(d, { sessionId: 'S1', enqueue: ({ text: t }) => { text = t; }, notify: () => {} });
  assert.ok(text.includes('构建'), '要说清是哪件事');
  assert.ok(text.includes('只读'), '要限定为只读排查，避免它自己动手改东西');
  assert.ok(text.includes('不需要等我确认'));
});
