// Runs the commands behind the emulated spawnSync (child-process.mjs) for one
// thread. That thread blocks in Atomics.wait while the command runs here
// through the asynchronous emulation, then reads the result from its port.
import { parentPort } from 'node:worker_threads';
import { spawn } from './child-process.mjs';

parentPort.on('message', ({ request, port, flag }) => {
  const finish = (result) => {
    port.postMessage(result);
    port.close();
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  };
  const { file, args, options, input, timeout, killSignal, maxBuffer } = request;
  const chunks = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };
  let error;
  let timer;
  let child;
  try {
    child = spawn(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (cause) {
    finish({ error: { message: cause.message, code: cause.code }, status: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    return;
  }
  for (const name of ['stdout', 'stderr']) {
    child[name].on('data', (chunk) => {
      sizes[name] += chunk.length;
      if (sizes[name] > maxBuffer) {
        error ??= { message: `spawnSync ${file} ENOBUFS`, code: 'ENOBUFS' };
        child.kill(killSignal);
        return;
      }
      chunks[name].push(Buffer.from(chunk));
    });
  }
  if (timeout > 0) {
    timer = setTimeout(() => {
      error ??= { message: `spawnSync ${file} ETIMEDOUT`, code: 'ETIMEDOUT' };
      child.kill(killSignal);
    }, timeout);
  }
  child.on('error', (cause) => { error ??= { message: cause.message, code: cause.code, errno: cause.errno, syscall: cause.syscall, path: cause.path }; });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    finish({
      error,
      status: code === -2 ? null : code,
      signal,
      pid: child.pid,
      stdout: Buffer.concat(chunks.stdout),
      stderr: Buffer.concat(chunks.stderr),
    });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input ?? undefined);
});
