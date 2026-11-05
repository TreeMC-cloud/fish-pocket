// The DSH engine, in the worker main.mjs runs (and replaces to restart it).
// main.mjs has prepared the directories, environment and working directory;
// here the iOS runtime adaptations are installed and `dsh web` boots with
// the iOS overlay.
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installChildProcess } from './runtime/child-process.mjs';
import { installModuleRedirects } from './runtime/module-redirects.mjs';
import { installWorkerDefaults } from './runtime/worker-defaults.mjs';
import { installSegmenter } from './runtime/intl-segmenter.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/// Whether 127.0.0.1:`port` can be bound right now.
function free(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/// The port `dsh web` listens on. Anything else on the phone may already hold the
/// one we want — a proxy app, most often — and the webserver plugin is required, so
/// failing to bind takes the whole engine down and main.mjs restarts it into the
/// same wall forever: the app then never leaves its launch screen, and reinstalling
/// does not help, because the port belongs to something else. So walk up to one that
/// is free, the usual one first. Little rides on which one it lands on: the native
/// interface is an HTTP client of this server whatever the number, and its state is
/// the engine's or UserDefaults', neither of them scoped to an origin. A move costs
/// the one web view that keeps browser storage, the 网页版 fallback, and it moves the
/// address in engine.log. Trying the usual port first is mostly for the line it writes
/// when that fails: `port N is taken` is the only account anyone ever gets of a
/// conflict, and a conflict is what used to kill the engine here. Something could
/// still take the port between this probe and the bind, which is what main.mjs's
/// restart is for: it probes again.
async function pick(first) {
  for (let port = first; port < first + 16; port += 1) if (await free(port)) return port;
  // Every one of them taken: let the OS name one. That web view then starts empty every
  // launch and the logged address never settles, which is worse to diagnose — but still
  // a working app, which is more than a launch screen forever.
  return 0;
}

const preferred = Number(process.env.DSH_IOS_PORT ?? 3080);
const port = await pick(preferred);
if (port !== preferred) console.log(`[dsh-ios] port ${preferred} is taken; listening on ${port || 'a port the OS picks'}`);

// small-icu: the native Intl.Segmenter crashes the app (runtime/intl-segmenter.mjs).
installSegmenter();
installWorkerDefaults();
// No processes on iOS: child_process runs node/pnpm as worker threads and
// everything else through the in-process shell (runtime/).
installChildProcess();
// Native addons the engine imports (e.g. flock) resolve to JS stand-ins.
installModuleRedirects();

if (process.env.DSH_IOS_DEBUG === '1') {
  const { startDebugInbox } = await import('./runtime/debug-inbox.mjs');
  startDebugInbox(path.join(process.env.DSH_IOS_DATA, 'debug'));
}

process.on('uncaughtException', (error) => console.error('[dsh-ios] uncaught', error));
process.on('unhandledRejection', (error) => console.error('[dsh-ios] unhandled rejection', error));

process.argv = [
  process.execPath,
  path.join(here, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
  'web',
  '--patch', path.join(here, 'ios.patch.yml'),
  // argv is strings; `pick` returns a number.
  '--no-open', '--host', '127.0.0.1', '--port', String(port),
];
// bin.js only self-runs as the main module; here it is imported.
const { runCli } = await import(pathToFileURL(process.argv[1]).href);
await runCli();
