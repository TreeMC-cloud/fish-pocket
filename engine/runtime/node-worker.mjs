// Start an emulated Node child (see worker-main.mjs) from a node-style argv.
import { PassThrough, Writable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PRELOAD } from './real-paths.mjs';

const require = createRequire(import.meta.url);
const MAIN = new URL('./worker-main.mjs', import.meta.url);

/** Package-manager CLIs that are JavaScript and therefore runnable as Node children. */
// pnpm exports only its package.json, which locates the package directory.
const pnpmBin = (name) => path.join(path.dirname(require.resolve('pnpm')), 'bin', name);
export const NODE_CLIS = {
  pnpm: () => pnpmBin('pnpm.mjs'),
  pnpx: () => pnpmBin('pnpx.mjs'),
};

// Node options that take a value; everything else starting with '-' is a flag.
const VALUED = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--conditions', '-C', '--input-type', '--title', '--env-file']);

/**
 * Parse `node [options] [script | -e code | -p code] [args...]`.
 * @returns {{ script?: string, code?: string, print?: boolean, args: string[], version?: boolean }}
 */
export function parseNodeArgv(args, cwd) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-v' || arg === '--version') return { version: true, args: [] };
    if (arg === '-e' || arg === '--eval' || arg === '-p' || arg === '--print') {
      return { code: args[i + 1] ?? '', print: arg === '-p' || arg === '--print', args: args.slice(i + 2) };
    }
    if (arg === '--') return { script: path.resolve(cwd, args[i + 1]), args: args.slice(i + 2) };
    if (arg.startsWith('-')) { if (VALUED.has(arg)) i++; continue; }
    return { script: path.resolve(cwd, arg), args: args.slice(i + 1) };
  }
  return { args: [] };
}

/**
 * Run one emulated Node child.
 * @param {object} spec - { script | code (+print), args, cwd, env, stdin: boolean, ipc: boolean }
 * @returns {{ worker: Worker, stdin?: import('node:stream').Writable, stdout, stderr, exited: Promise<number> }}
 */
export function startNodeWorker({ script, code, print, args = [], cwd, env, stdin = false, ipc = false }) {
  const worker = new Worker(MAIN, {
    workerData: { script, code, print, cwd, ipc, stdin },
    // process.argv is [execPath, <worker entry>, ...argv]; worker-main puts the script at [1].
    argv: args,
    env: { ...(env ?? process.env) },
    stdout: true,
    stderr: true,
    execArgv: PRELOAD,
    // Node's per-worker fd bookkeeping misreads module-loader fds on iOS and
    // floods stderr with "unmanaged mode" warnings; the worker owns no fds we close.
    trackUnmanagedFds: false,
  });
  // Our own stderr, so a failure to start (e.g. a missing script) is reported
  // the way a real child would print it.
  const stderr = new PassThrough();
  worker.stderr.pipe(stderr, { end: false });
  const workerStderrEnded = new Promise((resolve) => worker.stderr.once('end', resolve));
  const exited = new Promise((resolve) => {
    let failed = false;
    worker.on('error', (error) => { failed = true; stderr.write(`${error?.stack ?? error}\n`); });
    worker.on('exit', async (exitCode) => {
      await Promise.race([workerStderrEnded, new Promise((r) => setTimeout(r, 50))]);
      stderr.end();
      resolve(failed && exitCode === 0 ? 1 : exitCode ?? 1);
    });
  });
  // stdin travels over the worker port (see worker-main.mjs): Node's own
  // worker stdin keeps the thread alive even when the script never reads it.
  const input = stdin ? new Writable({
    write(chunk, _encoding, callback) { try { worker.postMessage({ stdin: Buffer.from(chunk) }); } catch {} callback(); },
    final(callback) { try { worker.postMessage({ stdinEnd: true }); } catch {} callback(); },
  }) : undefined;
  return { worker, stdin: input, stdout: worker.stdout, stderr, exited };
}
