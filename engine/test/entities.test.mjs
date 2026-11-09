// entities.test.mjs —— 实体抽取必须「认准，不乱认」
//
// 抽错了会把不相干的记忆塞进上下文，比不检索更糟。
// 所以这里大量断言「不该抽什么」。

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractEntities, mergeKeywords } from '../runtime/entities.mjs';

test('认出文件路径', () => {
  assert.deepEqual(extractEntities('改 engine/runtime/router.mjs 里的判断'), ['engine/runtime/router.mjs']);
});

test('认出模块名与错误码', () => {
  const e = extractEntities('dsh-llm-retry 报 ERR_MODULE_NOT_FOUND');
  assert.ok(e.includes('dsh-llm-retry'));
  assert.ok(e.includes('ERR_MODULE_NOT_FOUND'));
});

test('普通叙述不产实体（宁缺勿滥）', () => {
  assert.deepEqual(extractEntities('今天先把这件事想清楚'), []);
  assert.deepEqual(extractEntities(''), []);
});

test('常见缩写不当实体（否则所有记忆都会被搜出来）', () => {
  const e = extractEntities('返回 ACCEPT: PASS，HTTP 200，OK');
  assert.ok(!e.includes('PASS'));
  assert.ok(!e.includes('OK'));
});

test('去重并保持出现顺序', () => {
  const e = extractEntities('a/b.mjs 和 a/b.mjs 还有 c/d.mjs');
  assert.deepEqual(e, ['a/b.mjs', 'c/d.mjs']);
});

test('数量有上限（关键词太多反而搜不准）', () => {
  const many = Array.from({ length: 20 }, (_, i) => `dir/f${i}.mjs`).join(' ');
  assert.ok(extractEntities(many).length <= 8);
});

test('mergeKeywords 合并且去重', () => {
  const k = mergeKeywords(['构建', 'router.mjs'], ['router.mjs', 'ERR_X_Y']);
  assert.deepEqual(k, ['构建', 'router.mjs', 'ERR_X_Y']);
});
