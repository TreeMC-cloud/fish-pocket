import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tagsRelated, phraseVariant, clusterTraces, distill } from '../runtime/consolidate.mjs';
import { runDream } from '../runtime/dream.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cons-'));

// ── 标签聚类 ─────────────────────────────────────────────

test('两个相同标签视为相关', () => {
  assert.equal(tagsRelated(['下载', 'ipa'], ['下载', 'ipa']), true);
});

test('只有 1 个共同标签时看 Jaccard', () => {
  // inter=1, union=3 → 0.33 < 0.34 阈值
  assert.equal(tagsRelated(['a', 'b'], ['a', 'c']), false);
  // inter=1, union=2 → 0.5 > 0.34
  assert.equal(tagsRelated(['a', 'b'], ['a']), true);
});

test('中文短语变体算相关（措辞不同但同义）', () => {
  assert.equal(phraseVariant('下载ipa文件', 'ipa文件下载'), true);
});

test('短标签不做短语变体匹配，避免误命中', () => {
  assert.equal(tagsRelated(['下载'], ['上传']), false);
});

test('无标签的 trace 不参与聚类', () => {
  const clusters = clusterTraces([{ tags: [] }, { tags: ['a'] }]);
  assert.equal(clusters.length, 1, '空标签应被跳过');
});

test('标签相近的两条会聚成一簇', () => {
  const clusters = clusterTraces([
    { tags: ['下载', 'ipa'], ok: true },
    { tags: ['下载', 'ipa'], ok: false },
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].members.length, 2);
});

// ── 提炼门槛（关键：成功率）──────────────────────────────

test('样本不足 3 条不提炼', () => {
  const r = distill([
    { ok: true, summary: 'x', tags: ['t'] },
    { ok: true, summary: 'y', tags: ['t'] },
  ]);
  assert.equal(r.length, 0);
});

test('全失败不出技能（没有解法可学）', () => {
  const r = distill([
    { ok: false, summary: 'a', tags: ['t'] },
    { ok: false, summary: 'b', tags: ['t'] },
    { ok: false, summary: 'c', tags: ['t'] },
  ]);
  assert.equal(r.length, 0, '全失败的簇只说明难，说明不了怎么做');
});

test('成功率低于 60% 不提炼', () => {
  const r = distill([
    { ok: true, summary: 'a', tags: ['t'] },
    { ok: false, summary: 'b', tags: ['t'] },
    { ok: false, summary: 'c', tags: ['t'] },
  ]);
  assert.equal(r.length, 0, '33% 成功率不该固化成技能');
});

test('成功率达标才提炼，并带出成功率', () => {
  const r = distill([
    { ok: true, summary: 'a', tags: ['t'] },
    { ok: true, summary: 'b', tags: ['t'] },
    { ok: false, summary: 'c', tags: ['t'] },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].successRate, 0.667);
  assert.equal(r[0].samples, 3);
});

test('提炼出来的永远是 verified=false', () => {
  const r = distill([
    { ok: true, summary: 'a', tags: ['t'] },
    { ok: true, summary: 'b', tags: ['t'] },
    { ok: true, summary: 'c', tags: ['t'] },
  ]);
  assert.equal(r[0].verified, false, '绝不能自动激活');
});

test('两个不同簇分别判定，坏的不会拖累好的', () => {
  const r = distill([
    { ok: true, summary: 'x', tags: ['下载'] },
    { ok: true, summary: 'y', tags: ['下载'] },
    { ok: true, summary: 'z', tags: ['下载'] },
    { ok: false, summary: 'p', tags: ['构建'] },
    { ok: false, summary: 'q', tags: ['构建'] },
    { ok: false, summary: 'r', tags: ['构建'] },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].key, '下载');
});

// ── 写入记忆库 ───────────────────────────────────────────

test('Dream 默认把产出写进记忆库，且 verified=false', () => {
  const d = tmp();
  const now = Date.now();
  const rows = [
    { at: now - 3000, ok: true, summary: '成功做法 A', tags: ['下载'] },
    { at: now - 2000, ok: true, summary: '成功做法 B', tags: ['下载'] },
    { at: now - 1000, ok: false, summary: '失败', tags: ['下载'] },
  ];
  fs.writeFileSync(path.join(d, '.trace.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const writes = [];
  const store = { write: (m) => { writes.push(m); return { id: `m${writes.length}`, deduped: false }; } };
  const r = runDream(d, { minNew: 1, store });

  assert.equal(r.ran, true);
  assert.equal(writes.length, 1, '必须落库，不能只返回');
  assert.equal(writes[0].kind, 'procedural');
  assert.equal(writes[0].meta.verified, false);
  assert.equal(writes[0].meta.source, 'dream');
  assert.equal(writes[0].meta.successRate, 0.667);
});

test('没有 store 时只返回不落盘（预览模式）', () => {
  const d = tmp();
  const now = Date.now();
  fs.writeFileSync(path.join(d, '.trace.jsonl'),
    [1, 2, 3].map((i) => JSON.stringify({ at: now + i, ok: true, summary: `s${i}`, tags: ['t'] })).join('\n'));
  const r = runDream(d, { minNew: 1 });
  assert.equal(r.ran, true);
  assert.equal(r.stored, 0);
  assert.ok(r.produced.length >= 1);
});

test('写库失败不中断整轮整理', () => {
  const d = tmp();
  const now = Date.now();
  fs.writeFileSync(path.join(d, '.trace.jsonl'),
    [1, 2, 3].map((i) => JSON.stringify({ at: now + i, ok: true, summary: `s${i}`, tags: ['t'] })).join('\n'));
  const store = { write: () => { throw new Error('disk full'); } };
  const r = runDream(d, { minNew: 1, store });
  assert.equal(r.ran, true, '写库失败不该让整理整体失败');
  assert.equal(r.stored, 0);
});
