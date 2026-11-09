// verify.test.mjs —— 引擎独立验证
//
// 守的是一条分界：**退出码是事实，模型的自我报告只是陈述**。
// 所以「命令失败」必须判 fail，「跑不起来」必须判 null（不冤枉任务）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifyCommands, describeFailure, MAX_COMMANDS } from '../runtime/verify.mjs';
import { create, load } from '../runtime/task-registry.mjs';
import { recordVerification } from '../runtime/task-tracking.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vf-'));

test('没有验证命令时返回 null（不是失败）', () => {
  assert.equal(verifyCommands([]).ok, null);
  assert.equal(verifyCommands(null).ok, null);
  assert.equal(verifyCommands(['  ']).ok, null);
});

test('命令全过 → true', () => {
  const r = verifyCommands(['true', 'echo ok']);
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 2);
});

test('命令失败 → false，并指出是哪一条', () => {
  const r = verifyCommands(['exit 3']);
  assert.equal(r.ok, false);
  assert.equal(r.results[0].exitCode, 3);
  assert.match(describeFailure(r), /exit 3/);
});

test('命令不存在 → null（环境问题不该算任务失败）', () => {
  const r = verifyCommands(['this-command-does-not-exist-xyz']);
  assert.equal(r.ok, null, '跑不起来不是失败');
  assert.equal(r.results[0].ok, null);
});

test('最多只跑 3 条（防止拖住调度循环）', () => {
  const r = verifyCommands(['true', 'true', 'true', 'true', 'true']);
  assert.equal(r.results.length, MAX_COMMANDS);
});

test('混合：一条失败盖过成功的', () => {
  const r = verifyCommands(['true', 'false', 'true']);
  assert.equal(r.ok, false);
});

test('recordVerification：命令失败会覆盖模型的 PASS', () => {
  const d = tmp();
  const state = load(d);
  const { task } = create(state, {
    source: 'external', eventId: 'e1', title: '修构建', note: '修构建',
    acceptance: '构建退出码 0', verify: ['exit 1'], threadKey: 'S1',
  });
  task.deliveredOnly = true;
  task.updatedAt = Date.now();
  task.acceptanceResult = 'pass';       // 模型自称通过了
  const { save } = { save: (s, dir) => import('../runtime/task-registry.mjs').then((m) => m.save(s, dir)) };
  return save(state, d).then(() => {
    const r = recordVerification(d, { sessionId: 'S1', cwd: os.tmpdir() });
    assert.equal(r.ran, true);
    assert.equal(r.ok, false);
    const after = load(d).tasks[task.taskId];
    assert.equal(after.acceptanceResult, 'fail', '退出码是事实，覆盖模型的自我报告');
    assert.match(after.acceptanceReason, /验证命令失败/);
    assert.ok(Array.isArray(after.verifyResults));
  });
});

test('没有待验证任务时安静返回，不抛错', () => {
  const d = tmp();
  const r = recordVerification(d, { sessionId: 'nobody' });
  assert.equal(r.ran, false);
});
