// On iOS, Node's per-worker fd bookkeeping prints "opened in unmanaged mode
// twice" / "closed but not opened" warnings for every worker, flooding the
// engine's stderr and any captured child output. Workers created by the engine
// and by plugins get the bookkeeping off by default; an explicit option wins.
import workerThreads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { PRELOAD } from './real-paths.mjs';

let installed = false;
export function installWorkerDefaults() {
  if (installed) return;
  installed = true;
  const Base = workerThreads.Worker;
  workerThreads.Worker = class Worker extends Base {
    constructor(filename, options) {
      // A worker inherits execArgv, preload included; a given one replaces it.
      const execArgv = options?.execArgv && { execArgv: [...PRELOAD, ...options.execArgv] };
      super(filename, { trackUnmanagedFds: false, ...options, ...execArgv });
    }
  };
  syncBuiltinESMExports();
}
