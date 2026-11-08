import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getDb, memoryDbPath, closeAllDbs,
} from 'meow-memory';

/**
 * 记忆闭环集成测试（MEMORY-001）。
 *
 * 文档明确要求「不能只看 ios.patch.yml」：插件写在配置里不等于
 * 工具真的注册、DB 真的能建、写进去的下个会话真的读得回来。
 * 这里直接打到 meow-memory 的真实存储层，四件事逐一验证：
 *
 *   1. 能建库、能写
 *   2. 能按 id / 列表读回
 *   3. 关库重开后仍在（跨会话持久）
 *   4. 项目之间隔离（A 项目的事实不能出现在 B 项目的查询里）
 */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'memory-'));
const cleanup = () => { try { closeAllDbs(); } catch { /* 已关 */ } };

test('能建库并写入一条记忆', () => {
  const ws = tmp();
  try {
    const db = getDb(ws, '.dsh-meow');
    const row = db.insert({
      level: 'lesson',
      content: 'iSH 的 free -m 是静态桩，必须读 /proc/meminfo',
      project: 'fish-pocket',
      keywords: ['iSH', '内存'],
      importance: 2,
      source_session: 's1',
    });

    assert.ok(row?.id, 'insert 应返回带 id 的记录');
    assert.equal(db.list('lesson', { status: 'active' }).length, 1);
  } finally { cleanup(); }
});

test('写入的内容能按 id 读回', () => {
  const ws = tmp();
  try {
    const db = getDb(ws, '.dsh-meow');
    const row = db.insert({
      level: 'lesson', content: '构建要用 unsigned-ipa.yml', project: 'p',
      keywords: ['构建'], importance: 1, source_session: 's1',
    });
    const found = db.findById(row.id);
    assert.ok(found, '应能按完整 id 找到');
    assert.match(found.row.content, /unsigned-ipa/);
  } finally { cleanup(); }
});

test('关库重开后记忆还在（跨会话持久）', () => {
  const ws = tmp();
  const file = memoryDbPath(ws, '.dsh-meow');
  try {
    const db = getDb(ws, '.dsh-meow');
    db.insert({
      level: 'fact', content: '项目用 GitHub Actions 出未签名 IPA', project: 'p',
      keywords: ['ipa', '构建'], importance: 1, source_session: 's1',
    });
  } finally { cleanup(); }

  assert.ok(fs.existsSync(file), `库文件应存在：${file}`);

  try {
    const reopened = getDb(ws, '.dsh-meow');
    const rows = reopened.list('fact', { status: 'active' });
    assert.equal(rows.length, 1, '重开后应读到同一条');
    assert.match(rows[0].content, /未签名 IPA/);
  } finally { cleanup(); }
});

test('不同工作区的记忆互相隔离', () => {
  const wsA = tmp();
  const wsB = tmp();
  try {
    const a = getDb(wsA, '.dsh-meow');
    a.insert({ level: 'fact', content: 'A 项目的秘密', project: 'a', keywords: ['a'], importance: 1, source_session: 's' });

    const b = getDb(wsB, '.dsh-meow');
    b.insert({ level: 'fact', content: 'B 项目的事实', project: 'b', keywords: ['b'], importance: 1, source_session: 's' });

    const aRows = a.list('fact', { status: 'active' });
    const bRows = b.list('fact', { status: 'active' });
    assert.equal(aRows.length, 1);
    assert.equal(bRows.length, 1);
    assert.match(aRows[0].content, /A 项目/);
    assert.match(bRows[0].content, /B 项目/);
    assert.ok(!aRows.some((r) => /B 项目/.test(r.content)), 'A 不能看到 B 的记忆');
  } finally { cleanup(); }
});

test('七层记忆各自独立存储', () => {
  const ws = tmp();
  try {
    const db = getDb(ws, '.dsh-meow');
    db.insert({ level: 'user', content: '用户喜欢简短回复', project: '', keywords: ['风格'], importance: 2, source_session: 's' });
    db.insert({ level: 'lesson', content: '不要用 MemFree 判断可用内存', project: 'p', keywords: ['内存'], importance: 2, source_session: 's' });

    assert.equal(db.list('user', { status: 'active' }).length, 1);
    assert.equal(db.list('lesson', { status: 'active' }).length, 1);
    assert.notEqual(
      db.list('user', { status: 'active' })[0].id,
      db.list('lesson', { status: 'active' })[0].id,
    );
  } finally { cleanup(); }
});

test('库文件落在配置指定的目录里', () => {
  const ws = tmp();
  try {
    getDb(ws, '.dsh-meow');
    const file = memoryDbPath(ws, '.dsh-meow');
    assert.ok(fs.existsSync(file), '默认路径应与 memoryDbPath 一致');
    assert.ok(file.includes('.dsh-meow'), '目录名应可配置且生效');
  } finally { cleanup(); }
});
