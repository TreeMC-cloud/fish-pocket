// What the engine needs from the filesystem view, checked on the real NodeMobile
// (scripts/test-root-sim.sh). Run it when Node or pnpm changes: it covers what a
// libc hook cannot show on its own, like SQLite, libc++ and module loading.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { installChildProcess } from './runtime/child-process.mjs';
import { installWorkerDefaults } from './runtime/worker-defaults.mjs';

const H = '/home/dsh';
const real = /\/(Containers\/Data\/Application|containers\/Bundle\/Application|Library\/Developer\/CoreSimulator)\//;
const here = import.meta.dirname;
let failed = 0;
async function check(name, body) {
  try {
    await body();
    console.log(`ok    ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(error?.message ?? error).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
const scan = (directory) => {
  const found = { hits: [], links: 0 };
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const file = path.join(d, entry.name);
      if (entry.isSymbolicLink()) { if (fs.readlinkSync(file).startsWith('/')) found.links++; continue; }
      if (entry.isDirectory()) { walk(file); continue; }
      if (fs.statSync(file).size < 1 << 22 && real.test(fs.readFileSync(file, 'latin1'))) found.hits.push(file);
    }
  };
  walk(directory);
  return found;
};

installWorkerDefaults();
installChildProcess();
// The second run (scripts/test-root-sim.sh) keeps pnpm's state, not this.
fs.rmSync(`${H}/t`, { recursive: true, force: true });
fs.mkdirSync(`${H}/t`, { recursive: true });
process.chdir(`${H}/t`);

await check('identity', () => {
  assert.equal(os.homedir(), H);
  assert.equal(os.tmpdir(), '/tmp');
  assert.equal(process.cwd(), `${H}/t`);
  assert.match(import.meta.url, /^file:\/\/\/opt\/dsh\//);
  assert.match(process.execPath, /^\/opt\/dsh\//);
});
await check('the two variables the view answers', () => {
  // This thread's is the process's, which stays real; only what these two answer differs.
  assert.equal(process.env.HOME, H);
  assert.equal(process.env.TMPDIR, '/tmp');
});
await check('paths the kernel produces', () => {
  fs.mkdirSync(`${H}/t/a/b`, { recursive: true });
  fs.writeFileSync(`${H}/t/a/b/f`, 'x');
  assert.equal(fs.realpathSync(`${H}/t/a/b/f`), `${H}/t/a/b/f`);
  assert.equal(fs.realpathSync.native(`${H}/t/a/b/f`), `${H}/t/a/b/f`);
  assert.match(fs.mkdtempSync('/tmp/x-'), /^\/tmp\/x-/);
  assert.throws(() => fs.readFileSync(`${H}/nope`), (e) => e.path === `${H}/nope` && !real.test(e.message));
  assert.equal(new Error('x').stack.split('\n')[1].includes('file:///opt/dsh/'), true);
});
await check('links', () => {
  fs.symlinkSync('b/f', `${H}/t/a/rel`);
  fs.symlinkSync(`${H}/t/a/b/f`, `${H}/t/a/abs`);
  assert.equal(fs.readlinkSync(`${H}/t/a/abs`), 'b/f');
  assert.equal(fs.readFileSync(`${H}/t/a/abs`, 'utf8'), 'x');
  assert.equal(fs.realpathSync(`${H}/t/a/rel`), `${H}/t/a/b/f`);
  assert.throws(() => fs.symlinkSync('/opt/dsh/x', `${H}/t/a/bundled`), { code: 'EPERM' });
});
await check('the root and the system', () => {
  assert.ok(['home', 'opt', 'tmp', 'etc'].every((name) => fs.readdirSync('/').includes(name)));
  fs.mkdirSync('/abc/d', { recursive: true });
  fs.writeFileSync('/abc/d/f', 'x');
  fs.writeFileSync('/tmp/t', 'x');
  fs.mkdirSync('/usr/local', { recursive: true });
  assert.equal(fs.readFileSync('/abc/d/f', 'utf8'), 'x');
  assert.ok(fs.readFileSync('/etc/hosts', 'utf8').includes('localhost'));
  assert.equal(fs.realpathSync('/etc/hosts').endsWith('/etc/hosts'), true);
  assert.ok(fs.existsSync('/usr/share/zoneinfo') && fs.existsSync('/dev/null'));
  fs.writeFileSync('/dev/null', 'x');
});
await check('libc++ entry points', async () => {
  fs.mkdirSync(`${H}/t/r/s`, { recursive: true });
  fs.writeFileSync(`${H}/t/r/s/f`, 'x');
  fs.cpSync(`${H}/t/r`, `${H}/t/r2`, { recursive: true });
  assert.equal(fs.readFileSync(`${H}/t/r2/s/f`, 'utf8'), 'x');
  fs.rmSync(`${H}/t/r`, { recursive: true });
  assert.equal(fs.existsSync(`${H}/t/r`), false);
  fs.writeFileSync(`${H}/t/f`, 'x');
  fs.rmSync(`${H}/t/f`);
  assert.equal(fs.existsSync(`${H}/t/f`), false);
  fs.rmdirSync(`${H}/t/r2`, { recursive: true });
  assert.equal(fs.existsSync(`${H}/t/r2`), false);
  const temporary = fs.mkdtempDisposableSync('/tmp/d-');
  temporary.remove();
  assert.equal(fs.existsSync(temporary.path), false);
  fs.mkdirSync(`${H}/t/p/s`, { recursive: true });
  await fs.promises.rm(`${H}/t/p`, { recursive: true });
  assert.equal(fs.existsSync(`${H}/t/p`), false);
});
await check('SQLite', () => {
  for (const mode of ['DELETE', 'WAL']) {
    const file = `${H}/t/${mode}.db`;
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA journal_mode=${mode}`);
    db.exec('create table t(a)');
    db.exec('insert into t values(1)');
    db.exec('insert into t values(2)');
    assert.equal(db.prepare('select count(*) c from t').get().c, 2);
    db.close();
    assert.equal(fs.existsSync(`${file}-journal`), false);
    const again = new DatabaseSync(file, { readOnly: true });
    assert.equal(again.prepare('select count(*) c from t').get().c, 2);
    again.close();
  }
});
await check('modules', async () => {
  fs.writeFileSync(`${H}/t/m.mjs`, 'export const u = import.meta.url;');
  assert.equal((await import(`${H}/t/m.mjs`)).u, `file://${H}/t/m.mjs`);
  fs.mkdirSync(`${H}/t/node_modules/p`, { recursive: true });
  fs.writeFileSync(`${H}/t/node_modules/p/index.js`, 'exports.f = __filename;');
  assert.equal(createRequire(`${H}/t/x.js`)('p').f, `${H}/t/node_modules/p/index.js`);
  assert.equal((await import(`${H}/t/node_modules/p/index.js`)).default.f, `${H}/t/node_modules/p/index.js`);
});
await check('every thread gets the libc++ entry points', async () => {
  const body = `import fs from 'node:fs'; import { parentPort } from 'node:worker_threads'; fs.mkdirSync('${H}/t/w/s', { recursive: true }); fs.rmSync('${H}/t/w', { recursive: true }); parentPort.postMessage(fs.existsSync('${H}/t/w'));`;
  fs.writeFileSync(`${H}/t/w.mjs`, body);
  for (const options of [{}, { execArgv: [] }, { env: { A: '1' } }]) {
    const worker = new Worker(`${H}/t/w.mjs`, options);
    assert.equal(await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }), false, JSON.stringify(options));
  }
});
await check('an emulated child', async () => {
  const run = (command) => new Promise((resolve) => childProcess.exec(command, { cwd: `${H}/t` }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, out: stdout + stderr })));
  assert.equal((await run('pwd')).out.trim(), `${H}/t`);
  assert.equal((await run('echo ~')).out.trim(), H);
  const node = await run(`node -e "const fs=require('fs'); fs.writeFileSync('c','x'); fs.rmSync('c'); console.log(fs.existsSync('c'), require('os').homedir())"`);
  assert.equal(node.out.trim(), `false ${H}`);
  assert.ok((await run('ls /')).out.includes('home'));
  assert.ok((await run('cat /etc/hosts')).out.includes('localhost'));
});
await check('a Unix socket under a long real path', async () => {
  const file = '/tmp/conformance.sock';
  const server = net.createServer((socket) => socket.end('hi'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(file, resolve); });
  assert.ok(fs.existsSync(file));
  const reply = await new Promise((resolve, reject) => {
    const client = net.connect(file);
    let text = '';
    client.on('data', (chunk) => { text += chunk; });
    client.on('end', () => resolve(text));
    client.on('error', reject);
  });
  assert.equal(reply, 'hi');
  await new Promise((resolve) => server.close(resolve));
});
await check('pnpm, and a tree that moved', async () => {
  const profile = `${H}/.dsh/profiles/p`;
  const pnpm = (...args) => new Promise((resolve) => {
    const child = childProcess.spawn('pnpm', [...args, '--reporter=append-only'], { cwd: profile, env: { ...process.env, CI: '1', pnpm_config_confirm_modules_purge: 'false' } });
    let out = '';
    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.stderr?.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ code, out }));
  });
  const second = fs.existsSync(`${profile}/package.json`);
  if (!second) {
    fs.mkdirSync(profile, { recursive: true });
    fs.mkdirSync(`${H}/Documents/plugin`, { recursive: true });
    fs.writeFileSync(`${profile}/package.json`, '{"name":"profile","private":true,"version":"0.0.0"}');
    fs.writeFileSync(`${H}/Documents/plugin/package.json`, '{"name":"plugin","version":"1.0.0","type":"module","main":"index.mjs"}');
    fs.writeFileSync(`${H}/Documents/plugin/index.mjs`, 'export const where = import.meta.url;');
    for (const name of ['hello', 'bye']) {
      fs.mkdirSync(`${H}/pack/${name}/package`, { recursive: true });
      fs.writeFileSync(`${H}/pack/${name}/package/package.json`, `{"name":"${name}","version":"1.0.0","main":"index.js"}`);
      fs.writeFileSync(`${H}/pack/${name}/package/index.js`, `module.exports = '${name}';`);
      assert.equal((await new Promise((resolve) => childProcess.exec(`tar -czf ${H}/${name}.tgz -C ${H}/pack/${name} package`, (error) => resolve(error?.code ?? 0)))), 0);
    }
  }
  const steps = second ? [['add', `file:${H}/bye.tgz`], ['update', 'plugin']] : [['add', `file:${H}/hello.tgz`], ['add', `link:${H}/Documents/plugin`]];
  for (const step of steps) {
    const result = await pnpm(...step);
    assert.equal(result.code, 0, `${step.join(' ')}: ${result.out.slice(-400)}`);
  }
  assert.equal(createRequire(`${profile}/x.js`)('hello'), 'hello');
  assert.equal((await import(`${profile}/node_modules/plugin/index.mjs`)).where, `file://${H}/Documents/plugin/index.mjs`);
  assert.match(fs.readFileSync(`${profile}/node_modules/.modules.yaml`, 'utf8'), /"storeDir": "\/home\/dsh\//);
  if (second) assert.equal(createRequire(`${profile}/x.js`)('bye'), 'bye');
});
await check('nothing on disk names a real path', () => {
  assert.deepEqual(scan(H), { hits: [], links: 0 });
});
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
