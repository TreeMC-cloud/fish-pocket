import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gate, checkArtifact } from '../runtime/delivery-gate.mjs';
import { Router } from '../runtime/router.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));

function fixture(files = {}) {
  const dir = tmp();
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('合格文件通过', () => {
  const dir = fixture({ 'ok.json': '{"a":1}' });
  assert.equal(checkArtifact({ path: path.join(dir, 'ok.json') }).ok, true);
});

test('0 字节是假成功，必须拦', () => {
  const dir = fixture({ 'empty.txt': '' });
  const r = checkArtifact({ path: path.join(dir, 'empty.txt') });
  assert.equal(r.ok, false);
  assert.match(r.reason, /0 字节/);
});

test('截断的 JSON 不是合格产物', () => {
  const dir = fixture({ 'bad.json': '{broken' });
  const r = checkArtifact({ path: path.join(dir, 'bad.json') });
  assert.equal(r.ok, false);
  assert.match(r.reason, /合法 JSON/);
});

test('不存在的产物要报不存在，不要说别的', () => {
  const r = checkArtifact({ path: '/tmp/definitely-not-here-xyz/a.bin' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /不存在/);
});

test('空目录不算交付', () => {
  const dir = fixture({ 'out/.keep': '' });
  fs.rmSync(path.join(dir, 'out/.keep'));
  const r = checkArtifact({ path: path.join(dir, 'out') });
  assert.equal(r.ok, false);
  assert.match(r.reason, /空的/);
});

test('非空目录算交付', () => {
  const dir = fixture({ 'out/a.txt': 'x' });
  assert.equal(checkArtifact({ path: path.join(dir, 'out') }).ok, true);
});

test('内存产物空内容要拦', () => {
  assert.equal(checkArtifact({ content: '   ', name: 'x' }).ok, false);
  assert.equal(checkArtifact({ content: 'hello' }).ok, true);
});

test('产物描述缺 path 和 content 要拦', () => {
  assert.equal(checkArtifact({}).ok, false);
  assert.equal(checkArtifact(null).ok, false);
});

test('gate：任务要求产物但没交 → 不通过', () => {
  const v = gate({ expect: { artifacts: true } }, { ok: true, artifacts: [] });
  assert.equal(v.pass, false);
  assert.match(v.blockers[0], /一个都没有/);
});

test('gate：requireArtifacts 全局开关也生效', () => {
  const v = gate({}, { ok: true, artifacts: [] }, { requireArtifacts: true });
  assert.equal(v.pass, false);
});

test('gate：全部产物合格才通过，软判据只记不拦', () => {
  const dir = fixture({ 'a.txt': 'x' });
  const v = gate(
    { expect: { minArtifacts: 3 } },
    { ok: true, artifacts: [{ path: path.join(dir, 'a.txt') }] },
  );
  assert.equal(v.pass, true, '软判据不该拦');
  assert.ok(v.notes.some((n) => n.includes('产物数量')), '软判据要记录');
});

test('gate：执行失败不通过', () => {
  const v = gate({}, { ok: false, error: 'boom' });
  assert.equal(v.pass, false);
  assert.match(v.blockers[0], /boom/);
});

test('Router：gate 不过 → needs_reconciliation，且发通知', async () => {
  const dir = tmp();
  const r = new Router({ dataDir: dir, runTask: async () => ({ ok: true, artifacts: [] }) });
  r.accept({ source: 'user', eventId: 'g1', title: '要求产物的任务' });
  const state = r.state();
  state.tasks[Object.keys(state.tasks)[0]].expect = { artifacts: true };
  const { save } = await import('../runtime/task-registry.mjs');
  save(state, dir);

  await r.execute();
  await new Promise((s) => setTimeout(s, 150));

  const task = Object.values(r.state().tasks)[0];
  assert.equal(task.status, 'needs_reconciliation', 'gate 不过不能记成功');
  assert.match(task.lastError, /交付校验未通过/);
  assert.ok(r.pending().some((e) => e.kind === 'gate_failed'), '要有 gate_failed 通知');
});
