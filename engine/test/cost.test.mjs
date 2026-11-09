// cost.test.mjs —— 用量聚合要说实话
//
// 聚合最容易出的错是「算多了」：把缓存读取算成新增输入、
// 把累计值当成增量重复加。这里断言的是边界而不是精度。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { summarize, describe, fmt, prune, USAGE_FILE } from '../runtime/cost.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cost-'));

function seed(dir, rows) {
  fs.writeFileSync(path.join(dir, USAGE_FILE), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('没有记录时如实说没有', () => {
  const d = tmp();
  const s = summarize(d);
  assert.equal(s.ok, false);
  assert.equal(describe(s), null);
});

test('今日与累计分开算', () => {
  const d = tmp();
  const now = Date.now();
  seed(d, [
    { at: now - 1000, session: 'S1', turn: 1, input: 1000, output: 100, cacheRead: 500 },
    { at: now - 3 * 86400000, session: 'S1', turn: 2, input: 9000, output: 900, cacheRead: 0 },
  ]);
  const s = summarize(d, { now });
  assert.equal(s.today.turns, 1);
  assert.equal(s.today.input, 1000);
  assert.equal(s.total.turns, 2);
  assert.equal(s.total.input, 10000);
});

test('缓存读取单独计，不并进 input', () => {
  const d = tmp();
  seed(d, [{ at: Date.now(), session: 'S1', turn: 1, input: 100, output: 10, cacheRead: 5000 }]);
  const s = summarize(d);
  assert.equal(s.total.input, 100, 'input 只算新增输入');
  assert.equal(s.total.cacheRead, 5000);
});

test('坏行跳过，不影响其他行', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, USAGE_FILE),
    '{"at":1,"input":10,"output":1}\n这不是JSON\n{"at":2,"input":20,"output":2}\n');
  const s = summarize(d);
  assert.equal(s.total.input, 30);
});

test('负数/NaN 当 0，不把总额拉低', () => {
  const d = tmp();
  seed(d, [{ at: Date.now(), input: -999, output: 'abc', cacheRead: null }]);
  const s = summarize(d);
  assert.equal(s.total.input, 0);
  assert.equal(s.total.output, 0);
});

test('fmt 的口径', () => {
  assert.equal(fmt(999), '999');
  assert.equal(fmt(12345), '12.3k');
  assert.equal(fmt(2_500_000), '2.50M');
});

test('prune 只删过期行', () => {
  const d = tmp();
  const now = Date.now();
  seed(d, [
    { at: now - 1000, input: 1 },
    { at: now - 40 * 86400000, input: 2 },
  ]);
  const r = prune(d, { now, keepDays: 30 });
  assert.equal(r.dropped, 1);
  assert.equal(summarize(d, { now }).total.turns, 1);
});
