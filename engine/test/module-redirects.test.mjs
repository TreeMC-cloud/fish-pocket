import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installModuleRedirects } from '../runtime/module-redirects.mjs';

test('flock resolves to the iOS stand-in and grants the lock', async () => {
  installModuleRedirects();
  const { tryLockExclusive } = await import('@deepseek-ai/node-addon-system/flock');
  assert.match(tryLockExclusive.toString(), /invalid descriptor/);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ios-lock-')), 'session.lock');
  const handle = await fs.promises.open(file, 'w');
  await tryLockExclusive(handle.fd);
  await handle.close();
});
