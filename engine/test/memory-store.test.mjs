import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryStore, workspaceFromEnv } from '../runtime/memory-store.mjs';
import { runDream } from '../runtime/dream.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ms-'));

test('记忆库不可用时 available=false，不抛', () => {
  const store = createMemoryStore(tmp(), { require_: () => { throw new Error('not installed'); } });
  assert.equal(store.available, false);
  assert.match(store.error, /not installed/);
});

test('写入真实记忆库，层级是 lesson（不是不存在的 procedural）', async () => {
  const ws = tmp();
  const store = createMemoryStore(ws);
  if (!store.available) return;   // 环境没有 meow-memory 就跳过

  const r = store.write({ key: '下载', tags: ['下载'], text: '技能[下载] 成功率80%', verified: false });
  assert.ok(r?.id, '必须拿到 id');

  const mod = await import('meow-memory');
  const db = mod.getDb(ws, '.dsh-meow');
  const rows = db.list('lesson', { status: 'active' });
  assert.equal(rows.length, 1);
  assert.match(rows[0].content, /^［未验证］/, '未验证标记要在正文开头');
  assert.deepEqual(rows[0].keywords, ['下载']);
  db.close();
  store.close();
});

test('写入失败时 lastError 可见，不静默', () => {
  const store = createMemoryStore(tmp(), {
    require_: () => ({ getDb: () => ({ insert: () => { throw new Error('disk I/O error'); } }) }),
  });
  assert.equal(store.write({ text: 'x', tags: [] }), null);
  assert.match(store.error, /disk I\/O error/, '失败原因必须能查到');
});

test('Dream 端到端：trace → 提炼 → 真实落库', async () => {
  const ws = tmp();
  const dataDir = tmp();
  const store = createMemoryStore(ws);
  if (!store.available) return;

  const now = Date.now();
  fs.writeFileSync(path.join(dataDir, '.trace.jsonl'),
    [1, 2, 3].map((i) => JSON.stringify({
      at: now + i * 1000, ok: i < 3, summary: `做法${i}`, tags: ['构建'],
    })).join('\n'));

  const r = runDream(dataDir, { minNew: 1, store });
  assert.equal(r.ran, true);
  assert.equal(r.stored, 1, '必须真的落库');

  const mod = await import('meow-memory');
  const db = mod.getDb(ws, '.dsh-meow');
  assert.equal(db.list('lesson', { status: 'active' }).length, 1);
  db.close();
  store.close();
});

test('workspaceFromEnv 优先用 DSH_IOS_WORKSPACE', () => {
  assert.equal(workspaceFromEnv({ DSH_IOS_WORKSPACE: '/a', DSH_IOS_DATA: '/b' }), '/a');
  assert.equal(workspaceFromEnv({ DSH_IOS_DATA: '/b' }), '/b');
});
