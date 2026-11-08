import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * auto-guard 的 notify() 必须真的把消息送到 supervisor。
 *
 * 回归背景：原来写的是 `process.parentPort.postMessage(...)`，那是 Electron
 * utilityProcess 的 API；Node 的 worker_threads 里 `process.parentPort` 是
 * undefined，于是 `if` 永远不成立，所有提醒静默丢弃。这个测试在真实的
 * Worker 里跑一遍，收到消息才算通过——只检查源码里有没有那行字符串挡不住
 * 这类错误（拼写对、语义错）。
 */
test('notify 通过 parentPort 真的送到主线程', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-notify-'));
  const script = path.join(dir, 'worker.mjs');
  const plugin = new URL('../plugins/auto-guard/index.mjs', import.meta.url).href;

  fs.writeFileSync(script, `
    import { parentPort } from 'node:worker_threads';
    process.env.DSH_IOS_DATA = ${JSON.stringify(dir)};
    const { default: AutoGuard } = await import(${JSON.stringify(plugin)});
    const ctx = { effect: (fn) => fn(), on: () => () => {}, logger: { warn: () => {} } };
    const guard = new AutoGuard(ctx, {});
    guard.notify('提醒内容', { kind: 'turns', session: 's1' });
  `);

  const received = await new Promise((resolve, reject) => {
    const worker = new Worker(script);
    const timer = setTimeout(() => reject(new Error('3 秒内没收到消息：notify 没有送达')), 3000);
    worker.on('message', (message) => { clearTimeout(timer); resolve(message); });
    worker.on('error', reject);
  });

  assert.equal(received.type, 'dsh-ios/notice');
  assert.equal(received.message, '提醒内容');
  assert.equal(received.detail.kind, 'turns');
  assert.equal(received.detail.session, 's1');
});
