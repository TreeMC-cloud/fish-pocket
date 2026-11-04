// native/root on this Mac: builds root.c with its test and runs it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const native = new URL('../../native/root/', import.meta.url).pathname;

test('the filesystem view', { skip: process.platform !== 'darwin' }, () => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-root-')));
  try {
    const binary = path.join(scratch, 'unit');
    execFileSync('cc', ['-std=c11', '-D_DARWIN_C_SOURCE', '-O1', '-Wall', '-Wextra', '-Wno-unused-parameter', '-Werror',
      `${native}root.c`, `${native}test/unit.c`, '-o', binary]);
    const run = path.join(scratch, 'run');
    fs.mkdirSync(run);
    const result = spawnSync(binary, [run], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
