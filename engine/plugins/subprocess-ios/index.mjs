// ctx.subprocess for iOS: there is no fork/exec, so every "process" runs in
// this Node process. Shell scripts and Unix commands go through just-bash (a
// bash interpreter written in TypeScript) over the real filesystem; commands
// that just start a Node program (node, pnpm, npx, .bin shims — see
// runtime/direct.mjs) run as worker threads with streamed output, so dev
// servers and other long runners show their output while they run. The
// service contract is the one documented in
// @deepseek-ai/dsh-subprocess; providers own their signalling limits, and
// ours are: terminate aborts the script, there are no process groups.
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import {
  SubprocessRuntime,
  SubprocessExecutableNotFoundError,
  scrubbedParentEnv,
} from '@deepseek-ai/dsh-subprocess';
import { CONFINE } from '../sandbox-ios/index.mjs';
import { BIN, COMMANDS, planArgv, shell, stringEnv } from '../../runtime/shell.mjs';
import { planDirect } from '../../runtime/direct.mjs';
import { startNodeWorker } from '../../runtime/node-worker.mjs';

/** Offset-addressed tail buffer with the collect-mode reader contract. */
class Collector {
  chunks = [];
  bytes = 0;
  total = 0;
  constructor(maxBytes) { this.maxBytes = Math.max(0, maxBytes ?? 0); }
  push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (buf.length === 0) return;
    this.chunks.push(buf);
    this.bytes += buf.length;
    this.total += buf.length;
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const over = this.bytes - this.maxBytes;
      const head = this.chunks[0];
      if (head.length <= over) { this.chunks.shift(); this.bytes -= head.length; }
      else { this.chunks[0] = head.subarray(over); this.bytes -= over; }
    }
  }
  readFrom(fromByte) {
    const windowStart = this.total - this.bytes;
    const buffer = Buffer.concat(this.chunks);
    const lossy = fromByte < windowStart;
    return {
      text: (lossy ? buffer : buffer.subarray(Math.max(0, fromByte - windowStart))).toString('utf8'),
      nextOffset: this.total,
      lossy,
    };
  }
}

/** Where one output stream goes: a caller-owned pipe, our collector, or our own stdio. */
function outputSink(mode, inherit) {
  if (mode === 'pipe') {
    const stream = new PassThrough();
    return { stream, write: (b) => stream.write(b), end: () => stream.end() };
  }
  if (mode === 'inherit') return { write: (b) => inherit.write(b), end() {} };
  const collector = new Collector(mode.maxBytes);
  return { collector, write: (b) => collector.push(b), end() {} };
}

function readStdin(mode) {
  if (mode === 'ignore') return { text: Promise.resolve('') };
  if (typeof mode === 'object') return { text: Promise.resolve(mode.data) };
  const stream = new PassThrough();
  const parts = [];
  stream.on('data', (c) => parts.push(c));
  return { stream, text: new Promise((resolve) => stream.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))) };
}

export class IosSubprocessRuntime extends SubprocessRuntime {
  running = new Set();

  constructor(ctx) {
    super(ctx);
    // Disposal terminates every still-running command and awaits it (service contract).
    ctx.effect(() => () => this.disposeAll(), 'ios subprocess teardown');
  }

  async disposeAll() {
    const all = [...this.running];
    for (const handle of all) handle.terminate();
    await Promise.allSettled(all.map((h) => h.done));
  }

  async resolveExecutable(command, env) {
    const name = path.basename(command);
    if (command.includes('/') && !path.isAbsolute(command)) {
      throw new SubprocessExecutableNotFoundError(`relative executable path is not supported: ${command}`);
    }
    if (COMMANDS.has(name)) return `${BIN}/${name}`;
    if (path.isAbsolute(command) && fs.existsSync(command)) return command;
    throw new SubprocessExecutableNotFoundError(`${name}: command not found on iOS (in-process shell)`);
  }

  async terminalEnvironment() {
    return { platform: 'posix', defaultShell: `${BIN}/bash` };
  }

  /** Turn an argv into one just-bash invocation. */
  plan(argv) {
    if (argv[0] === CONFINE) {
      const end = argv.indexOf('--');
      const writable = [];
      for (let i = 1; i < end; i += 2) if (argv[i] === '--write') writable.push(argv[i + 1]);
      return { ...this.plan(argv.slice(end + 1)), writable };
    }
    return planArgv(argv, (file) => fs.readFileSync(file, 'utf8'));
  }

  spawn(spec) {
    if (spec.signal?.aborted) throw spec.signal.reason ?? new Error('aborted');
    if (!Array.isArray(spec.argv) || spec.argv.length === 0) throw new TypeError('argv must be a non-empty array');
    const plan = this.plan(spec.argv);
    const env = stringEnv({ ...scrubbedParentEnv(), ...spec.env });
    // Confinement fences the interpreter's filesystem; a Node worker runs
    // outside it either way (sandbox-ios reports enforcement as partial).
    const direct = planDirect(spec.argv[0] === CONFINE ? spec.argv.slice(spec.argv.indexOf('--') + 1) : spec.argv, { cwd: spec.cwd, env });
    const stdin = readStdin(spec.stdio.stdin);
    const out = outputSink(spec.stdio.stdout, process.stdout);
    const err = outputSink(spec.stdio.stderr, process.stderr);
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    spec.signal?.addEventListener('abort', onAbort, { once: true });

    const done = direct ? this.runDirect(direct, spec, stdin, out, err, abort.signal).finally(() => spec.signal?.removeEventListener('abort', onAbort)) : (async () => {
      const input = await stdin.text;
      try {
        const result = await shell(plan.writable).exec(plan.scriptFromStdin ? input : plan.script, {
          ...(plan.args ? { args: plan.args } : {}),
          ...(plan.scriptFromStdin ? {} : { stdin: input }),
          cwd: spec.cwd,
          env,
          replaceEnv: true,
          rawScript: true,
          signal: abort.signal,
        });
        out.write(Buffer.from(result.stdout ?? ''));
        err.write(Buffer.from(result.stderr ?? ''));
        return abort.signal.aborted ? { exitCode: null, signal: 'SIGTERM' } : { exitCode: result.exitCode, signal: null };
      } catch (error) {
        err.write(Buffer.from(`${error?.message ?? error}\n`));
        return abort.signal.aborted ? { exitCode: null, signal: 'SIGTERM' } : { exitCode: 127, signal: null };
      } finally {
        out.end();
        err.end();
        spec.signal?.removeEventListener('abort', onAbort);
      }
    })();

    const handle = {
      stdin: stdin.stream,
      stdout: out.stream,
      stderr: err.stream,
      control: undefined,
      collected: {
        ...(out.collector ? { stdout: out.collector } : {}),
        ...(err.collector ? { stderr: err.collector } : {}),
      },
      done,
      terminate: () => abort.abort(),
      waitForExit: (signal) => new Promise((resolve) => {
        if (signal?.aborted) return resolve(false);
        const onStop = () => resolve(false);
        signal?.addEventListener('abort', onStop, { once: true });
        done.finally(() => { signal?.removeEventListener('abort', onStop); resolve(true); });
      }),
    };
    this.running.add(handle);
    done.finally(() => this.running.delete(handle));
    return handle;
  }

  /** Run a planned Node program as a worker, streaming its output into the sinks. */
  async runDirect(direct, spec, stdin, out, err, signal) {
    if (direct.version) {
      out.write(Buffer.from(`${process.version}\n`));
      out.end();
      err.end();
      return { exitCode: 0, signal: null };
    }
    const child = startNodeWorker({ ...direct, cwd: spec.cwd, env: direct.env, stdin: true });
    if (stdin.stream) stdin.stream.pipe(child.stdin);
    else child.stdin.end(typeof spec.stdio.stdin === 'object' ? spec.stdio.stdin.data : undefined);
    const drained = Promise.all([child.stdout, child.stderr].map((stream) => new Promise((resolve) => stream.once('end', resolve))));
    child.stdout.on('data', (chunk) => out.write(chunk));
    child.stderr.on('data', (chunk) => err.write(chunk));
    const stop = () => child.worker.terminate();
    signal.addEventListener('abort', stop, { once: true });
    const code = await child.exited;
    await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, 100))]);
    signal.removeEventListener('abort', stop);
    out.end();
    err.end();
    return signal.aborted ? { exitCode: null, signal: 'SIGTERM' } : { exitCode: code, signal: null };
  }

  /** A line-editing terminal whose lines run through just-bash, keeping cwd and exported variables between lines. */
  async spawnTerminal(spec) {
    const output = new PassThrough();
    let cwd = spec.cwd;
    let env = stringEnv({ ...scrubbedParentEnv(), ...spec.env });
    let line = '';
    let current;
    let revision = 0;
    let closed = false;
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const prompt = () => output.write(`\x1b[32m${path.basename(cwd) || '/'}\x1b[0m $ `);
    const close = (outcome) => {
      if (closed) return;
      closed = true;
      current?.abort();
      output.end();
      resolveDone(outcome);
    };
    spec.signal?.addEventListener('abort', () => close({ exitCode: null, signal: 'SIGHUP' }), { once: true });
    prompt();

    const run = async (text) => {
      if (text.trim() === 'exit') return close({ exitCode: 0, signal: null });
      current = new AbortController();
      revision++;
      try {
        const result = await shell().exec(`${text}\nprintf '\\0%s' "$PWD"`, { cwd, env, replaceEnv: true, signal: current.signal });
        const marker = result.stdout.lastIndexOf('\0');
        const shown = marker >= 0 ? result.stdout.slice(0, marker) : result.stdout;
        // just-bash reports PWD without its leading slash when rooted at /.
        if (marker >= 0) cwd = path.resolve('/', result.stdout.slice(marker + 1) || cwd);
        if (result.env) env = result.env;
        output.write((shown + result.stderr).replaceAll('\n', '\r\n'));
      } catch (error) {
        output.write(`${error?.message ?? error}\r\n`);
      }
      current = undefined;
      revision++;
      if (!closed) prompt();
    };

    return {
      pid: 1,
      output,
      done,
      async write(data) {
        for (const ch of data) {
          if (current) { if (ch === '\x03') current.abort(); continue; }
          if (ch === '\r' || ch === '\n') { output.write('\r\n'); const text = line; line = ''; if (text.trim()) void run(text); else prompt(); }
          else if (ch === '\x7f' || ch === '\b') { if (line) { line = line.slice(0, -1); output.write('\b \b'); } }
          else if (ch === '\x03') { line = ''; output.write('^C\r\n'); prompt(); }
          else if (ch === '\x04') { if (!line) close({ exitCode: 0, signal: null }); }
          else if (ch >= ' ') { line += ch; output.write(ch); }
        }
      },
      async resize() {},
      async inspectForeground() { return current ? { processGroupId: 1, inputWaiting: false } : undefined; },
      async inspectActivity() { return { state: current ? 'busy' : 'idle', revision }; },
      async signalForeground(signal) { if (current) { current.abort(); return 1; } return 0; },
      async terminate() { close({ exitCode: null, signal: 'SIGTERM' }); await done; },
    };
  }
}

export default IosSubprocessRuntime;
