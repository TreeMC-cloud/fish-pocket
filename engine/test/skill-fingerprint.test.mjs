import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintOf } from '../skills/evolve/trace.mjs';

test('同话题同失败描述 → 同一指纹', () => {
  const a = fingerprintOf({ tag: '下载', problem: 'wait 卡死' });
  const b = fingerprintOf({ tag: '下载', problem: 'wait 卡死' });
  assert.equal(a, b);
});

test('标点和空白不影响指纹（同一次证据重跑要稳）', () => {
  const a = fingerprintOf({ tag: '下载', problem: '下载失败，wait 卡死' });
  const b = fingerprintOf({ tag: '下载', problem: '下载失败 wait 卡死。' });
  assert.equal(a, b, '标点差异不该产生新候选');
});

test('不同话题 → 不同指纹', () => {
  const a = fingerprintOf({ tag: '下载', problem: 'wait 卡死' });
  const b = fingerprintOf({ tag: '构建', problem: 'wait 卡死' });
  assert.notEqual(a, b);
});

test('同话题不同失败模式 → 不同指纹（不能把新问题挡掉）', () => {
  const a = fingerprintOf({ tag: '下载', problem: 'wait 卡死' });
  const b = fingerprintOf({ tag: '下载', problem: '签名 URL 过期' });
  assert.notEqual(a, b, '按 tag 去重会漏掉同一话题下的新坑');
});

test('指纹格式稳定（可直接比对）', () => {
  const fp = fingerprintOf({ tag: 'x', problem: 'y' });
  assert.match(fp, /^fp[0-9a-f]{8}$/);
});

test('空输入不炸', () => {
  assert.match(fingerprintOf({}), /^fp[0-9a-f]{8}$/);
  assert.match(fingerprintOf({ tag: null, problem: null }), /^fp[0-9a-f]{8}$/);
});
