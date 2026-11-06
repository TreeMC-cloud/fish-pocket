import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import IosHost, { createRestartRequester, refuseBuilds } from '../plugins/ios-host/index.mjs';

const profile = (policy) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ios-host-'));
  if (policy !== undefined) fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), policy);
  return dir;
};
const policyOf = (dir) => fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8');

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

test('refused builds stay off, whatever the policy said about them', async () => {
  const dir = profile('# kept\nallowBuilds:\n  cloudflared@0.7.3: true\n  protobufjs: set this to true or false\n  esbuild: true\n');
  await refuseBuilds(dir, ['cloudflared', 'protobufjs@7.6.6', 'cpu-features@0.0.10']);
  assert.equal(policyOf(dir), '# kept\nallowBuilds:\n  cloudflared@0.7.3: false\n  protobufjs: false\n  esbuild: true\n  cpu-features@0.0.10: false\n');
  const fresh = profile();
  await refuseBuilds(fresh, ['ssh2']);
  assert.match(policyOf(fresh), /allowBuilds:\s+ssh2: false/);
});

test('a ! in approvedBuilds refuses that build; the rest reach the manager as they were', async () => {
  const dir = profile();
  const calls = [];
  const manager = { change: async () => ({}), profile: { dir }, installBundle(spec, options) { calls.push([this === manager, spec, options]); return 'installed'; } };
  const original = manager.installBundle;
  const ctx = new Context();
  ctx.provide('pluginManager');
  ctx.provide('agents');
  ctx.set('pluginManager', manager);
  ctx.set('agents', { list: () => [] });
  const fiber = ctx.plugin(IosHost);
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(manager.installBundle('plain', { approvedBuilds: ['ssh2'] }), 'installed');
  assert.equal(await manager.installBundle('skip', { enabled: false, approvedBuilds: ['!cloudflared', 'ssh2'] }), 'installed');
  assert.deepEqual(calls, [
    [true, 'plain', { approvedBuilds: ['ssh2'] }],
    [true, 'skip', { enabled: false, approvedBuilds: ['ssh2'] }],
  ]);
  assert.match(policyOf(dir), /cloudflared: false/);
  await fiber.dispose();
  assert.equal(manager.installBundle, original);
});
