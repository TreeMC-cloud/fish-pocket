import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readInFlight, writeInFlight, interruptedSince, reportInterrupted, STALE_MS,
} from '../runtime/flight-recorder.mjs';

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

test('写完通知失败也要清空记录，避免每次启动重复提示', () => {
  const dir = tmp();
  writeInFlight(dir, { s1: Date.now() - 1000 });
  reportInterrupted(dir, { write: () => { throw new Error('disk full'); } });
  assert.deepEqual(readInFlight(dir), []);
});

test('单个任务时文案是单数', () => {
  const dir = tmp();
  writeInFlight(dir, { only: Date.now() - 1000 });
  const lines = [];
  reportInterrupted(dir, { write: (l) => lines.push(l) });
  assert.match(JSON.parse(lines[0]).message, /一个任务/);
});
