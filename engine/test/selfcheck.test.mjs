// selfcheck.test.mjs —— 引擎自检的验收
//
// 这份测试钉的是三件事：
//   1. 空目录不能把体检工具自己搞崩（它存在的意义就是在这种情况下仍能说话）
//   2. 数据齐了要判「就绪」，不能因为判据太严永远报红
//   3. 「陈旧」和「不存在」必须分开报——修法完全不同
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSelfCheck, writeSelfCheck, CAPABILITY_STALE_MS } from '../runtime/selfcheck.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-'));

const byId = (result, id) => result.items.find((i) => i.id === id);

/** 造一份「各闭环都接上了」的数据目录。 */
function seedFull(dir, { generatedAt = Date.now() } = {}) {
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({
    schemaVersion: 1,
    seq: 2,
    tasks: {
      't-1': { taskId: 't-1', status: 'succeeded', title: '跑通一次' },
      't-2': { taskId: 't-2', status: 'queued', title: '排着的' },
    },
    idempotency: {},
    outbox: [],
  }));
  fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify({
    version: 1, generatedAt, headline: '记录 3 轮',
  }));
  fs.writeFileSync(path.join(dir, 'schedule-view.json'), JSON.stringify({
    total: 1, rows: [{ title: '每天早上', status: 'active', due: false }],
  }));
  fs.writeFileSync(path.join(dir, '.trace.jsonl'), [
    JSON.stringify({ at: Date.now(), ok: true, tags: ['demo'] }),
    JSON.stringify({ at: Date.now(), ok: false, tags: ['demo'] }),
    JSON.stringify({ at: Date.now(), ok: true, tags: [] }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, '.turns.jsonl'), [
    JSON.stringify({ at: Date.now(), turn: 1 }),
    JSON.stringify({ at: Date.now(), turn: 2 }),
  ].join('\n') + '\n');
}

test('空目录：多项未就绪，但不抛异常', async () => {
  const dir = tmp();
  const result = await runSelfCheck(dir);

  assert.equal(result.ok, false, '空目录不可能全绿');
  assert.equal(result.items.length, 7, '七项都要在，缺项等于体检漏项');
  assert.equal(result.summary.total, 7);
  assert.equal(result.summary.passed + result.summary.failed, 7);

  // prompts 依赖仓库里真的装了 meow-memory，不参与「空目录」断言。
  const dataItems = result.items.filter((i) => i.id !== 'prompts');
  const failed = dataItems.filter((i) => !i.ok).length;
  assert.ok(failed >= 5, `空目录至少 5 项未就绪，实际 ${failed}`);
  for (const id of ['tasks', 'capability', 'schedule', 'trace', 'turns']) {
    assert.equal(byId(result, id).ok, false, `${id} 应为未就绪`);
  }
  // 目录存在 → 可写性应当为真，这一项不该被别项的失败带偏。
  assert.equal(byId(result, 'writable').ok, true);

  for (const item of result.items) {
    assert.equal(typeof item.detail, 'string');
    assert.ok(item.detail.length > 0, `${item.id} 必须给一句说明，空说明等于没查`);
  }
});

test('数据齐全：大部分项 ok', async () => {
  const dir = tmp();
  seedFull(dir);
  const result = await runSelfCheck(dir);

  for (const id of ['tasks', 'capability', 'schedule', 'trace', 'turns', 'writable']) {
    assert.equal(byId(result, id).ok, true, `${id} 应就绪：${byId(result, id).detail}`);
  }
  assert.equal(byId(result, 'tasks').detail.includes('2'), true, '任务数要报出来');
  assert.equal(result.summary.passed >= 6, true, `至少 6 项就绪，实际 ${result.summary.passed}`);
  assert.match(byId(result, 'trace').detail, /3/);
  assert.match(byId(result, 'turns').detail, /2/);
});

test('capability 一小时前：判陈旧而不是不存在', async () => {
  const dir = tmp();
  seedFull(dir, { generatedAt: Date.now() - 60 * 60 * 1000 });
  const result = await runSelfCheck(dir);

  const cap = byId(result, 'capability');
  assert.equal(cap.ok, false, '超过 10 分钟必须判失败');
  assert.match(cap.detail, /陈旧/, 'detail 必须写「陈旧」——修法完全不同');
  assert.equal(/不存在/.test(cap.detail), false, '不能把「过期」说成「不存在」');
  assert.equal(result.ok, false);

  // 边界：刚好没超阈值时应当仍然是新鲜的。
  const fresh = await runSelfCheck(dir, { now: Date.now() - 60 * 60 * 1000 + CAPABILITY_STALE_MS - 1000 });
  assert.equal(byId(fresh, 'capability').ok, true, '未超阈值不该误报');
});

test('0 行账本：ok 但写明「还没记录」', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.trace.jsonl'), '');
  fs.writeFileSync(path.join(dir, '.turns.jsonl'), '\n\n');
  const result = await runSelfCheck(dir);

  assert.equal(byId(result, 'trace').ok, true, '空账本是合法初始状态');
  assert.equal(byId(result, 'turns').ok, true);
  assert.match(byId(result, 'trace').detail, /还没记录/);
  assert.match(byId(result, 'turns').detail, /还没记录/);
});

test('坏文件只影响自己那一项', async () => {
  const dir = tmp();
  seedFull(dir);
  fs.writeFileSync(path.join(dir, 'tasks.json'), '{ 半个 json');
  const result = await runSelfCheck(dir);

  const tasks = byId(result, 'tasks');
  assert.equal(tasks.ok, false);
  assert.match(tasks.detail, /无法解析/);
  // 其它项必须照常给出结论，不能被一个坏文件带崩。
  assert.equal(byId(result, 'capability').ok, true);
  assert.equal(byId(result, 'schedule').ok, true);
  assert.equal(result.items.length, 7);
});

test('writeSelfCheck 落盘 selfcheck.json，且可被读回', async () => {
  const dir = tmp();
  seedFull(dir);
  const written = await writeSelfCheck(dir);

  assert.equal(written.file, path.join(dir, 'selfcheck.json'));
  const back = JSON.parse(fs.readFileSync(path.join(dir, 'selfcheck.json'), 'utf8'));
  assert.equal(back.items.length, 7);
  assert.equal(back.ok, written.ok);
  assert.equal(back.summary.total, 7);
  // 临时文件不能留在数据目录里（App 会扫这个目录）。
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('writeSelfCheck 目录不存在时先建目录，报告不自相矛盾', async () => {
  const dir = path.join(tmp(), 'nested', 'data');
  const written = await writeSelfCheck(dir);

  assert.equal(written.file, path.join(dir, 'selfcheck.json'));
  // 报告写出来了，就不能同时说「目录不可写」。
  assert.equal(written.items.find((i) => i.id === 'writable').ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'selfcheck.json')), true);
});
