import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import IosHost, { createRestartRequester } from '../plugins/ios-host/index.mjs';

test('restart waits for running agents, then fires once', async () => {
  let busy = true;
  const fired = [];
  const r = createRestartRequester({ isBusy: () => busy, notify: (reason) => fired.push(reason), settleMs: 10, pollMs: 10 });
  r.request('module-comparison');
  r.request('again');
  await new Promise((done) => setTimeout(done, 50));
  assert.deepEqual(fired, []);
  busy = false;
  await new Promise((done) => setTimeout(done, 30));
  assert.deepEqual(fired, ['module-comparison']);
});

test('only restart-required plugin changes request a restart; dispose restores change()', async () => {
  const ctx = new Context();
  const results = [];
  const manager = { change: async () => results.shift() };
  const original = manager.change;
  ctx.provide('pluginManager');
  ctx.provide('agents');
  ctx.set('pluginManager', manager);
  ctx.set('agents', { list: () => [] });
  const fiber = ctx.plugin(IosHost);
  await new Promise((done) => setTimeout(done, 20));
  assert.notEqual(manager.change, original);
  results.push({ application: 'applied' }, { application: 'restart-required', restartReason: 'module-comparison' });
  assert.equal((await manager.change()).application, 'applied');
  assert.equal((await manager.change()).application, 'restart-required');
  await fiber.dispose();
  assert.equal(manager.change, original);
});
