// dream-candidates.test.mjs —— 自动整理必须能产出候选技能
//
// 守的不变量：**进化链路到候选为止是全自动的**。
//
// 此前这里断了一刀：Dream 自动整理只把经验写进记忆库，候选表要靠用户
// 手动跑 `trace.mjs distill` 才有内容。表现就是「自动整理看着在跑，
// 但候选技能永远是空的」——又是一个不报错的静默失效。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runDream } from '../runtime/dream.mjs';
import { candidateFile, deriveCandidates } from '../runtime/candidates.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dm-'));

/** 造 trace：bad 话题 10 条里失败 8 条，good 话题全成功。合计要 ≥20 条才过 Dream 的闸。 */
function seed(dir, { bad = 10, good = 15 } = {}) {
  const lines = [];
  const base = Date.now() - 60_000;
  for (let i = 0; i < bad; i += 1) {
    lines.push(JSON.stringify({
      at: base + i,
      ok: i < 2,
      summary: i < 2 ? '用 --fix 后通过' : '依赖缺失导致构建失败',
      tags: ['构建'],
    }));
  }
  for (let i = 0; i < good; i += 1) {
    lines.push(JSON.stringify({ at: base + 1000 + i, ok: true, summary: '正常', tags: ['代码'] }));
  }
  fs.writeFileSync(path.join(dir, '.trace.jsonl'), lines.join('\n') + '\n');
}

test('Dream 自动整理时顺手产出候选技能', () => {
  const d = tmp();
  seed(d);
  const r = runDream(d, { store: null });

  assert.equal(r.ran, true, '够了 20 条新 trace，应该真的跑');
  assert.equal(r.candidatesAdded, 1, '够格的簇要变成候选');

  const rows = fs.readFileSync(candidateFile(d), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tag, '构建');
  assert.equal(rows[0].verified, false, '自动产出的候选永不自动激活');
  assert.ok(rows[0].fingerprint, '必须带指纹，否则会反复堆同一条');
  assert.equal(rows[0].failRatio, 0.8);
});

test('候选写进的是 promote 读的那个文件（同一份）', () => {
  const d = tmp();
  seed(d);
  runDream(d, { store: null });
  assert.ok(fs.existsSync(path.join(d, '.skill-candidates.jsonl')),
    'Dream 写的位置必须是 promote 默认读的位置');
});

test('一路顺利的话题不产出候选（没有坑就不算经验）', () => {
  const d = tmp();
  seed(d, { bad: 0, good: 25 });
  const r = runDream(d, { store: null });
  assert.equal(r.ran, true);
  assert.equal(r.candidatesAdded, 0);
  assert.equal(fs.existsSync(candidateFile(d)), false);
});

test('同一批证据重跑：指纹挡住，不重复堆', () => {
  const traces = [
    { at: 1, ok: false, summary: '依赖缺失导致构建失败', tags: ['构建'] },
    { at: 2, ok: false, summary: '依赖缺失导致构建失败', tags: ['构建'] },
    { at: 3, ok: false, summary: '依赖缺失导致构建失败', tags: ['构建'] },
    { at: 4, ok: true, summary: '用 --fix 后通过', tags: ['构建'] },
  ];
  const a = deriveCandidates(traces, { now: 1 });
  const b = deriveCandidates(traces, { now: 2 });
  assert.equal(a.length, 1);
  assert.equal(a[0].tag, b[0].tag);
  assert.equal(a[0].problem, b[0].problem);
});

test('两次 Dream 之间没有新 trace 时不再重复产出', () => {
  const d = tmp();
  seed(d);
  const first = runDream(d, { store: null });
  assert.equal(first.candidatesAdded, 1);
  // 两小时后但没有新 trace：闸门按「新增量」拦住，不该重复整理。
  const second = runDream(d, { store: null, now: Date.now() + 2 * 60 * 60_000 });
  assert.equal(second.ran, false);
  const rows = fs.readFileSync(candidateFile(d), 'utf8').trim().split('\n');
  assert.equal(rows.length, 1, '候选表不能因为重跑而变长');
});
