// Engine side of the iOS host. Some plugin changes only apply when DSH starts
// (the plugin manager answers `restart-required`); a desktop user restarts
// the process, which an iOS app cannot do. Here the engine asks main.mjs to
// replace its worker instead — once no agent is running, so no turn is cut off.
import { parentPort } from 'node:worker_threads';

/**
 * Debounced restart request: waits `settleMs` so the change's RPC answer
 * reaches the client, then polls until `isBusy()` is false and calls
 * `notify(reason)` once.
 */
export function createRestartRequester({ isBusy, notify, settleMs = 1500, pollMs = 2000 }) {
  let pending;
  return {
    request(reason) {
      if (pending !== undefined) return;
      const attempt = () => {
        if (isBusy()) {
          pending = setTimeout(attempt, pollMs);
          return;
        }
        notify(reason);
      };
      pending = setTimeout(attempt, settleMs);
    },
    cancel() { clearTimeout(pending); },
  };
}

export default class IosHost {
  static inject = ['pluginManager', 'agents'];

  constructor(ctx) {
    ctx.effect(() => {
      const manager = ctx.pluginManager;
      const change = manager.change;
      const restarter = createRestartRequester({
        isBusy: () => ctx.agents.list().some((agent) => agent.status === 'running'),
        notify: (reason) => {
          ctx.logger.info('restarting the engine to apply plugin changes (%s)', reason);
          parentPort?.postMessage({ type: 'dsh-ios/restart', reason });
        },
      });
      // Every install, removal and enable/disable settles through change().
      manager.change = async function (...args) {
        const result = await change.apply(this, args);
        if (result?.application === 'restart-required') restarter.request(result.restartReason ?? 'restart-required');
        return result;
      };
      return () => {
        manager.change = change;
        restarter.cancel();
      };
    }, 'ios-host restart on plugin changes');
  }
}
