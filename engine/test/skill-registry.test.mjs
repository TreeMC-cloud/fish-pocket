import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { record, report, load } from '../runtime/skill-stats.mjs';
import { validateMeta, resolveDependencies, healthVerdict, auditSkills, PERMISSION, SOURCE } from '../runtime/skill-registry.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stats-'));

// ── skill-stats ──────────────────────────────────────────

test('记一次使用后计数递增', () => {
  const d = tmp();
  record('cost-guard', true, { dataDir: d });
  record('cost-guard', false, { dataDir: d });
  const s = load(d).skills['cost-guard'];
  assert.equal(s.uses, 2);
  assert.equal(s.failures, 1);
});

test('数据不足时不判降级（避免样本太小误杀）', () => {
  const d = tmp();
  for (let i = 0; i < 3; i += 1) record('x', false, { dataDir: d });
  const r = report({ dataDir: d });
  assert.equal(r.rows[0].verdict, 'insufficient-data');
  assert.equal(r.needsAttention.length, 0);
});

test('失败率超阈判定降级', () => {
  const d = tmp();
  for (let i = 0; i < 6; i += 1) record('evolve', i >= 4, { dataDir: d });  // 2 成功 4 失败
  const r = report({ dataDir: d });
  assert.equal(r.rows[0].verdict, 'degrade');
  assert.equal(r.needsAttention.length, 1);
});

test('健康技能不误报', () => {
  const d = tmp();
  for (let i = 0; i < 10; i += 1) record('ok-skill', i !== 0, { dataDir: d });  // 9 成功 1 失败
  assert.equal(report({ dataDir: d }).needsAttention.length, 0);
});

test('空技能名不记账', () => {
  const d = tmp();
  assert.equal(record('', true, { dataDir: d }), null);
  assert.equal(record(null, true, { dataDir: d }), null);
  assert.equal(Object.keys(load(d).skills).length, 0);
});

test('文件坏了不崩，按空处理', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, '.skill-stats.json'), '{broken');
  assert.deepEqual(load(d).skills, {});
  record('x', true, { dataDir: d });   // 还能正常写
  assert.equal(load(d).skills.x.uses, 1);
});

// ── skill-registry ───────────────────────────────────────

test('完整元数据通过校验', () => {
  const v = validateMeta({
    name: 'x', description: 'd', version: '1.0.0',
    source: SOURCE.HANDWRITTEN, permissions: [PERMISSION.READ_ONLY],
  });
  assert.equal(v.ok, true);
  assert.equal(v.errors.length, 0);
});

test('缺 name/description 是错误', () => {
  assert.equal(validateMeta({}).ok, false);
  assert.equal(validateMeta({ name: 'a' }).ok, false);
});

test('缺 version 只警告（存量技能不能因此全废）', () => {
  const v = validateMeta({ name: 'a', description: 'd' });
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => w.includes('version')));
});

test('evolved 技能必须带溯源，否则拒绝', () => {
  const bad = validateMeta({
    name: 'a', description: 'd', version: '1.0.0', source: SOURCE.EVOLVED,
  });
  assert.equal(bad.ok, false, '来路不明的自动技能不能启用');
  assert.ok(bad.errors.some((e) => e.includes('origin')));

  const good = validateMeta({
    name: 'a', description: 'd', version: '1.0.0', source: SOURCE.EVOLVED,
    origin: { fingerprint: 'fp12345678' },
  });
  assert.equal(good.ok, true);
});

test('未知权限被拒绝', () => {
  const v = validateMeta({ name: 'a', description: 'd', permissions: ['root'] });
  assert.equal(v.ok, false);
});

test('依赖缺失要报出来', () => {
  const r = resolveDependencies(
    { dependsOn: ['tool:bash', 'skill:handoff', 'tool:missing'] },
    { availableTools: ['bash'], availableSkills: ['handoff'] },
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['工具 missing']);
});

test('healthVerdict 边界：刚好等于阈值算降级', () => {
  assert.equal(healthVerdict({ uses: 5, failures: 2 }, { minUses: 5, failRatio: 0.4 }).verdict, 'degrade');
  assert.equal(healthVerdict({ uses: 5, failures: 1 }, { minUses: 5, failRatio: 0.4 }).verdict, 'ok');
});

test('auditSkills 能扫真实技能目录且全部合规', () => {
  const r = auditSkills(new URL('../skills', import.meta.url).pathname);
  assert.ok(r.skills.length >= 18, `应至少 18 个技能，实际 ${r.skills.length}`);
  const bad = r.skills.filter((s) => !s.ok);
  assert.deepEqual(bad.map((s) => s.name), [], '所有技能元数据都应合规');
});
