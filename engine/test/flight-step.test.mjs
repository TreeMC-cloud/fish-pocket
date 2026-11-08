import test from 'node:test';
import assert from 'node:assert/strict';
import { describeStep } from '../runtime/flight-recorder.mjs';

test('工具名翻成人话', () => {
  assert.equal(describeStep('bash', ''), '正在运行命令');
  assert.equal(describeStep('mcp__fs__read', ''), '正在读取文件');
  assert.equal(describeStep('apply_patch', ''), '正在修改文件');
  assert.equal(describeStep('grep', ''), '正在搜索代码');
  assert.equal(describeStep('subagent_task', ''), '正在协调子智能体');
  assert.equal(describeStep('weird_tool', ''), '正在调用工具');
});

test('带摘要时拼在后面并截短', () => {
  assert.equal(describeStep('bash', 'npm run build'), '正在运行命令（npm run build）');
  const long = 'x'.repeat(100);
  const out = describeStep('bash', long);
  assert.ok(out.length < 60, `太长: ${out.length}`);
  assert.ok(out.includes('正在运行命令'));
});

test('空白摘要不产生空括号', () => {
  assert.equal(describeStep('read', '   '), '正在读取文件');
  assert.equal(describeStep('read', undefined), '正在读取文件');
});
