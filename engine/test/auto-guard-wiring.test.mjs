import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wire-'));

async function boot(dataDir) {
  process.env.DSH_IOS_DATA = dataDir;
  const { default: AutoGuard } = await import(`../plugins/auto-guard/index.mjs?t=${Date.now()}`);
  const hooks = {};
  const notes = [];
  const g = new AutoGuard({
    effect: (f) => f(),
    on: (n, f) => { hooks[n] = f; return () => {}; },
    logger: { warn: () => {}, info: () => {} },
  }, {});
  g.notify = (m, d) => notes.push({ m, d });
  return { g, hooks, notes };
}

// ── 场景解析接线 ─────────────────────────────────────

test('有 .scene.json 时解析出场景', async () => {
  const d = tmp();
  const proj = path.join(d, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, '.scene.json'), JSON.stringify({ sceneId: 'alpha', name: '项目A' }));

  const { g, notes } = await boot(d);
  g.onTurnStart({ header: { id: 's1', origin: 'user', cwd: proj }, ownEvents: () => [] });
  assert.equal(g.scene.status, 'resolved');
  assert.equal(notes.length, 0, '有场景不该报警');
});

test('没有场景时提醒一次，且不重复', async () => {
  const d = tmp();
  const empty = path.join(d, 'empty');
  fs.mkdirSync(empty);
  const { g, notes } = await boot(d);
  const session = { header: { id: 's2', origin: 'user', cwd: empty }, ownEvents: () => [] };

  g.onTurnStart(session);
  assert.equal(g.scene.status, 'ambiguous');
  assert.equal(notes.filter((n) => n.d.kind === 'scene_missing').length, 1);

  g.onTurnStart(session);
  assert.equal(notes.filter((n) => n.d.kind === 'scene_missing').length, 1, '第二轮不该重复提醒');
});

// ── 技能记账接线 ─────────────────────────────────────

test('加载技能时记一次（结果是未知，不算成功）', async () => {
  const d = tmp();
  const { g } = await boot(d);
  const session = { header: { id: 's1', origin: 'user' }, ownEvents: () => [] };
  g.onToolResult(session, { data: { name: 'skill', args: { name: 'cost-guard' }, message: { content: [] } } });

  const { load } = await import('../runtime/skill-stats.mjs');
  const entry = load(d).skills['cost-guard'];
  assert.equal(entry.uses, 1);
  assert.equal(entry.unknown, 1, '加载成功不等于解决问题，必须记未知');
  assert.equal(entry.failures, 0);
});

// ── 产物校验接线 ─────────────────────────────────────

test('写文件的工具报告成功后，0 字节文件要报警', async () => {
  const d = tmp();
  const target = path.join(d, 'out.txt');
  fs.writeFileSync(target, '');
  const { g, notes } = await boot(d);
  const session = { header: { id: 's1', origin: 'user', cwd: d }, ownEvents: () => [] };

  g.onToolResult(session, {
    data: { name: 'write', args: { file_path: target }, message: { content: [{ type: 'text', text: '已写入' }] } },
  });
  assert.ok(notes.some((n) => n.d.kind === 'gate_failed'), '0 字节必须报');
});

test('文件不存在要报警', async () => {
  const d = tmp();
  const { g, notes } = await boot(d);
  const session = { header: { id: 's1', origin: 'user', cwd: d }, ownEvents: () => [] };
  g.onToolResult(session, {
    data: { name: 'write', args: { file_path: path.join(d, 'nope.txt') }, message: { content: [] } },
  });
  assert.ok(notes.some((n) => n.d.kind === 'gate_failed'));
});

test('正常文件不误报，读工具不检查', async () => {
  const d = tmp();
  const target = path.join(d, 'ok.txt');
  fs.writeFileSync(target, 'content');
  const { g, notes } = await boot(d);
  const session = { header: { id: 's1', origin: 'user', cwd: d }, ownEvents: () => [] };

  g.onToolResult(session, { data: { name: 'write', args: { file_path: target }, message: { content: [] } } });
  g.onToolResult(session, { data: { name: 'read', args: { file_path: path.join(d, 'x.txt') }, message: { content: [] } } });
  assert.equal(notes.length, 0);
});

// ── 编辑预检接线 ─────────────────────────────────────

test('会改出语法错的编辑被拦住，文件不动', async () => {
  const d = tmp();
  const f = path.join(d, 'a.mjs');
  fs.writeFileSync(f, 'const a = 1;\n');
  const { hooks } = await boot(d);

  const verdict = hooks['tools/pre-execute'](
    { name: 'edit', args: { file_path: f, old_str: 'const a = 1;', new_str: 'const a = ;' } },
    () => 'PASS',
  );
  assert.notEqual(verdict, 'PASS', '必须拦住');
  assert.match(String(verdict), /语法出错/);
  assert.equal(fs.readFileSync(f, 'utf8'), 'const a = 1;\n');
});

test('正常编辑放行', async () => {
  const d = tmp();
  const f = path.join(d, 'b.mjs');
  fs.writeFileSync(f, 'const b = 1;\n');
  const { hooks } = await boot(d);
  const verdict = hooks['tools/pre-execute'](
    { name: 'edit', args: { file_path: f, old_str: 'const b = 1;', new_str: 'const b = 2;' } },
    () => 'PASS',
  );
  assert.equal(verdict, 'PASS');
});

test('write 不走预检（没有 old_str 可比）', async () => {
  const d = tmp();
  const { hooks } = await boot(d);
  const verdict = hooks['tools/pre-execute'](
    { name: 'write', args: { file_path: path.join(d, 'c.mjs'), content: 'x' } },
    () => 'PASS',
  );
  assert.equal(verdict, 'PASS');
});

test('非 JS 文件的编辑直接放行（不假装能检查语法）', async () => {
  const d = tmp();
  const f = path.join(d, 'note.md');
  fs.writeFileSync(f, '# 标题\n正文\n');
  const { hooks } = await boot(d);
  const verdict = hooks['tools/pre-execute'](
    { name: 'edit', args: { file_path: f, old_str: '正文', new_str: '新正文' } },
    () => 'PASS',
  );
  assert.equal(verdict, 'PASS');
});
