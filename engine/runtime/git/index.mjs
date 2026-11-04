// `git` for the in-process execution world: git's command line over libgit2
// (native/git), registered as a just-bash command next to node, pnpm and rg.
// Every caller — the bash tool, ctx.subprocess users such as
// dsh-workspace-changes, and the child_process shim — reaches this one entry.
import path from 'node:path';
import { binding } from './binding.mjs';

export { configureHome } from './binding.mjs';
import { Exit, Git, OpError } from './core.mjs';
import branches from './commands/branches.mjs';
import history from './commands/history.mjs';
import plumbing from './commands/plumbing.mjs';
import remote from './commands/remote.mjs';
import worktree from './commands/worktree.mjs';

const VERSION = '2.47.0';

const COMMANDS = { ...worktree, ...history, ...branches, ...remote, ...plumbing };

const ALIASES = { stage: 'add' };

/** Commands git has that this one deliberately does not, with what to do instead. */
const MISSING = {
  rebase: 'use `git merge` (or `git pull --no-rebase`) instead',
  'cherry-pick': 'use `git show <commit> | git apply --index` and commit',
  revert: 'undo the change in the files and commit it',
  blame: 'use `git log -p -- <file>`',
  bisect: undefined, submodule: undefined, am: undefined, 'format-patch': undefined, 'filter-branch': undefined,
  notes: undefined, 'sparse-checkout': undefined, lfs: undefined, svn: undefined, 'send-email': undefined,
  'request-pull': undefined, daemon: undefined, 'update-index': undefined, 'read-tree': undefined, 'commit-tree': undefined,
  'update-ref': undefined, reflog: undefined, describe: undefined, grep: 'use `rg` (ripgrep)',
};

const HELP = `usage: git [-v | --version] [-h | --help] [-C <path>] [-c <name>=<value>]
           [--git-dir=<path>] [--work-tree=<path>] [--no-pager] [--literal-pathspecs]
           <command> [<args>]

git on iOS runs in-process on libgit2. Supported commands:

${Object.keys(COMMANDS).sort().join(' ')}

Remotes are HTTPS only. Credentials come from the URL, ~/.git-credentials
(https://user:token@host lines), or GH_TOKEN / GITHUB_TOKEN for github.com.
`;

export function gitAvailable() {
  return binding() !== null;
}

/**
 * Run one git command line.
 * @returns {{ stdout: string, stderr: string, exitCode: number }}
 */
export async function runGit(argv, io) {
  const git = new Git(io);
  let exitCode = 0;
  try {
    await dispatch(git, [...argv]);
  } catch (error) {
    if (error instanceof Exit) exitCode = error.exitCode;
    else if (error instanceof OpError) {
      git.warn(`fatal: ${error.message}\n`);
      exitCode = 128;
    } else {
      git.warn(`fatal: ${error?.stack ?? error}\n`);
      exitCode = 128;
    }
  }
  return { stdout: git.out.join(''), stderr: git.err.join(''), exitCode };
}

async function dispatch(git, argv) {
  // Global options before the subcommand.
  while (argv.length && argv[0].startsWith('-')) {
    const a = argv.shift();
    if (a === '-C') git.cwd = git.resolveCwd(argv.shift() ?? '.');
    else if (a === '-c') {
      const pair = argv.shift() ?? '';
      const eq = pair.indexOf('=');
      git.overrides.set((eq < 0 ? pair : pair.slice(0, eq)).toLowerCase(), eq < 0 ? 'true' : pair.slice(eq + 1));
    } else if (a === '--git-dir' || a.startsWith('--git-dir=')) git.gitDir = path.resolve(git.cwd, a.includes('=') ? a.slice(10) : argv.shift());
    else if (a === '--work-tree' || a.startsWith('--work-tree=')) git.workTree = path.resolve(git.cwd, a.includes('=') ? a.slice(12) : argv.shift());
    else if (a === '--literal-pathspecs') git.literal = true;
    else if (a === '-v' || a === '--version') argv.unshift('version');
    else if (a === '-h' || a === '--help') argv.unshift('help');
    else if (a === '--exec-path' || a.startsWith('--exec-path=')) {
      git.print('/bin\n');
      return;
    } else if (['--no-pager', '-P', '-p', '--paginate', '--no-replace-objects', '--no-optional-locks', '--bare', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-lazy-fetch', '--no-advice'].includes(a)) {
      // Nothing pages or locks optionally here.
    } else if (a === '--namespace' || a === '--config-env' || a === '--super-prefix') {
      argv.shift();
    } else if (a.startsWith('--namespace=') || a.startsWith('--config-env=')) {
      // ignored
    } else {
      git.usage(`unknown option: ${a}\n${HELP.split('\n\n')[0]}`);
    }
  }
  const [name, ...args] = argv;
  if (!name || name === 'help') {
    if (args[0] && COMMANDS[args[0]]) git.print(`git ${args[0]}: see https://git-scm.com/docs/git-${args[0]} (subset supported on iOS)\n`);
    else git.print(HELP);
    if (!name) throw new Exit(1);
    return;
  }
  if (name === 'version') {
    git.print(`git version ${VERSION} (libgit2 ${binding().libgit2}; DSH iOS)\n`);
    return;
  }
  if (name === 'gc' || name === 'maintenance' || name === 'prune' || name === 'fsck' || name === 'repack') return;
  if (name === 'var') {
    if (args[0] === 'GIT_AUTHOR_IDENT' || args[0] === 'GIT_COMMITTER_IDENT') {
      const n = (await git.configValue('user.name')) ?? '';
      const e = (await git.configValue('user.email')) ?? '';
      git.print(`${n} <${e}> ${Math.floor(Date.now() / 1000)} +0000\n`);
      return;
    }
    git.unsupported(`var ${args[0] ?? ''}`.trim());
  }
  const command = COMMANDS[ALIASES[name] ?? name];
  if (command) {
    if (args.includes('-h') && args.length === 1) {
      git.print(`usage: git ${name} [<options>]  (see https://git-scm.com/docs/git-${name})\n`);
      throw new Exit(129);
    }
    await command(git, args);
    return;
  }
  if (name in MISSING) {
    const hint = MISSING[name];
    git.fatal(`'${name}' is not supported by git on iOS (in-process libgit2)${hint ? `; ${hint}` : ''}`);
  }
  git.warn(`git: '${name}' is not a git command. See 'git --help'.\n`);
  throw new Exit(1);
}

/**
 * The just-bash command. `writable` is the shell's confinement (undefined
 * when unconfined); git writes through libgit2, outside the interpreter's
 * filesystem, so the same fence is checked here.
 */
export function gitCommand(defineCommand, decode, writable) {
  return defineCommand('git', async (args, ctx) => runGit(args, {
    cwd: path.resolve('/', ctx.cwd),
    // ctx.env holds the caller's environment; exportedEnv only what the script exported.
    env: { ...Object.fromEntries(ctx.env), ...ctx.exportedEnv },
    stdin: decode(ctx.stdin ?? ''),
    writable,
    signal: ctx.signal,
  }));
}
