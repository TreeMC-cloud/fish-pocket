import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { PRELOAD, installRealPaths } from '../runtime/real-paths.mjs';

// A view like native/root's: /virtual/… is real/… under a scratch directory.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-real-paths-')));
const view = {
  real: (p) => (p.startsWith('/virtual') ? scratch + p.slice('/virtual'.length) : p),
  virtual: (p) => (p.startsWith(scratch) ? `/virtual${p.slice(scratch.length)}` : p),
};
const originals = { rmSync: fs.rmSync, cpSync: fs.cpSync, rmdirSync: fs.rmdirSync };
installRealPaths(view);
test.after(() => { Object.assign(fs, originals); originals.rmSync(scratch, { recursive: true, force: true }); });

test('rmSync removes what the engine path names', () => {
  fs.mkdirSync(`${scratch}/r/s`, { recursive: true });
  fs.writeFileSync(`${scratch}/r/s/f`, 'x');
  fs.rmSync('/virtual/r', { recursive: true });
  assert.equal(fs.existsSync(`${scratch}/r`), false);
});

test('rmSync takes URLs and Buffers, and paths outside the view as they are', () => {
  for (const target of [new URL('file:///virtual/u'), Buffer.from('/virtual/b')]) {
    fs.writeFileSync(`${scratch}/${path.basename(String(target))}`, 'x');
    fs.rmSync(target);
    assert.equal(fs.existsSync(`${scratch}/${path.basename(String(target))}`), false);
  }
  fs.writeFileSync(`${scratch}/plain`, 'x');
  fs.rmSync(`${scratch}/plain`);
  assert.equal(fs.existsSync(`${scratch}/plain`), false);
});

test('an invalid argument fails the way Node fails it', () => {
  assert.throws(() => fs.rmSync(undefined), { code: 'ERR_INVALID_ARG_TYPE' });
});

test('errors name the path the caller gave', () => {
  fs.mkdirSync(`${scratch}/d`);
  assert.throws(() => fs.rmSync('/virtual/d'), (error) => {
    assert.equal(error.message.includes(scratch), false, error.message);
    assert.equal(error.message.includes('/virtual/d'), true, error.message);
    return true;
  });
  fs.rmdirSync(`${scratch}/d`);
});

test('recursive rmdirSync takes the view; plain rmdirSync goes through libc', () => {
  fs.mkdirSync(`${scratch}/rd/s`, { recursive: true });
  fs.rmdirSync('/virtual/rd', { recursive: true });
  assert.equal(fs.existsSync(`${scratch}/rd`), false);
  assert.throws(() => fs.rmdirSync('/virtual/none'), { code: 'ENOENT' });
});

test('cpSync copies between engine paths and filters on them', () => {
  fs.mkdirSync(`${scratch}/c/s`, { recursive: true });
  fs.writeFileSync(`${scratch}/c/s/f`, 'x');
  fs.writeFileSync(`${scratch}/c/skip`, 'x');
  const seen = [];
  fs.cpSync('/virtual/c', '/virtual/c2', {
    recursive: true,
    filter: (source) => { seen.push(source); return !source.endsWith('skip'); },
  });
  assert.equal(fs.readFileSync(`${scratch}/c2/s/f`, 'utf8'), 'x');
  assert.equal(fs.existsSync(`${scratch}/c2/skip`), false);
  assert.ok(seen.includes('/virtual/c/s/f'), seen.join());
});

test('a relative path is resolved before the view sees it', () => {
  const cwd = process.cwd();
  process.chdir(scratch);
  try {
    fs.writeFileSync('rel', 'x');
    fs.rmSync('rel');
    assert.equal(fs.existsSync(`${scratch}/rel`), false);
  } finally {
    process.chdir(cwd);
  }
});

test('named ESM imports see the wrappers', async () => {
  const { rmSync } = await import('node:fs');
  assert.equal(rmSync, fs.rmSync);
});

test('PRELOAD loads in a worker', async () => {
  assert.deepEqual(PRELOAD, [`--import=${new URL('../runtime/real-paths.mjs', import.meta.url).href}`]);
  const worker = new Worker('require("worker_threads").parentPort.postMessage("up")', { eval: true, execArgv: PRELOAD });
  assert.equal(await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }), 'up');
  await worker.terminate();
});
