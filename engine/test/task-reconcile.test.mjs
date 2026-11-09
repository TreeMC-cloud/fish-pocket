// 「投递型任务」的结果回写测试。
//
// 背景：Router 投递任务时，`agent.inject()` 一返回就被标成 succeeded——
// 那只代表**消息投进去了**，这一轮有没有做成还不知道。
// 不回写的话，会话失败之后任务表仍显示正常，账本就不可信了。
//
// 这里守的不变量：
//   1. 同一会话、最近投递过的任务，能在 turn/end 时拿到真实结果
//   2. status 不能改（succeeded 是终态，且「投递成功」本身也是事实）
//   3. 别的会话、太久之前的任务**不能**被误配

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as registry from '../runtime/task-registry.mjs';
import { reconcileDelivered } from '../runtime/task-tracking.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));

/** 造一个已投递、但还没有结果的任务。 */
function seed(dir, { sessionId = 'S1', eventId = 'job', ageMs = 60_000, now } = {}) {
  let state = registry.load(dir);
  const made = registry.create(state, {
    source: `session:${sessionId}`, eventId, title: `任务 ${eventId}`, threadKey: sessionId,
  });
  state = made.state;
  for (const to of ['queued', 'running', 'succeeded']) {
    registry.transition(state, made.task.taskId, to);
  }
  state.tasks[made.task.taskId].deliveredOnly = true;
  state.tasks[made.task.taskId].updatedAt = now - ageMs;
  registry.save(state, dir);
  return { state, taskId: made.task.taskId };
}

const NOW = 1_800_000_000_000;

test('同会话近期投递的任务：拿到 turn/end 的真实结果', () => {
  const dir = tmp();
  const { state, taskId } = seed(dir, { now: NOW });
  const count = reconcileDelivered(state, { sessionId: 'S1', reasonKind: 'error', now: NOW });
  assert.equal(count, 1);
  assert.equal(state.tasks[taskId].turnOutcome, 'error');
  assert.equal(state.tasks[taskId].status, 'succeeded',
    '状态不能改——succeeded 是终态，而且「投递成功」本身也是事实');
});

test('别的会话不会被误配', () => {
  const dir = tmp();
  const { state } = seed(dir, { sessionId: 'S1', now: NOW });
  const count = reconcileDelivered(state, { sessionId: 'S2', reasonKind: 'error', now: NOW });
  assert.equal(count, 0, '会话都对不上就不该动');
  assert.equal(Object.values(state.tasks)[0].turnOutcome, undefined);
});

test('太久之前的投递不配（可能不是这一轮）', () => {
  const dir = tmp();
  const { state } = seed(dir, { now: NOW, ageMs: 60 * 60_000 });   // 一小时前
  const count = reconcileDelivered(state, { sessionId: 'S1', reasonKind: 'error', now: NOW });
  assert.equal(count, 0, '超出时间窗就不该认成这一轮');
});

test('已经配过结果的不再重复配', () => {
  const dir = tmp();
  const { state, taskId } = seed(dir, { now: NOW });
  reconcileDelivered(state, { sessionId: 'S1', reasonKind: 'completed', now: NOW });
  const again = reconcileDelivered(state, { sessionId: 'S1', reasonKind: 'error', now: NOW });
  assert.equal(again, 0, '重复的 turn/end 不该覆盖已有结果');
  assert.equal(state.tasks[taskId].turnOutcome, 'completed');
});

test('没标记 deliveredOnly 的任务不被碰（那是普通轮次任务）', () => {
  const dir = tmp();
  let state = registry.load(dir);
  const made = registry.create(state, {
    source: 'session:S1', eventId: 'plain', title: '普通轮次', threadKey: 'S1',
  });
  state = made.state;
  for (const to of ['queued', 'running', 'succeeded']) {
    registry.transition(state, made.task.taskId, to);
  }
  state.tasks[made.task.taskId].updatedAt = NOW;
  const count = reconcileDelivered(state, { sessionId: 'S1', reasonKind: 'error', now: NOW });
  assert.equal(count, 0);
});
