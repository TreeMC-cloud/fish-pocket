import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validate, readScene, resolveScene, isRunnable, describe, scaffold, sceneFile, SCHEMA_VERSION,
} from '../runtime/scene-schema.mjs';

/**
 * 场景是「执行发生在哪」的唯一事实源。解析错了，所有后续动作都发生在
 * 错的项目里——而且不报错。这里钉住：
 *   1. schema 校验（必填 / 类型 / 默认值）
 *   2. 解析优先级（会话绑定 > 工作区文件 > 全局默认 > 停下问）
 *   3. ambiguous 不是失败，是「必须问用户」的明确结果
 */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scene-'));

test('完整场景通过校验并补默认值', () => {
  const { ok, scene, problems } = validate({ sceneId: 'alpha', name: '项目A', projectId: 'a1' });
  assert.equal(ok, true);
  assert.deepEqual(problems, []);
  assert.equal(scene.identityId, 'fenjue', 'identityId 有默认值');
  assert.equal(scene.memoryNamespace, 'project:a1', 'namespace 从 projectId 派生');
  assert.equal(scene.toolProfile, 'default');
  assert.equal(scene.version, SCHEMA_VERSION);
});

test('缺 sceneId 是明确失败，不是默认通过', () => {
  const { ok, problems } = validate({ name: '没有 id' });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('sceneId')));
});

test('字段类型错不抛、只报告', () => {
  const { ok, problems, scene } = validate({ sceneId: 'a', version: '不是数字', projectId: 42 });
  assert.equal(ok, false);
  assert.ok(problems.length >= 2);
  assert.equal(scene.sceneId, 'a', '合法字段仍被保留');
});

test('未知字段保留（用户手写的备注不能被吞）', () => {
  const { scene } = validate({ sceneId: 'a', myNote: '别动这行' });
  assert.equal(scene.myNote, '别动这行');
});

test('坏 JSON 与缺失文件的区分', () => {
  const dir = tmp();
  const missing = readScene(dir);
  assert.equal(missing.missing, true);

  fs.writeFileSync(sceneFile(dir), '{ 半个');
  const broken = readScene(dir);
  assert.equal(broken.ok, false);
  assert.match(broken.problems[0], /JSON/);
});

test('解析优先级：会话绑定 > 工作区文件', () => {
  const dir = tmp();
  fs.writeFileSync(sceneFile(dir), JSON.stringify({ sceneId: 'ws-scene', projectId: 'w' }));
  const bound = resolveScene({ session: { sceneId: 'ws-scene' }, workspaceRoot: dir });
  assert.equal(bound.status, 'resolved');
  assert.equal(bound.source, 'session-binding');
});

test('绑定与文件不符是 mismatch，不是静默用其中一个', () => {
  const dir = tmp();
  fs.writeFileSync(sceneFile(dir), JSON.stringify({ sceneId: 'real', projectId: 'r' }));
  const result = resolveScene({ session: { sceneId: 'bound' }, workspaceRoot: dir });
  assert.equal(result.status, 'mismatch');
  assert.equal(isRunnable(result), false, '配置冲突时不能继续执行');
});

test('没有绑定但有工作区文件：从文件解析', () => {
  const dir = tmp();
  fs.writeFileSync(sceneFile(dir), JSON.stringify({ sceneId: 'ws', projectId: 'w' }));
  const result = resolveScene({ session: {}, workspaceRoot: dir });
  assert.equal(result.status, 'resolved');
  assert.equal(result.source, 'workspace-file');
});

test('全都没有 → ambiguous，必须停下问', () => {
  const dir = tmp();
  const result = resolveScene({ session: {}, workspaceRoot: dir });
  assert.equal(result.status, 'ambiguous');
  assert.equal(isRunnable(result), false);
  assert.match(describe(result), /未配置/);
});

test('有全局默认时兜底解析', () => {
  const dir = tmp();
  const def = tmp();
  fs.writeFileSync(sceneFile(def), JSON.stringify({ sceneId: 'default', projectId: 'd' }));
  const result = resolveScene({ session: {}, workspaceRoot: dir, defaultRoot: def });
  assert.equal(result.status, 'resolved');
  assert.equal(result.source, 'default');
  assert.equal(result.scene.sceneId, 'default');
});

test('scaffold 生成的内容能被 validate 接受', () => {
  const draft = scaffold({ sceneId: 'new-proj', projectId: 'np' });
  const { ok, problems } = validate(draft);
  assert.equal(ok, true, problems.join(';'));
});
