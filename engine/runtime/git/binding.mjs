// The dsh_git addon (native/git): linked into the iOS app and reached through
// process._linkedBinding; on a development machine, the host build from
// scripts/build-git-addon.sh (or DSH_GIT_ADDON). Null when neither exists, in
// which case `git` is simply not a command of the execution world.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HOST_BUILD = fileURLToPath(new URL('../../../vendor/libgit2/macos/dsh_git.node', import.meta.url));

let cached;

export function binding() {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    cached = process._linkedBinding('dsh_git');
  } catch {
    const file = process.env.DSH_GIT_ADDON || HOST_BUILD;
    if (fs.existsSync(file)) cached = createRequire(import.meta.url)(file);
  }
  cached?.configure({ home: process.env.HOME });
  return cached;
}

/** Point ~/.gitconfig at another home (tests). */
export function configureHome(home) {
  binding()?.configure({ home });
}
