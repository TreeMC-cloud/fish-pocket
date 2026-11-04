// node:child_process for a platform without processes. iOS forbids fork/exec,
// so the async APIs (spawn, execFile, exec, fork) are re-implemented on the
// in-process execution world: JavaScript programs (node, pnpm, npx, `#!…node`
// scripts, .bin shims — see direct.mjs) run as worker threads, everything
// else through just-bash. The
// returned objects are ChildProcess instances with the usual streams and
// events, so execa, cross-spawn and plugins' own spawns keep working. The
// *Sync variants run the same emulation on a helper thread (sync-helper.mjs)
// while the calling thread blocks in Atomics.wait.
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { EventEmitter } from 'node:events';
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import { PassThrough, Writable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { parseNodeArgv, startNodeWorker } from './node-worker.mjs';
import { planDirect } from './direct.mjs';
import { COMMANDS, planArgv, shell, stringEnv } from './shell.mjs';

let nextPid = 10000;
// When a caller keeps stdin open without ending it, run a non-JS command with
// what arrived so far after this much quiet (most commands never read stdin).
const STDIN_SETTLE_MS = 100;

/** How a spawn will be served: a Node worker, the shell, or not at all. */
function route(file, args, options, env) {
  // Node itself under the app's executable name (process.execPath is the app on iOS).
  if (file === process.execPath) return { kind: 'node', ...parseNodeArgv(args, options.cwd) };
  // A command that is just "run this Node program" streams from a worker (direct.mjs).
  const direct = planDirect(options.shell ? ['sh', '-c', [file, ...args].join(' ')] : [file, ...args], { cwd: options.cwd, env });
  if (direct) return { kind: 'node', ...direct };
  if (options.shell) return { kind: 'shell', plan: { script: [file, ...args].join(' ') } };
  if (COMMANDS.has(path.basename(file))) return { kind: 'shell', plan: planArgv([file, ...args], (f) => fs.readFileSync(path.resolve(options.cwd, f), 'utf8')) };
  return { kind: 'missing' };
}

function normalizeStdio(stdio) {
  const all = typeof stdio === 'string' ? [stdio, stdio, stdio] : [...(stdio ?? [])];
  return [0, 1, 2].map((i) => {
    const value = all[i] ?? 'pipe';
    if (value === 'pipe' || value === 'overlapped') return 'pipe';
    if (value === 'inherit' || value === i) return 'inherit';
    // An open file descriptor (or a stream holding one): output is written to it.
    const fd = typeof value === 'number' ? value : value?.fd;
    if (i > 0 && Number.isInteger(fd) && fd >= 0) return { fd };
    return 'ignore';
  });
}

/**
 * A real child inherits copies of the descriptors it is given, so callers
 * close theirs right after spawning (Claude Code's Bash tool does). Keep our
 * own copies: on Darwin opening /dev/fd/N duplicates N. Returns the copies to
 * close when the child is done.
 */
function holdDescriptors(stdio) {
  const copies = new Map();
  for (const entry of stdio) {
    if (entry?.fd === undefined) continue;
    if (!copies.has(entry.fd)) {
      let copy = entry.fd;
      try { copy = fs.openSync(`/dev/fd/${entry.fd}`, fs.constants.O_WRONLY); } catch {}
      copies.set(entry.fd, copy);
    }
    entry.fd = copies.get(entry.fd);
  }
  return [...copies].filter(([fd, copy]) => fd !== copy).map(([, copy]) => copy);
}

/** Writes straight to a descriptor, so the bytes are there once the child exits. */
function fdSink(fd) {
  return new Writable({
    write(chunk, encoding, callback) {
      try { fs.writeSync(fd, chunk); callback(); } catch (error) { callback(error); }
    },
  });
}

function spawn(file, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  options = { ...options, cwd: options?.cwd ? path.resolve(String(options.cwd)) : process.cwd() };
  args = args.map(String);
  const stdio = normalizeStdio(options.stdio);
  const dups = holdDescriptors(stdio);
  const child = Object.create(cp.ChildProcess.prototype);
  EventEmitter.call(child);
  Object.assign(child, {
    pid: nextPid++, connected: false, killed: false, exitCode: null, signalCode: null,
    spawnfile: file, spawnargs: [file, ...args],
    stdin: stdio[0] === 'pipe' ? new PassThrough() : null,
    stdout: stdio[1] === 'pipe' ? new PassThrough() : null,
    stderr: stdio[2] === 'pipe' ? new PassThrough() : null,
  });
  child.stdio = [child.stdin, child.stdout, child.stderr];
  const sinks = [];
  const sink = (i) => {
    if (stdio[i] === 'pipe') return child.stdio[i];
    if (stdio[i] === 'inherit') return i === 1 ? process.stdout : process.stderr;
    if (stdio[i]?.fd !== undefined) return (sinks[i] ??= fdSink(stdio[i].fd));
    return null;
  };
  // Worker output still on its way to an fd sink when the worker exits.
  const draining = [];
  const env = stringEnv(options.env ?? process.env);
  const plan = route(file, args, options, env);
  // DSH_IOS_TRACE_SPAWN=1 prints each spawn and how it is served (debugging aid).
  if (process.env.DSH_IOS_TRACE_SPAWN === '1') process.stderr.write(`[spawn] ${plan.kind} ${JSON.stringify([file, ...args]).slice(0, 300)} shell=${Boolean(options.shell)}\n`);
  let stop = () => {};
  // fork(): messages sent before the worker starts are queued.
  const outbox = [];
  let postIpc = (message) => { outbox.push(message); };
  if (options.ipc) {
    child.connected = true;
    child.send = (message, ...rest) => { try { postIpc(message); } catch {} rest.find((a) => typeof a === 'function')?.(null); return true; };
    child.disconnect = () => { child.connected = false; child.emit('disconnect'); };
  }
  child.ref = () => {};
  child.unref = () => {};
  child.kill = (signal = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    child.killed = true;
    stop(signal);
    return true;
  };

  const finish = async (code, signal) => {
    await Promise.all(draining);
    for (const fd of dups) { try { fs.closeSync(fd); } catch {} }
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
    const open = [child.stdout, child.stderr].filter((s) => s && !s.readableEnded);
    for (const s of open) s.end();
    Promise.all(open.map((s) => new Promise((r) => { s.once('end', r); s.once('close', r); s.resume?.(); }))).then(() => child.emit('close', code, signal));
  };

  process.nextTick(() => {
    if (plan.kind === 'missing') {
      const error = Object.assign(new Error(`spawn ${file} ENOENT`), { errno: -2, code: 'ENOENT', syscall: `spawn ${file}`, path: file, spawnargs: args });
      child.emit('error', error);
      child.exitCode = -2;
      child.stdin?.destroy();
      child.stdout?.end();
      child.stderr?.end();
      child.emit('close', -2, null);
      return;
    }
    child.emit('spawn');
    if (plan.kind === 'node') runNode(plan);
    else runShell(plan.plan);
  });

  function runNode(parsed) {
    if (parsed.version) { sink(1)?.write(`${process.version}\n`); return finish(0, null); }
    const worker = startNodeWorker({ ...parsed, cwd: options.cwd, env: parsed.env ?? env, stdin: stdio[0] === 'pipe', ipc: options.ipc === true });
    if (options.ipc) {
      worker.worker.on('message', (data) => { if (data && 'ipc' in data) child.emit('message', data.ipc); });
      for (const message of outbox.splice(0)) worker.worker.postMessage({ ipc: message });
      postIpc = (message) => worker.worker.postMessage({ ipc: message });
    }
    if (child.stdin) child.stdin.pipe(worker.stdin);
    const out = sink(1);
    const err = sink(2);
    for (const [source, target] of [[worker.stdout, out], [worker.stderr, err]]) {
      if (target) source.pipe(target, { end: false }); else source.resume();
      if (target && target !== child.stdout && target !== child.stderr) draining.push(new Promise((r) => { source.once('end', r); source.once('close', r); }));
    }
    if (options.signal) options.signal.addEventListener('abort', () => child.kill(), { once: true });
    let killedWith = null;
    stop = (signal) => { killedWith = signal; worker.worker.terminate(); };
    worker.exited.then((code) => finish(killedWith ? null : code, killedWith));
  }

  async function runShell({ script, args: shellArgs, scriptFromStdin }) {
    const abort = new AbortController();
    let killedWith = null;
    stop = (signal) => { killedWith = signal; abort.abort(); };
    if (options.signal) options.signal.addEventListener('abort', () => child.kill(), { once: true });
    const input = await readStdin(child.stdin);
    let result;
    try {
      result = await shell().exec(scriptFromStdin ? input : script, {
        ...(shellArgs ? { args: shellArgs } : {}),
        ...(scriptFromStdin ? {} : { stdin: input }),
        cwd: options.cwd, env, replaceEnv: true, rawScript: true, signal: abort.signal,
      });
    } catch (error) {
      result = { stdout: '', stderr: `${error?.message ?? error}\n`, exitCode: 127 };
    }
    sink(1)?.write(result.stdout ?? '');
    sink(2)?.write(result.stderr ?? '');
    finish(killedWith ? null : result.exitCode, killedWith);
  }

  return child;
}

function readStdin(stream) {
  if (!stream) return Promise.resolve('');
  return new Promise((resolve) => {
    const parts = [];
    let timer;
    const done = () => { clearTimeout(timer); stream.removeAllListeners('data'); resolve(Buffer.concat(parts).toString('utf8')); };
    const settle = () => { clearTimeout(timer); timer = setTimeout(done, STDIN_SETTLE_MS); };
    stream.on('data', (chunk) => { parts.push(Buffer.from(chunk)); settle(); });
    stream.once('end', done);
    stream.once('finish', () => setImmediate(done));
    settle();
  });
}

function execFile(file, args, options, callback) {
  if (typeof args === 'function') { callback = args; args = []; options = {}; }
  else if (!Array.isArray(args)) { callback = options; options = args; args = []; }
  if (typeof options === 'function') { callback = options; options = {}; }
  options = { encoding: 'utf8', ...options };
  const child = spawn(file, args, options);
  const out = [];
  const err = [];
  child.stdout?.on('data', (c) => out.push(Buffer.from(c)));
  child.stderr?.on('data', (c) => err.push(Buffer.from(c)));
  const decode = (parts) => (options.encoding === 'buffer' ? Buffer.concat(parts) : Buffer.concat(parts).toString(options.encoding));
  let timer;
  if (options.timeout > 0) timer = setTimeout(() => child.kill(options.killSignal ?? 'SIGTERM'), options.timeout);
  const settle = (error, code, signal) => {
    clearTimeout(timer);
    const stdout = decode(out);
    const stderr = decode(err);
    const cmd = [file, ...args].join(' ');
    if (!error && (code !== 0 || signal)) {
      error = Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), { code, killed: child.killed, signal, cmd });
    }
    if (error) Object.assign(error, { stdout, stderr });
    callback?.(error ?? null, stdout, stderr);
  };
  child.once('error', (error) => settle(error, error.errno, null));
  child.once('close', (code, signal) => { if (code !== -2) settle(null, code, signal); });
  return child;
}

function exec(command, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  return execFile(command, [], { ...options, shell: true }, callback);
}

for (const fn of [execFile, exec]) {
  Object.defineProperty(fn, util.promisify.custom, {
    value: (...args) => {
      let child;
      const promise = new Promise((resolve, reject) => {
        child = fn(...args, (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })));
      });
      promise.child = child;
      return promise;
    },
  });
}

/** fork(): a Node worker with an IPC channel (process.send / 'message'). */
function fork(modulePath, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  return spawn(process.execPath, [String(modulePath), ...(args ?? [])], { ...options, stdio: options?.silent ? 'pipe' : 'inherit', ipc: true });
}

// One helper per thread, created on first use; unref'd so it never keeps the thread alive.
let helper;
function syncHelper() {
  if (helper) return helper;
  helper = new Worker(new URL('./sync-helper.mjs', import.meta.url), { execArgv: [] });
  helper.unref();
  helper.on('exit', () => { helper = undefined; });
  return helper;
}

const DEFAULT_MAX_BUFFER = 1024 * 1024;

/** spawnSync(): run the emulated spawn on the helper thread and block until it settles. */
function spawnSync(file, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  options = { ...options };
  const { input, timeout = 0, killSignal = 'SIGTERM', maxBuffer = DEFAULT_MAX_BUFFER, encoding = 'buffer' } = options;
  const request = {
    file: String(file),
    args: args.map(String),
    options: {
      cwd: options.cwd ? path.resolve(String(options.cwd)) : process.cwd(),
      env: stringEnv(options.env ?? process.env),
      shell: options.shell,
    },
    input: input === undefined ? undefined : typeof input === 'string' ? Buffer.from(input, options.encoding && options.encoding !== 'buffer' ? options.encoding : 'utf8') : Buffer.from(input),
    timeout, killSignal, maxBuffer,
  };
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  syncHelper().postMessage({ request, port: port2, flag }, [port2]);
  Atomics.wait(flag, 0, 0);
  const result = receiveMessageOnPort(port1).message;
  port1.close();
  const decode = (buffer) => (encoding && encoding !== 'buffer' ? Buffer.from(buffer).toString(encoding) : Buffer.from(buffer));
  const stdout = decode(result.stdout);
  const stderr = decode(result.stderr);
  // 'inherit' streams receive the output once the command has finished.
  const stdio = normalizeStdio(options.stdio);
  if (stdio[1] === 'inherit') process.stdout.write(result.stdout);
  if (stdio[2] === 'inherit') process.stderr.write(result.stderr);
  const out = {
    pid: result.pid ?? 0,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status: result.status,
    signal: result.signal,
  };
  if (result.error) {
    out.error = Object.assign(new Error(result.error.message), result.error, { spawnargs: request.args });
  }
  return out;
}

/** execFileSync(): stdout on success, or a thrown error carrying status/stdout/stderr — as Node does. */
function execFileSync(file, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  // Node defaults stderr to the parent's stderr for the exec*Sync family.
  const stdio = options?.stdio ?? ['pipe', 'pipe', 'inherit'];
  const result = spawnSync(file, args, { ...options, stdio });
  if (result.error) throw Object.assign(result.error, { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, output: result.output });
  if (result.status !== 0 || result.signal) {
    const command = [file, ...args].join(' ');
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString() : result.stderr;
    throw Object.assign(new Error(`Command failed: ${command}${stderr ? `\n${stderr}` : ''}`), {
      status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, output: result.output, pid: result.pid,
    });
  }
  return result.stdout;
}

function execSync(command, options) {
  return execFileSync(String(command), [], { ...options, shell: true });
}

let installed = false;
/** Replace child_process's APIs; ESM named imports see it through syncBuiltinESMExports. */
export function installChildProcess() {
  if (installed) return;
  installed = true;
  Object.assign(cp, { spawn, execFile, exec, fork, spawnSync, execFileSync, execSync });
  syncBuiltinESMExports();
}

export { spawn, execFile, exec, fork, spawnSync, execFileSync, execSync };
