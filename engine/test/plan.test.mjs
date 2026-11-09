// plan.test.mjs —— 计划文件必须「写得随意也能用」
//
// 模型不会严格按格式写字。解析器认不出的行一律忽略，
// 只要有几条 `- [ ]` / `- [x]` 就能用——比要求严格格式然后没人遵守好。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parsePlan, readPlan, describeProgress, toView, PLAN_FILE } from '../runtime/plan.mjs';

test('基本解析：勾选状态与下一步', () => {
  const p = parsePlan([
    '# 计划',
    '- [x] 找出原因',
    '- [ ] 改 lockfile',
    '- [ ] 跑构建',
  ].join('\n'));
  assert.equal(p.total, 3);
  assert.equal(p.done, 1);
  assert.equal(p.next, '改 lockfile');
});

test('大写 X 与 `*` 列表符号都认', () => {
  const p = parsePlan('* [X] done\n* [ ] todo');
  assert.equal(p.total, 2);
  assert.equal(p.done, 1);
});

test('乱七八糟的行直接忽略，不影响剩下的', () => {
  const p = parsePlan('随便写点什么\n\n- [ ] 真的一件事\n> 引用\n');
  assert.equal(p.total, 1);
  assert.equal(p.next, '真的一件事');
});

test('没有勾选行时返回 null（不假装有计划）', () => {
  assert.equal(parsePlan('只是一段说明\n没有清单'), null);
  assert.equal(parsePlan(''), null);
  assert.equal(parsePlan(null), null);
});

test('全部完成时 next 为 null', () => {
  const p = parsePlan('- [x] a\n- [x] b');
  assert.equal(p.next, null);
  assert.equal(describeProgress(p), '计划进度 2/2，全部完成');
});

test('readPlan 在目录里找 .plan.md', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  fs.writeFileSync(path.join(d, PLAN_FILE), '- [ ] 一件事\n');
  const p = readPlan(d);
  assert.equal(p.total, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('没有计划文件时返回 null，不抛错', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  assert.equal(readPlan(d), null);
  assert.equal(readPlan(null), null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('toView 给 App 的形状稳定（没有计划也能读）', () => {
  const empty = toView(null);
  assert.equal(empty.ok, false);
  assert.equal(empty.total, 0);
  const one = toView(parsePlan('- [ ] x'));
  assert.equal(one.ok, true);
  assert.equal(one.total, 1);
  assert.equal(one.items.length, 1);
});
