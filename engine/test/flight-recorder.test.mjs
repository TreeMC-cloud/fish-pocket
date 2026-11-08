import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readInFlight, writeInFlight, interruptedSince, reportInterrupted, STALE_MS,
} from '../runtime/flight-recorder.mjs';
import { load as loadRegistry, pendingOutbox } from '../runtime/task-registry.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flight-'));

test('缺文件或坏文件时返回空，不抛', () => {
  const dir = tmp();
  assert.deepEqual(readInFlight(dir), []);
  fs.writeFileSync(path.join(dir, 'in-flight.json'), '{ not json');
  assert.deepEqual(readInFlight(dir), []);
  fs.writeFileSync(path.join(dir, 'in-flight.json'), '{"running":"nope"}');
  assert.deepEqual(readInFlight(dir), []);
});

test('覆盖写只保留当前集合，不是追加', () => {
  const dir = tmp();
  writeInFlight(dir, { a: 1000, b: 2000 });
  assert.equal(readInFlight(dir).length, 2);
  writeInFlight(dir, { c: 3000 });
  const left = readInFlight(dir);
  assert.equal(left.length, 1);
  assert.equal(left[0].session, 'c');
});

test('过期的和未来时间戳都不算中断', () => {
  const now = 10 * STALE_MS;
  const dir = tmp();
  writeInFlight(dir, { old: now - STALE_MS - 1, future: now + 5000, live: now - 1000 });
  assert.deepEqual(interruptedSince(dir, now).map((x) => x.session), ['live']);
});

test('报告一次后清空，第二次启动不再提示', () => {
  const now = Date.now();
  const dir = tmp();
  writeInFlight(dir, { s1: now - 5000, s2: now - 3000 });
  const lines = [];
  const first = reportInterrupted(dir, { now, write: (l) => lines.push(l) });
  assert.equal(first.length, 2);
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.kind, 'interrupted');
  assert.deepEqual(record.sessions, ['s2', 's1']);  // newest first
  assert.match(record.message, /2 个任务/);

  assert.deepEqual(reportInterrupted(dir, { now, write: (l) => lines.push(l) }), []);
  assert.equal(lines.length, 1);
});

test('写完通知失败时必须保留记录，不能丢掉唯一证据', () => {
  const dir = tmp();
  writeInFlight(dir, { s1: Date.now() - 1000 });
  reportInterrupted(dir, { write: () => { throw new Error('disk full'); } });

  // 旧实现这里会清空——注释写「否则每次启动都提示」，代价是中断证据永久消失。
  // 现在的语义：写不进去就留着，下次启动再试。重复提醒远好于静默丢失。
  const left = readInFlight(dir);
  assert.equal(left.length, 1, '写失败后 in-flight 必须保留');
  assert.equal(left[0].session, 's1');
});

test('写成功后清空，且转成 outbox 待投递事件', () => {
  const dir = tmp();
  writeInFlight(dir, { s1: { at: Date.now() - 1000, step: '正在运行命令（npm test）' } });
  reportInterrupted(dir);

  assert.deepEqual(readInFlight(dir), [], '写成功后应清空 in-flight');
  const state = loadRegistry(dir);
  const pending = pendingOutbox(state);
  assert.equal(pending.length, 1, '中断事件应进 outbox 等投递');
  assert.equal(pending[0].kind, 'interrupted');
  assert.equal(pending[0].detail.steps.s1, '正在运行命令（npm test）');
});

test('单个任务时文案是单数', () => {
  const dir = tmp();
  writeInFlight(dir, { only: Date.now() - 1000 });
  const lines = [];
  reportInterrupted(dir, { write: (l) => lines.push(l) });
  // 单数不点名数量（标题已经说了「任务没跑完」），只说后果与下一步。
  assert.equal(JSON.parse(lines[0]).message,
    '被引擎重启中断。先看看已经改了什么，再决定要不要重新发一次。');
});

test('多个任务时点名数量', () => {
  const dir = tmp();
  const now = Date.now();
  writeInFlight(dir, { a: { at: now - 2000, step: '' }, b: { at: now - 1000, step: '' } });
  const lines = [];
  reportInterrupted(dir, { now, write: (l) => lines.push(l) });
  assert.match(JSON.parse(lines[0]).message, /2 个任务/);
});

test('旧格式（值是时间戳）仍然能读，只是没有步骤', () => {
  const dir = tmp();
  const now = Date.now();
  // 模拟升级前写下的文件：{"running":{"s1":1794...}}
  fs.writeFileSync(path.join(dir, 'in-flight.json'), JSON.stringify({ running: { s1: now - 5000 } }));
  const read = readInFlight(dir);
  assert.equal(read.length, 1);
  assert.equal(read[0].session, 's1');
  assert.equal(read[0].step, '');

  const lines = [];
  reportInterrupted(dir, { now, write: (l) => lines.push(l) });
  const record = JSON.parse(lines[0]);
  assert.deepEqual(record.sessions, ['s1']);
  assert.equal(record.steps.s1, '');
  assert.doesNotMatch(record.message, /停在/, '没有步骤时不该编出一个');
});

test('新格式带着步骤，提示里说得出来', () => {
  const dir = tmp();
  const now = Date.now();
  writeInFlight(dir, { s9: { at: now - 2000, step: '正在运行命令（npm run build）' } });
  const lines = [];
  reportInterrupted(dir, { now, write: (l) => lines.push(l) });
  const record = JSON.parse(lines[0]);
  assert.equal(record.steps.s9, '正在运行命令（npm run build）');
  assert.match(record.message, /停在「正在运行命令（npm run build）」/);
});
