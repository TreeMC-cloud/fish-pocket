// Engine side of the iOS host. Some plugin changes only apply when DSH starts
// (the plugin manager answers `restart-required`); a desktop user restarts
// the process, which an iOS app cannot do. Here the engine asks main.mjs to
// replace its worker instead — once no agent is running, so no turn is cut off.
//
// An install also stops at a build script the user cannot get past: one pnpm
// blocks, or one that fails here because iOS has no compiler or no build of the
// tool it downloads. The plugin manager can only allow scripts, and its RPC schema
// is generated upstream, so a refusal travels in `approvedBuilds` with a `!` prefix.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { parseDocument } from 'yaml';

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

/** `pkg` or `pkg@1.2.3`, without the version. */
const packageOf = (build) => build.replace(/(?<=.)@.*$/, '');

/**
 * Record in the profile's pnpm policy that these packages' build scripts stay
 * off, so pnpm installs them without running or blocking on them. A package's
 * existing keys are all turned off: an allowed `pkg@1.2.3` beats a refused `pkg`.
 * @param {string} dir - profile directory.
 * @param {string[]} builds - `pkg` or `pkg@version`, as the plugin manager names them.
 */
export async function refuseBuilds(dir, builds) {
  const file = path.join(dir, 'pnpm-workspace.yaml');
  const text = await readFile(file, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const document = parseDocument(text);
  if (document.errors[0] !== undefined) throw document.errors[0];
  const keys = document.get('allowBuilds')?.items?.map((item) => String(item.key?.value ?? item.key)) ?? [];
  for (const build of builds) {
    const name = packageOf(build);
    const held = keys.filter((key) => key === name || key.startsWith(`${name}@`));
    for (const key of held.length > 0 ? held : [build]) document.setIn(['allowBuilds', key], false);
  }
  await writeFileAtomic(file, String(document), { mode: 0o600 });
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
      const installBundle = manager.installBundle;
      manager.installBundle = function (spec, options) {
        const builds = options?.approvedBuilds ?? [];
        const refused = builds.filter((build) => build.startsWith('!')).map((build) => build.slice(1));
        if (refused.length === 0) return installBundle.call(this, spec, options);
        const approvedBuilds = builds.filter((build) => !build.startsWith('!'));
        return refuseBuilds(this.profile.dir, refused).then(() => installBundle.call(this, spec, { ...options, approvedBuilds }));
      };
      return () => {
        manager.change = change;
        manager.installBundle = installBundle;
        restarter.cancel();
      };
    }, 'ios-host restart on plugin changes');
  }
}
