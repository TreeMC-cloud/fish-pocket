// selftest.test.mjs —— 自测本身要可信
//
// 自测是用来证明「接线通不通」的。它自己如果只是空跑一遍全绿，
// 那它就成了又一个「看起来在工作」的东西。所以这里断言的是：
// 每一项都真的跑了、并且在正常仓库里应该全过。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runSelfTest, writeSelfTest } from '../runtime/selftest.mjs';

test('自测在干净仓库上全部通过', async () => {
  const r = await runSelfTest();
  const failed = r.items.filter((i) => !i.ok);
  assert.equal(failed.length, 0,
    `这些检查没通过：${failed.map((i) => `${i.id}(${i.detail})`).join('；')}`);
  assert.equal(r.passed, r.total);
});

test('覆盖到六个关键链路，一个都不能少', async () => {
  const r = await runSelfTest();
  const ids = r.items.map((i) => i.id).sort();
  assert.deepEqual(ids, ['candidates', 'dispatch', 'identity', 'notices', 'proactive', 'tasks']);
});

test('writeSelfTest 落盘，且能被读回来', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  try {
    const r = await writeSelfTest(d);
    const file = path.join(d, 'selftest.json');
    assert.ok(fs.existsSync(file), '必须落盘，否则 App 看不到');
    const back = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(back.total, r.total);
    assert.equal(back.passed, r.passed);
    assert.ok(Array.isArray(back.items));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('自测不碰真实数据目录', async () => {
  const before = fs.existsSync(path.join(process.env.DSH_IOS_DATA || '/nonexistent', 'tasks.json'));
  await runSelfTest();
  const after = fs.existsSync(path.join(process.env.DSH_IOS_DATA || '/nonexistent', 'tasks.json'));
  assert.equal(before, after, '自测必须在临时目录里跑');
});
