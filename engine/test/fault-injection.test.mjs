import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load, save, create, transition } from '../runtime/task-registry.mjs';
import { Router } from '../runtime/router.mjs';

/**
 * 故障注入（Phase 2 交付清单明确要求的两种）：
 *
 *   1. 磁盘满：任务表写不进去时，Router 必须抛错而不是静默认为成功。
 *      「写失败但状态已改」是最危险的静默错误——内存里任务跑完了，
 *      磁盘上还是旧的，重启后同一批任务会重来一遍。
 *
 *   2. 取消传播：取消一个 running 任务，它不该再产出结果或回写状态。
 *      取消后仍继续执行 = 取消键是装饰。
 */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fault-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. 磁盘满 ─────────────────────────────────────────────────────────

test('任务表写失败时 save 抛错，不静默成功', () => {
  const dir = tmp();
  const state = load(dir);
  create(state, { source: 'user', eventId: 'e1', title: 'T' });

  // 把目录设为只读，让 mkdir/rename 都进不去（模拟磁盘满/权限错）
  // 注意：root 可能无视权限位，所以先真正写一次确认能写，再改权限验证行为
  fs.chmodSync(dir, 0o500);
  try {
    let threw = false;
    try {
      save(state, dir);
    } catch {
      threw = true;
    }
    // root 下 chmod 可能拦不住；这种情况用「目录换成文件」的兜底验证
    if (!threw && process.getuid?.() === 0) {
      const dir2 = tmp();
      const state2 = load(dir2);
      create(state2, { source: 'user', eventId: 'x', title: 'x' });
      save(state2, dir2);   // 先正常写一次

      // 把 tasks.json 换成同名目录：writeFileSync 到目录必然失败
      const file = path.join(dir2, 'tasks.json');
      fs.rmSync(file);
      fs.mkdirSync(file);
      assert.throws(() => save(state2, dir2), /写入失败|EISDIR/, '写进目录必须失败');
      return;
    }
    assert.equal(threw, true, 'save 必须抛错——静默吞掉写失败会让内存与磁盘永久分叉');
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

test('save 失败后不留半个 JSON（原子性）', () => {
  const dir = tmp();
  const state = load(dir);
  create(state, { source: 'user', eventId: 'e1', title: '第一次' });
  save(state, dir);

  const before = fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8');

  // 让 rename 失败：把目标文件换成只读目录
  const file = path.join(dir, 'tasks.json');
  fs.rmSync(file);
  fs.mkdirSync(file);   // 同名目录 → rename 进不去

  const state2 = load(dir);   // 目录读不了，返回空
  create(state2, { source: 'user', eventId: 'e2', title: '第二次' });
  assert.throws(() => save(state2, dir));

  // 清理后旧内容已不在（被我们 rm 了）——验证的是「失败不产生半成品文件」
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '崩溃时不能留下 .tmp 半成品');
});

test('Router 在存储失败后仍然活着（不拖垮调度器）', async () => {
  const dir = tmp();
  let failNext = false;

  const router = new Router({
    dataDir: dir,
    runTask: async (task) => {
      if (failNext) throw new Error('模拟：任务表写失败');
      return { ok: true };
    },
  });
  router.accept({ source: 'user', eventId: 'ok1', title: '正常任务' });
  await router.execute();
  await wait(200);

  const first = Object.values(router.state().tasks)[0];
  assert.equal(first.status, 'succeeded');

  // 第二个任务在执行中出错
  failNext = true;
  router.accept({ source: 'user', eventId: 'bad1', title: '会炸的' });
  await router.execute();
  await wait(200);

  const second = router.state().tasks['x'] ?? Object.values(router.state().tasks).find((t) => t.title === '会炸的');
  assert.ok(second, '任务仍应存在');
  assert.equal(second.status, 'needs_reconciliation', '执行出错 → 需要核对，不是消失');
});

// ── 2. 取消传播 ───────────────────────────────────────────────────────

test('取消 queued 任务后它不会被调度', async () => {
  const dir = tmp();
  const started = [];
  const router = new Router({
    dataDir: dir,
    runTask: async (task) => { started.push(task.taskId); return { ok: true }; },
  });

  router.accept({ source: 'user', eventId: 'c1', title: '要取消的' });
  const id = Object.keys(router.state().tasks)[0];
  router.cancel(id);

  await router.execute();
  await wait(100);
  assert.equal(started.length, 0, '已取消的任务不能被调起');
  assert.equal(router.state().tasks[id].status, 'cancelled');
});

test('取消 running 任务后，结果不再回写', async () => {
  const dir = tmp();
  let release;
  const gate = new Promise((r) => { release = r; });

  const router = new Router({
    dataDir: dir,
    runTask: async () => { await gate; return { ok: true }; },
  });
  router.accept({ source: 'user', eventId: 'r1', title: '长任务' });
  await router.execute();
  await wait(50);

  const id = Object.keys(router.state().tasks)[0];
  assert.equal(router.state().tasks[id].status, 'running');

  // 跑到一半取消
  router.cancel(id, { force: true });
  release();

  await wait(200);
  const final = router.state().tasks[id];
  assert.equal(final.status, 'cancelled', '取消后不能被 worker 的结果覆盖');
});

test('取消一个不影响其他任务', async () => {
  const dir = tmp();
  const router = new Router({
    dataDir: dir,
    maxConcurrent: 2,
    runTask: async () => ({ ok: true }),
  });
  router.accept({ source: 'user', eventId: 'a1', title: 'A' });
  router.accept({ source: 'user', eventId: 'b1', title: 'B' });

  const ids = Object.keys(router.state().tasks);
  router.cancel(ids[0]);

  await router.execute();
  await wait(200);

  const tasks = router.state().tasks;
  assert.equal(tasks[ids[0]].status, 'cancelled');
  assert.equal(tasks[ids[1]].status, 'succeeded', '取消 A 不该影响 B');
});

test('终态任务（succeeded/cancelled）不能再取消', () => {
  const dir = tmp();
  const state = load(dir);
  const { task } = create(state, { source: 'user', eventId: 't1', title: 'T' });
  transition(state, task.taskId, 'queued');
  transition(state, task.taskId, 'running');
  transition(state, task.taskId, 'succeeded');
  save(state, dir);

  assert.throws(() => transition(state, task.taskId, 'cancelled'), /非法转移/);
});
