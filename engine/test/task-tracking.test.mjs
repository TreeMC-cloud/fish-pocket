// task-tracking.test.mjs —— 任务记账的契约
//
// 这个模块是 Task Registry 的唯一运行时调用者。它坏掉的表现很隐蔽：
// 任务表一直是空的，能力地图显示"还没开始干活"，而**不报任何错**。
// 所以每条规则都要有正反两侧的断言。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as track from '../runtime/task-tracking.mjs';
import { load } from '../runtime/task-registry.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'));

test('一轮完整的对话：建任务 → 推进 → 成功收尾', () => {
  const d = tmp();
  const { taskId, created } = track.onTurnStart(d, { sessionId: 'S1', turn: 1, title: '做网页' });
  assert.ok(taskId, '应该建出任务');
  assert.equal(created, true);

  const state = load(d);
  assert.equal(state.tasks[taskId].status, 'running', 'turn/start 后应在 running');

  const end = track.onTurnEnd(d, { sessionId: 'S1', turn: 1, reasonKind: 'completed' });
  assert.equal(end.status, 'succeeded');
  assert.equal(load(d).tasks[taskId].status, 'succeeded');
});

test('幂等：同一 turn 重复 start 不会建出两个任务', () => {
  const d = tmp();
  const a = track.onTurnStart(d, { sessionId: 'S1', turn: 1, title: 'x' });
  const b = track.onTurnStart(d, { sessionId: 'S1', turn: 1, title: 'x' });
  assert.equal(a.taskId, b.taskId);
  assert.equal(b.created, false);
  assert.equal(Object.keys(load(d).tasks).length, 1, '任务表里只能有一条');
});

test('重复 turn/end 不会二次转移（同一轮只收尾一次）', () => {
  const d = tmp();
  track.onTurnStart(d, { sessionId: 'S1', turn: 1, title: 'x' });
  const first = track.onTurnEnd(d, { sessionId: 'S1', turn: 1, reasonKind: 'completed' });
  const second = track.onTurnEnd(d, { sessionId: 'S1', turn: 1, reasonKind: 'error' });
  assert.equal(first.status, 'succeeded');
  assert.equal(second, null, '已经收尾过的任务不该再动');
  assert.equal(load(d).tasks[first.taskId].status, 'succeeded', '状态不能被第二次覆盖');
});

test('失败原因落到 failed，中断落到 interrupted', () => {
  const d = tmp();
  track.onTurnStart(d, { sessionId: 'S1', turn: 1, title: 'a' });
  const failed = track.onTurnEnd(d, { sessionId: 'S1', turn: 1, reasonKind: 'error', error: 'boom' });
  assert.equal(failed.status, 'failed');

  track.onTurnStart(d, { sessionId: 'S1', turn: 2, title: 'b' });
  const aborted = track.onTurnEnd(d, { sessionId: 'S1', turn: 2, reasonKind: 'aborted' });
  assert.equal(aborted.status, 'interrupted');
});

test('未知 reason 不动状态（不认识就别瞎记）', () => {
  const d = tmp();
  track.onTurnStart(d, { sessionId: 'S1', turn: 1, title: 'x' });
  const r = track.onTurnEnd(d, { sessionId: 'S1', turn: 1, reasonKind: 'something-new' });
  assert.equal(r, null);
  assert.equal(load(d).tasks[Object.keys(load(d).tasks)[0]].status, 'running',
    '不认识的 reason 应保持 running，交给租约过期去发现');
});

test('max-tokens 算成功（工作完成了，只是输出到上限）', () => {
  const d = tmp();
  track.onTurnStart(d, { sessionId: 'S1', turn: 1, title: 'x' });
  const r = track.onTurnEnd(d, { sessionId: 'S1', turn: 1, reasonKind: 'max-tokens' });
  assert.equal(r.status, 'succeeded');
});

test('无效输入不抛异常（记账是副产物，不能拖垮对话）', () => {
  const d = tmp();
  assert.doesNotThrow(() => track.onTurnStart(d, {}));
  assert.doesNotThrow(() => track.onTurnEnd(d, {}));
  assert.doesNotThrow(() => track.onTurnStart(d, { sessionId: 'S1', turn: 'not-a-number' }));
});

test('summarize 与落盘一致', () => {
  const d = tmp();
  track.onTurnStart(d, { sessionId: 'S1', turn: 1, title: 'a' });
  track.onTurnEnd(d, { sessionId: 'S1', turn: 1, reasonKind: 'completed' });
  track.onTurnStart(d, { sessionId: 'S1', turn: 2, title: 'b' });
  track.onTurnEnd(d, { sessionId: 'S1', turn: 2, reasonKind: 'error' });

  const s = track.summarize(d);
  assert.equal(s.ok, true);
  assert.equal(s.total, 2);
  assert.equal(s.byStatus.succeeded, 1);
  assert.equal(s.byStatus.failed, 1);
});

test('空目录的 summarize 如实说"还没有记录"，不说"一切正常"', () => {
  const s = track.summarize(tmp());
  assert.equal(s.ok, false);
  assert.equal(s.total, 0);
  assert.match(s.reason, /还没有任务记录/);
});
