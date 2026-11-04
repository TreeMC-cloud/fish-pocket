// Commands that start a Node program run as streaming workers (runtime/direct.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { planDirect, simpleWords } from '../runtime/direct.mjs';
import { installChildProcess } from '../runtime/child-process.mjs';
import IosSubprocessRuntime from '../plugins/subprocess-ios/index.mjs';

installChildProcess();
const cp = await import('node:child_process');

/** A project with a long-running server script and a pnpm-style .bin shim for it. */
function project() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ios-direct-')));
  fs.mkdirSync(path.join(dir, 'node_modules/srv/bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules/.bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules/srv/bin/srv.js'), 'console.log("READY", process.argv.slice(2).join(" "), process.env.MODE ?? ""); setInterval(() => {}, 1000);\n');
  fs.writeFileSync(path.join(dir, 'node_modules/.bin/srv'), '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node"  "$basedir/../srv/bin/srv.js" "$@"\nelse\n  exec node  "$basedir/../srv/bin/srv.js" "$@"\nfi\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', private: true, scripts: { dev: 'MODE=dev srv --port 1' } }));
  return dir;
}

const waitFor = async (read, pattern, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pattern.test(read())) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};

test('simple command lines tokenize; shell syntax does not', () => {
  assert.deepEqual(simpleWords(`exec next dev --webpack -p '3000'`), ['next', 'dev', '--webpack', '-p', '3000']);
  for (const script of ['a | b', 'a && b', 'echo $HOME', 'a > f', 'a; b']) assert.equal(simpleWords(script), undefined, script);
});

test('pnpm .bin shims and env assignments resolve to their Node program', () => {
  const dir = project();
  const env = { PATH: `/bin:${path.join(dir, 'node_modules/.bin')}` };
  const plan = planDirect(['sh', '-c', 'MODE=dev srv --port 1'], { cwd: dir, env });
  assert.equal(plan.script, path.join(dir, 'node_modules/srv/bin/srv.js'));
  assert.deepEqual(plan.args, ['--port', '1']);
  assert.equal(plan.env.MODE, 'dev');
  assert.equal(planDirect(['sh', '-c', 'srv | cat'], { cwd: dir, env }), undefined);
});

test('ctx.subprocess streams a long-running Node program before it exits', async () => {
  const ctx = new Context();
  ctx.plugin(IosSubprocessRuntime);
  await new Promise((r) => setTimeout(r, 20));
  const dir = project();
  const h = ctx.get('subprocess').spawn({ argv: ['bash', '-c', 'srv --port 2'], cwd: dir, graceMs: 100, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 20 } }, env: { PATH: `/bin:${path.join(dir, 'node_modules/.bin')}` } });
  assert.ok(await waitFor(() => h.collected.stdout.readFrom(0).text, /READY --port 2/));
  h.terminate();
  assert.equal((await h.done).signal, 'SIGTERM');
});

test('pnpm run of a never-exiting script shows its output (pnpm dev)', async () => {
  const dir = project();
  const child = cp.spawn('pnpm', ['dev'], { cwd: dir });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const seen = await waitFor(() => out, /READY --port 1 dev/, 30000);
  child.kill();
  assert.ok(seen, out);
});

test("pnpm's trap prefix does not hide the program", () => {
  assert.deepEqual(simpleWords(`trap 'if [ "$?" -eq 130 ]; then trap - INT; kill -s INT $$; fi; trap "trap - INT; kill -s INT $$" INT' INT; next dev --webpack`), ['next', 'dev', '--webpack']);
});

test('pnpm 11 shims ($basedir_abs, long preamble) resolve to their program', () => {
  const dir = project();
  const shim = path.join(dir, 'node_modules/.bin/srv');
  fs.writeFileSync(shim, `#!/bin/sh\n${'# preamble\n'.repeat(600)}if command -v node >/dev/null 2>&1; then\n  exec node  "$basedir_abs/../srv/bin/srv.js" "$@"\nfi\n`, { mode: 0o755 });
  const plan = planDirect([shim, '--x'], { cwd: dir, env: { PATH: '/bin' } });
  assert.equal(plan.script, path.join(dir, 'node_modules/srv/bin/srv.js'));
});
