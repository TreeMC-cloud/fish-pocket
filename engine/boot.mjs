// The DSH engine, in the worker main.mjs runs (and replaces to restart it).
// main.mjs has prepared the directories, environment and working directory;
// here the iOS runtime adaptations are installed and `dsh web` boots with
// the iOS overlay.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installChildProcess } from './runtime/child-process.mjs';
import { installModuleRedirects } from './runtime/module-redirects.mjs';
import { installWorkerDefaults } from './runtime/worker-defaults.mjs';
import { installSegmenter } from './runtime/intl-segmenter.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.DSH_IOS_PORT ?? '3080';

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
  '--no-open', '--host', '127.0.0.1', '--port', port,
];
// bin.js only self-runs as the main module; here it is imported.
const { runCli } = await import(pathToFileURL(process.argv[1]).href);
await runCli();
