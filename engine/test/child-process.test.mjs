// The child_process emulation, exercised through the public node:child_process
// API the way execa, plugins and the plugin manager use it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { installChildProcess } from '../runtime/child-process.mjs';

installChildProcess();
const cp = await import('node:child_process');
const execFile = promisify(cp.execFile);
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ios-cp-')));

test('ESM named imports see the emulation', async () => {
  const { spawn } = await import('node:child_process');
  assert.equal(spawn, cp.default.spawn);
  assert.equal(spawn.name, 'spawn');
  assert.ok(spawn('true') instanceof cp.ChildProcess);
});

test('node children read piped stdin and see their cwd', async () => {
  const dir = tmp();
  const child = cp.spawn('node', ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(process.cwd(), s.trim().toUpperCase()))'], { cwd: dir });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stdin.end('hello');
  const [code] = await new Promise((r) => child.on('close', (...a) => r(a)));
  assert.equal(code, 0);
  assert.equal(out.trim(), `${dir} HELLO`);
});

test('node finds a script the way the CLI does: extension, directory index', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'tool'));
  fs.writeFileSync(path.join(dir, 'scripts', 'postinstall.js'), 'console.log("ran", process.argv[1]);');
  fs.writeFileSync(path.join(dir, 'tool', 'index.js'), 'console.log("index");');
  const named = await execFile('node', ['scripts/postinstall'], { cwd: dir });
  assert.equal(named.stdout.trim(), `ran ${path.join(dir, 'scripts', 'postinstall')}`);
  assert.equal((await execFile('node', ['tool'], { cwd: dir })).stdout.trim(), 'index');
  await assert.rejects(execFile('node', ['scripts/missing'], { cwd: dir }), /Cannot find module/);
});

test('node children resolve bare relative fs paths against their cwd', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'f.txt'), 'in-cwd');
  fs.writeFileSync(path.join(dir, 'a'), 'renamed');
  fs.writeFileSync(path.join(dir, '.env'), 'FROM_ENV_FILE=yes\n');
  // The script lives elsewhere, so nothing it reads is relative to its own location.
  const script = path.join(tmp(), 'probe.mjs');
  fs.writeFileSync(script, `
    import fs from 'node:fs';
    import { readFileSync, readdirSync } from 'node:fs';
    import { readFile } from 'node:fs/promises';
    const r = {};
    r.readFileSync = fs.readFileSync('f.txt', 'utf8');
    r.namedImport = readFileSync('f.txt', 'utf8');
    r.readdir = readdirSync('.').sort().join(',');
    r.promises = await readFile('f.txt', 'utf8');
    r.stream = await new Promise((ok) => { let s = ''; fs.createReadStream('f.txt').on('data', (d) => { s += d; }).on('end', () => ok(s)); });
    fs.writeFileSync('out.txt', 'written');
    fs.renameSync('a', 'b');
    fs.symlinkSync('f.txt', 'link');
    r.readlink = fs.readlinkSync('link');
    r.viaLink = fs.readFileSync('link', 'utf8');
    r.realpathNative = fs.realpathSync.native('sub/../f.txt');
    r.exists = [fs.existsSync('f.txt'), fs.existsSync('missing')];
    r.glob = fs.globSync('*.txt').sort().join(',');
    process.chdir('sub');
    r.afterChdir = fs.readFileSync('../f.txt', 'utf8');
    process.loadEnvFile('../.env');
    r.envFile = process.env.FROM_ENV_FILE;
    r.pwd = process.env.PWD;
    console.log(JSON.stringify(r));
  `);
  const { stdout } = await execFile('node', [script], { cwd: dir });
  assert.deepEqual(JSON.parse(stdout), {
    readFileSync: 'in-cwd', namedImport: 'in-cwd', readdir: '.env,a,f.txt,sub', promises: 'in-cwd', stream: 'in-cwd',
    readlink: 'f.txt', viaLink: 'in-cwd', realpathNative: path.join(dir, 'f.txt'), exists: [true, false],
    glob: 'f.txt,out.txt', afterChdir: 'in-cwd', envFile: 'yes', pwd: dir,
  });
  assert.equal(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8'), 'written');
  assert.equal(fs.readFileSync(path.join(dir, 'b'), 'utf8'), 'renamed');
  assert.equal(fs.readlinkSync(path.join(dir, 'link')), 'f.txt');
});

test('missing executables fail with ENOENT like Node', async () => {
  await assert.rejects(execFile('definitely-not-a-command', ['x']), { code: 'ENOENT' });
});

test('exec runs shell pipelines and reports exit codes', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'f.txt'), 'b\na\nc\n');
  const { stdout } = await promisify(cp.exec)('sort f.txt | head -2', { cwd: dir });
  assert.equal(stdout, 'a\nb\n');
  await assert.rejects(promisify(cp.exec)('exit 4', { cwd: dir }), { code: 4 });
});

test('fork has an IPC channel', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'echo.mjs'), 'process.on("message", (m) => { process.send({ echo: m }); process.exit(0); });');
  const child = cp.fork(path.join(dir, 'echo.mjs'));
  child.send('ping');
  const reply = await new Promise((r) => child.on('message', r));
  assert.deepEqual(reply, { echo: 'ping' });
});

test('pnpm runs as a worker and installs a package', { timeout: 120000 }, async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"t","private":true}');
  const { stdout } = await execFile('pnpm', ['--version'], { cwd: dir });
  assert.match(stdout, /^11\./);
  await execFile('pnpm', ['add', 'is-number@7.0.0', '--ignore-scripts', `--store-dir=${path.join(dir, '.store')}`], { cwd: dir, env: { ...process.env, CI: '1' } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'node_modules/is-number/package.json'), 'utf8')).version, '7.0.0');
});

test('workers default to untracked fds, explicit options win', async () => {
  const { installWorkerDefaults } = await import('../runtime/worker-defaults.mjs');
  installWorkerDefaults();
  const { Worker } = await import('node:worker_threads');
  const w = new Worker('process.exit(0)', { eval: true });
  assert.ok(w instanceof (await import('node:worker_threads')).default.Worker);
  assert.equal(await new Promise((r) => w.on('exit', r)), 0);
});

test('spawnSync runs shell, node and pnpm synchronously', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'f.txt'), 'b\na\n');
  const sorted = cp.spawnSync('/bin/sh', ['-c', 'sort f.txt'], { cwd: dir, encoding: 'utf8' });
  assert.equal(sorted.status, 0);
  assert.equal(sorted.stdout, 'a\nb\n');
  const piped = cp.spawnSync('node', ['-e', 'process.stdin.on("data", d => process.stdout.write(String(d).toUpperCase()))'], { input: 'hey', cwd: dir });
  assert.ok(Buffer.isBuffer(piped.stdout));
  assert.equal(piped.stdout.toString(), 'HEY');
  // What Next.js runs before fetching its WASM compiler.
  const registry = cp.spawnSync('/bin/sh', ['-c', 'pnpm config get registry'], { cwd: dir, encoding: 'utf8' });
  assert.equal(registry.status, 0, registry.stderr);
  assert.match(registry.stdout.trim(), /^https?:\/\//);
});

test('output to a file descriptor is in the file once the child exits', async () => {
  const dir = tmp();
  // Claude Code's Bash tool: stdio ['pipe', fd, fd], then reads the file on exit.
  for (const [file, args] of [['/bin/bash', ['-c', 'echo out; echo err >&2']], ['node', ['-e', 'console.log("out"); console.error("err")']]]) {
    const target = path.join(dir, `${path.basename(file)}.log`);
    const fd = fs.openSync(target, 'w');
    const child = cp.spawn(file, args, { cwd: dir, stdio: ['pipe', fd, fd] });
    // Like a real parent, give up our copy at once: the child holds its own.
    fs.closeSync(fd);
    assert.equal(child.stdout, null);
    const [code] = await new Promise((r) => child.on('exit', (...a) => r(a)));
    assert.equal(code, 0);
    assert.deepEqual(fs.readFileSync(target, 'utf8').split('\n').filter(Boolean).sort(), ['err', 'out'], file);
  }
});

test('shell options may follow -c, as bash parses them', async () => {
  const dir = tmp();
  // Claude Code's Bash tool: <shell> -c -l <command>.
  for (const args of [['-c', '-l', 'echo ok'], ['-lc', 'echo ok'], ['-l', '-c', 'echo ok'], ['-c', '--', 'echo ok'], ['-o', 'pipefail', '-c', 'echo ok']]) {
    const { stdout } = await execFile('/bin/bash', args, { cwd: dir });
    assert.equal(stdout, 'ok\n', args.join(' '));
  }
  fs.writeFileSync(path.join(dir, 's.sh'), 'echo from-file\n');
  assert.equal((await execFile('bash', ['-e', 's.sh'], { cwd: dir })).stdout, 'from-file\n');
});

test('spawnSync reports missing commands and timeouts without throwing', () => {
  const missing = cp.spawnSync('no-such-command', []);
  assert.equal(missing.error.code, 'ENOENT');
  assert.equal(missing.status, null);
  const slow = cp.spawnSync('sleep', ['5'], { timeout: 200 });
  assert.equal(slow.error.code, 'ETIMEDOUT');
});

test('execSync / execFileSync return stdout and throw on failure like Node', () => {
  const dir = tmp();
  assert.equal(cp.execSync('echo hi | tr a-z A-Z', { cwd: dir }).toString(), 'HI\n');
  assert.equal(cp.execFileSync('node', ['-p', '6*7'], { encoding: 'utf8' }), '42\n');
  assert.throws(() => cp.execSync('echo boom >&2; exit 3', { cwd: dir, stdio: 'pipe' }), (error) => error.status === 3 && /boom/.test(error.stderr.toString()));
  assert.throws(() => cp.execFileSync('no-such-command'), { code: 'ENOENT' });
});
