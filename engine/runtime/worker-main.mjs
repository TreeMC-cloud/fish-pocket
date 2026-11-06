// Entry of every emulated Node child: a worker thread standing in for a
// process (iOS cannot spawn one). Workers cannot chdir, so the working
// directory is emulated per worker (worker-cwd.mjs).
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { installChildProcess } from './child-process.mjs';
import { emulateCwd } from './worker-cwd.mjs';
import { installWorkerDefaults } from './worker-defaults.mjs';
import { installSegmenter } from './intl-segmenter.mjs';
import { installTextDecoder } from './text-decoder.mjs';

/**
 * The file `node <script>` runs: the CLI finds it as require() does, so
 * `node scripts/postinstall` reaches postinstall.js, while import() takes a path
 * literally. A script that cannot be found is left to import() to report.
 */
function entryOf(script) {
  try { return createRequire(script).resolve(script); } catch { return script; }
}

emulateCwd(workerData.cwd);
process.argv[1] = workerData.script ?? '[eval]';

// The parent's messages: stdin chunks and fork() IPC. The port only keeps
// this thread alive while there is a reason to wait on it — IPC is
// connected, or the script is actually reading stdin — so a script that
// never touches stdin exits when its own work is done, like a process.
let stdin;
if (workerData.stdin) {
  stdin = new Readable({ read() { parentPort.ref(); } });
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
}
parentPort.on('message', (data) => {
  if (data?.stdin !== undefined) stdin?.push(Buffer.from(data.stdin));
  else if (data?.stdinEnd) { stdin?.push(null); if (!workerData.ipc) parentPort.unref(); }
  else if (data && 'ipc' in data) process.emit('message', data.ipc);
});
if (workerData.ipc) {
  process.send = (message, ...rest) => { parentPort.postMessage({ ipc: message }); rest.find((a) => typeof a === 'function')?.(null); return true; };
  process.connected = true;
} else {
  parentPort.unref();
}
installSegmenter();
installTextDecoder();
// Children of this child go through the same emulation.
installWorkerDefaults();
installChildProcess();

if (workerData.script !== undefined) {
  await import(pathToFileURL(entryOf(workerData.script)).href);
} else {
  const filename = path.join(process.cwd(), '[eval]');
  const require = createRequire(filename);
  const module = { exports: {}, require, filename, id: '[eval]' };
  // eslint-disable-next-line no-new-func
  const run = new Function('require', 'module', 'exports', '__filename', '__dirname', workerData.print ? `return (${workerData.code}\n)` : workerData.code);
  const value = await run(require, module, module.exports, filename, process.cwd());
  if (workerData.print) console.log(value);
}
