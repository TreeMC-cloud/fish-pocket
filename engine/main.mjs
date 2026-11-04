// Node entry for the iOS host (also runnable on a desktop Node for testing).
// The host starts Node with this file inside the engine's filesystem view
// (native/root) and passes DSH_IOS_HOME and DSH_IOS_DATA, a directory the two
// share. We lay out DSH_HOME/HOME/TMPDIR and run the DSH engine (boot.mjs) in a
// worker thread, publishing its web URL (it carries the access token) to a 0600
// file the host polls.
//
// The worker is what makes "restart DSH" possible: iOS starts Node once per
// process and an app cannot relaunch itself, yet some plugin changes only
// apply at startup. Replacing the worker gives the engine a new isolate and a
// fresh module cache in the same process, on the same port. The engine asks
// for it (plugins/ios-host) and we also restart it if it dies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { PRELOAD } from './runtime/real-paths.mjs';

const data = process.env.DSH_IOS_DATA;
if (!data) throw new Error('DSH_IOS_DATA is not set');
// Set by the iOS host. Without it (a desktop run) everything stays below `data`.
const home = process.env.DSH_IOS_HOME;
const dirs = home
  ? { DSH_HOME: path.join(home, '.dsh'), HOME: home, TMPDIR: '/tmp', workspace: path.join(home, 'workspace') }
  : { DSH_HOME: path.join(data, 'dsh'), HOME: path.join(data, 'home'), TMPDIR: path.join(data, 'tmp'), workspace: path.join(data, 'workspace') };
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

// The engine's environment, not this thread's: that one is the process's, and
// the system frameworks in the process read HOME and TMPDIR, which stay real.
const env = {
  ...process.env,
  DSH_HOME: dirs.DSH_HOME,
  HOME: dirs.HOME,
  TMPDIR: dirs.TMPDIR,
  // The first-use workspace goes under this directory (see ios.patch.yml).
  DSH_IOS_DOCUMENTS: process.env.DSH_IOS_DOCUMENTS ?? path.join(data, 'documents'),
  // Skills that ship with the app, ios-environment among them (dsh-skill-filesystem's bundled root).
  DSH_BUNDLED_SKILL_DIR: path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills'),
  SHELL: process.env.SHELL ?? '/bin/bash',
  // Commands resolve inside the in-process shell, whose binaries live in /bin;
  // the OS PATH (simulator runtime dirs, /usr/bin on device) means nothing there.
  PATH: '/bin:/usr/bin',
  // No terminal to answer prompts: pnpm would otherwise stop and ask before
  // purging a node_modules it wants to rebuild.
  pnpm_config_confirm_modules_purge: process.env.pnpm_config_confirm_modules_purge ?? 'false',
};
// iOS sets this to the real container, and nothing in the engine needs it.
delete env.CFFIXED_USER_HOME;
// Workers cannot chdir; the engine inherits the process working directory.
process.chdir(dirs.workspace);

const urlFile = path.join(data, 'web-url');
const log = fs.createWriteStream(path.join(data, 'engine.log'), { flags: 'a', mode: 0o600 });
const redact = (text) => text.replace(/token=[A-Za-z0-9_-]+/g, 'token=…');
let published = false;
// Worker output reaches the process through these streams, so the tee sees both.
for (const name of ['stdout', 'stderr']) {
  const stream = process[name];
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    log.write(redact(text));
    const match = !published && /dsh web: (http:\/\/\S+)/.exec(text);
    if (match) {
      published = true;
      fs.writeFileSync(`${urlFile}.tmp`, match[1], { mode: 0o600 });
      fs.renameSync(`${urlFile}.tmp`, urlFile);
    }
    return write(redact(text), ...rest);
  };
}
const jitless = String(process.config.variables.node_v8_options ?? '').includes('--jitless') || process.execArgv.includes('--jitless');
console.log(`[dsh-ios] node ${process.version} ${process.platform}/${process.arch} jitless=${jitless} data=${data}`);

let engine;
let restarting = false;
let crashes = 0;

function start() {
  fs.rmSync(urlFile, { force: true });
  published = false;
  const startedAt = Date.now();
  engine = new Worker(new URL('./boot.mjs', import.meta.url), {
    env,
    // Engine boot reads Node's module loader internals (see shims/).
    execArgv: [...PRELOAD, '--expose-internals'],
    trackUnmanagedFds: false,
  });
  engine.on('message', (message) => {
    if (message?.type === 'dsh-ios/restart') void restart(message.reason);
  });
  engine.on('error', (error) => console.error('[dsh-ios] engine error', error));
  engine.on('exit', (code) => {
    if (restarting) return;
    // Unexpected exit: back off while it keeps failing early, then try again.
    crashes = Date.now() - startedAt > 60_000 ? 1 : crashes + 1;
    const delay = Math.min(30_000, 1000 * 2 ** (crashes - 1));
    console.error(`[dsh-ios] engine exited (${code}); restarting in ${delay} ms`);
    setTimeout(start, delay);
  });
}

async function restart(reason) {
  if (restarting) return;
  restarting = true;
  console.log(`[dsh-ios] restarting engine${reason ? ` (${reason})` : ''}`);
  await engine.terminate();
  restarting = false;
  start();
}

start();
