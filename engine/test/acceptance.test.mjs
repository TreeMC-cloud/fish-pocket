// acceptance.test.mjs —— 完成标准 + 自检重做
//
// 守的不变量：**有完成标准的任务，收工时要被判合格/不合格**。
// 没有这一条，任务是「尽力而为」：用户只能事后发现不对再重来一轮。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildPrompt } from '../runtime/task-runner.mjs';
import { create, load, transition, save } from '../runtime/task-registry.mjs';
import { onTurnEnd, setAcceptance } from '../runtime/task-tracking.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));

test('有完成标准时，提示里要求逐条核对并给出固定收尾格式', () => {
  const p = buildPrompt({ source: 'external', note: '修构建', acceptance: '1. 构建退出码 0' });
  assert.ok(p.includes('完成标准'));
  assert.ok(p.includes('1. 构建退出码 0'));
  assert.ok(p.includes('ACCEPT: PASS'));
  assert.ok(p.includes('ACCEPT: FAIL'));
});

test('没有完成标准时，不啰嗦这段（闲聊轮次不该带它）', () => {
  const p = buildPrompt({ source: 'session:S1', note: '随便聊聊' });
  assert.ok(!p.includes('ACCEPT'));
});

test('落盘后能读回完成标准', () => {
  const d = tmp();
  const state = load(d);
  create(state, { source: 'external', eventId: 'e1', title: '修构建', note: '修构建', acceptance: '1. 退出码 0', threadKey: 'S1' });
  assert.equal(state.tasks[Object.keys(state.tasks)[0]].acceptance, '1. 退出码 0');
});

test('setAcceptance 只写投递型任务，普通轮次任务不碰', () => {
  const state = { tasks: {
    a: { taskId: 'a', deliveredOnly: true, threadKey: 'S1', updatedAt: Date.now() },
    b: { taskId: 'b', threadKey: 'S1', updatedAt: Date.now() },
  } };
  assert.equal(setAcceptance(state, { sessionId: 'S1', result: 'fail', reason: '没装依赖' }), 1);
  assert.equal(state.tasks.a.acceptanceResult, 'fail');
  assert.equal(state.tasks.a.acceptanceReason, '没装依赖');
  assert.equal(state.tasks.b.acceptanceResult, undefined);
});

test('同一轮重复判定不覆盖第一次结果', () => {
  const state = { tasks: {
    a: { taskId: 'a', deliveredOnly: true, threadKey: 'S1', updatedAt: Date.now(), acceptanceResult: 'fail' },
  } };
  assert.equal(setAcceptance(state, { sessionId: 'S1', result: 'pass' }), 0);
  assert.equal(state.tasks.a.acceptanceResult, 'fail');
});

test('太久之前的投递不配（可能不是这一轮）', () => {
  const state = { tasks: {
    a: { taskId: 'a', deliveredOnly: true, threadKey: 'S1', updatedAt: Date.now() - 60 * 60_000 },
  } };
  assert.equal(setAcceptance(state, { sessionId: 'S1', result: 'pass' }), 0);
});

test('onTurnEnd 把自检结果写进任务表', () => {
  const d = tmp();
  const state = load(d);
  const { task } = create(state, {
    source: 'external', eventId: 'e1', title: '修构建', note: '修构建',
    acceptance: '1. 退出码 0', threadKey: 'S1',
  });
  task.status = 'queued';
  task.deliveredOnly = true;
  // 让它处于 running，onTurnEnd 才会收尾
  transition(state, task.taskId, 'running', { by: 'router', now: Date.now() });
  save(state, d);

  onTurnEnd(d, { sessionId: 'S1', turn: 1, reasonKind: 'completed', acceptance: { result: 'fail', reason: '没装依赖' } });
  const after = load(d).tasks[task.taskId];
  assert.equal(after.acceptanceResult, 'fail');
  assert.equal(after.acceptanceReason, '没装依赖');
});
