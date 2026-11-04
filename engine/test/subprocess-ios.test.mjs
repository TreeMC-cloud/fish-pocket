// Exercise the iOS subprocess provider through a real cordis context, the way
// bash-local and the terminal controller call it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import IosSubprocessRuntime from '../plugins/subprocess-ios/index.mjs';

async function runtime() {
  const ctx = new Context();
  ctx.plugin(IosSubprocessRuntime);
  await ctx.inject(['subprocess'], () => {});
  await new Promise((r) => setTimeout(r, 10));
  return ctx.get('subprocess');
}

const collect = { maxBytes: 1 << 20 };
const spec = (argv, cwd, extra = {}) => ({ argv, cwd, graceMs: 100, stdio: { stdin: 'ignore', stdout: collect, stderr: collect }, env: { PATH: '/bin', HOME: cwd }, ...extra });

test('bash -c runs on the real filesystem with cwd', async () => {
  const sp = await runtime();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ios-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\nworld\n');
  const h = sp.spawn(spec(['bash', '-c', 'grep -n world a.txt && echo made > b.txt && pwd'], dir));
  const outcome = await h.done;
  assert.equal(outcome.exitCode, 0);
  const out = h.collected.stdout.readFrom(0).text;
  assert.match(out, /2:world/);
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'made\n');
});

test('exit codes and stderr propagate', async () => {
  const sp = await runtime();
  const h = sp.spawn(spec(['bash', '-c', 'echo oops >&2; exit 3'], os.tmpdir()));
  assert.equal((await h.done).exitCode, 3);
  assert.match(h.collected.stderr.readFrom(0).text, /oops/);
});

test('node runs in a worker thread', async () => {
  const sp = await runtime();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ios-'));
  fs.writeFileSync(path.join(dir, 's.mjs'), 'console.log("args", process.argv.slice(2).join(","))');
  const h = sp.spawn(spec(['bash', '-c', 'node s.mjs x y && node -e "console.log(6*7)"'], dir));
  assert.equal((await h.done).exitCode, 0);
  const out = h.collected.stdout.readFrom(0).text;
  assert.match(out, /args x,y/);
  assert.match(out, /42/);
});

test('terminate aborts a running script', async () => {
  const sp = await runtime();
  const h = sp.spawn(spec(['bash', '-c', 'sleep 30'], os.tmpdir()));
  setTimeout(() => h.terminate(), 50);
  const outcome = await h.done;
  assert.equal(outcome.exitCode, null);
});

test('terminal keeps cwd between lines', async () => {
  const sp = await runtime();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ios-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  const t = await sp.spawnTerminal({ argv: ['/bin/bash'], cwd: dir, rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 100, env: { PATH: '/bin' } });
  let text = '';
  t.output.on('data', (c) => { text += c; });
  await t.write('cd sub\r');
  await new Promise((r) => setTimeout(r, 100));
  await t.write('pwd\r');
  await new Promise((r) => setTimeout(r, 100));
  assert.match(text, /\/sub\r\n/);
  await t.terminate();
});

test('unknown executables are reported, not crashed on', async () => {
  const sp = await runtime();
  await assert.rejects(sp.resolveExecutable('gcc'), /command not found/);
  assert.equal(await sp.resolveExecutable('bash'), '/bin/bash');
});

test('sandbox-ios confinement fences writes to the granted roots', async () => {
  const { default: IosSandboxProvider } = await import('../plugins/sandbox-ios/index.mjs');
  const ctx = new Context();
  ctx.plugin(IosSubprocessRuntime);
  ctx.plugin(IosSandboxProvider);
  await new Promise((r) => setTimeout(r, 20));
  const sp = ctx.get('subprocess');
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ios-ws-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.dsh-ios-out-')));
  try {
    const run = async (mode, script) => {
      const confined = await ctx.get('sandbox').confine(['bash', '-c', script], { mode, workspaceRoot: ws });
      const h = sp.spawn(spec(confined.argv, ws));
      return { outcome: await h.done, err: h.collected.stderr.readFrom(0).text, confined };
    };
    const inside = await run('workspace-write', 'echo ok > inside.txt');
    assert.equal(inside.outcome.exitCode, 0, inside.err);
    assert.equal(fs.readFileSync(path.join(ws, 'inside.txt'), 'utf8'), 'ok\n');
    const escape = await run('workspace-write', `echo no > ${outside}/x.txt`);
    assert.notEqual(escape.outcome.exitCode, 0);
    assert.match(escape.err, new RegExp(escape.confined.denialSignatures[0]));
    assert.equal(fs.existsSync(path.join(outside, 'x.txt')), false);
    const ro = await run('read-only', 'cat inside.txt && pwd && echo no > again.txt');
    assert.notEqual(ro.outcome.exitCode, 0);
    // Reads (and cwd) still work under confinement; only the write is denied.
    const roOut = sp.spawn(spec((await ctx.get('sandbox').confine(['bash', '-c', 'cat inside.txt; pwd'], { mode: 'read-only', workspaceRoot: ws })).argv, ws));
    await roOut.done;
    assert.equal(roOut.collected.stdout.readFrom(0).text, `ok\n${ws}\n`);
    assert.equal(fs.existsSync(path.join(ws, 'again.txt')), false);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('pwd and $PWD are absolute', async () => {
  const sp = await runtime();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ios-')));
  const h = sp.spawn(spec(['bash', '-c', 'pwd; echo "$PWD"'], dir));
  await h.done;
  assert.equal(h.collected.stdout.readFrom(0).text, `${dir}\n${dir}\n`);
});

test('rg accepts the argv templates of dsh-tool-fs-search', async () => {
  const sp = await runtime();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ios-rg-')));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/old.ts'), 'alpha\n');
  fs.utimesSync(path.join(dir, 'src/old.ts'), new Date(2020, 0, 1), new Date(2020, 0, 1));
  fs.writeFileSync(path.join(dir, 'src/new.ts'), 'beta MARKER\n');
  const run = async (args) => {
    const h = sp.spawn(spec(['/bin/rg', '--no-config', ...args], dir));
    const outcome = await h.done;
    return { code: outcome.exitCode, out: h.collected.stdout.readFrom(0).text, err: h.collected.stderr.readFrom(0).text };
  };
  const grep = await run(['--json', '--regexp=MARKER', '--', '.']);
  assert.equal(grep.code, 0, grep.err);
  const match = grep.out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.type === 'match');
  assert.equal(match.data.line_number, 1);
  assert.match(match.data.path.text, /new\.ts$/);
  const glob = await run(['--files', '--glob=**/*.ts', '--sort=modified', '--no-ignore', '--hidden', '--glob=!**/.git', '--', '.']);
  assert.equal(glob.code, 0, glob.err);
  assert.deepEqual(glob.out.trim().split('\n').map((f) => path.basename(f)), ['old.ts', 'new.ts']);
  assert.equal((await run(['--json', '--regexp=nothing-here', '--', '.'])).code, 1);
});

test('rg takes Claude Code Grep argv: --max-columns, ripgrep case rules', async () => {
  const sp = await runtime();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ios-rg-')));
  fs.writeFileSync(path.join(dir, 'a.txt'), `beta needle\nNeedle upper\n${'x'.repeat(40)} needle\n`);
  const run = async (args) => {
    const h = sp.spawn(spec(['/bin/rg', ...args], dir));
    const outcome = await h.done;
    return { code: outcome.exitCode, out: h.collected.stdout.readFrom(0).text, err: h.collected.stderr.readFrom(0).text };
  };
  const grep = await run(['--hidden', '--glob', '!.git', '--max-columns', '30', '-n', 'needle', dir]);
  assert.equal(grep.code, 0, grep.err);
  assert.deepEqual(grep.out.trim().split('\n').map((l) => l.slice(dir.length + 1)), ['a.txt:1:beta needle', 'a.txt:3:[Omitted long line]']);
  assert.equal((await run(['-i', '-c', 'needle', dir])).out.trim(), `${dir}/a.txt:3`);
  assert.equal((await run(['-l', '--max-columns=5', 'needle', dir])).out.trim(), `${dir}/a.txt`);
});

test('/dev/null works confined and unconfined; **/ globs match at the root', async () => {
  const sp = await runtime();
  const { default: IosSandboxProvider } = await import('../plugins/sandbox-ios/index.mjs');
  const ctx = new Context();
  ctx.plugin(IosSandboxProvider);
  await new Promise((r) => setTimeout(r, 20));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ios-dev-')));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/b.txt'), 'y\n');
  const script = 'echo hi > /dev/null; ls nope 2>/dev/null; cat /dev/null; echo ok';
  for (const argv of [['bash', '-c', script], (await ctx.get('sandbox').confine(['bash', '-c', script], { mode: 'workspace-write', workspaceRoot: dir })).argv]) {
    const h = sp.spawn(spec(argv, dir));
    await h.done;
    assert.equal(h.collected.stdout.readFrom(0).text, 'ok\n', h.collected.stderr.readFrom(0).text);
  }
  const g = sp.spawn(spec(['/bin/rg', '--no-config', '--files', '--glob=**/*.txt', '--', '.'], dir));
  await g.done;
  assert.deepEqual(g.collected.stdout.readFrom(0).text.trim().split('\n').map((f) => f.replace(/^\.\//, '')).sort(), ['a.txt', 'src/b.txt']);
});

test('a running command leaves direct eval in the engine alone', async () => {
  const sp = await runtime();
  const h = sp.spawn(spec(['bash', '-c', 'sleep 1'], os.tmpdir()));
  await new Promise((r) => setTimeout(r, 200));
  // cordis evaluates plugin `disabled` expressions like this, on this thread.
  const ctx = 42;
  assert.equal(eval('ctx'), 42);
  await h.done;
});

test('a spawn adds to the parent environment: the bash tool passes only its overrides', async () => {
  const sp = await runtime();
  process.env.IOS_TEST_INHERITED = 'yes';
  try {
    const h = sp.spawn(spec(['bash', '-c', 'echo "$IOS_TEST_INHERITED $HOME $TERM"; echo ~'], os.tmpdir(), { env: { TERM: 'dumb' } }));
    assert.equal((await h.done).exitCode, 0);
    assert.equal(h.collected.stdout.readFrom(0).text, `yes ${process.env.HOME} dumb\n${process.env.HOME}\n`);
  } finally {
    delete process.env.IOS_TEST_INHERITED;
  }
});
