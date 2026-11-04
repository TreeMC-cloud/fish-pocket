// Branch commands: branch, checkout, switch, merge, tag, worktree.
import fs from 'node:fs';
import path from 'node:path';
import { Exit, OpError, parseArgs, readInput, parseOperands } from '../core.mjs';
import worktreeCommands, { restorePaths, trackingLines } from './worktree.mjs';

const wildcard = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

async function branch(git, argv) {
  const { opts, args } = parseOperands(git, argv, {
    'd|delete': 'bool', 'D': 'bool', 'f|force': 'bool', 'm|move': 'bool', 'M': 'bool', 'c|copy': 'bool', 'C': 'bool',
    'a|all': 'bool', 'r|remotes': 'bool', 'l|list': 'bool', 'v|verbose': 'count', 'q|quiet': 'bool', 'show-current': 'bool',
    'u|set-upstream-to': 'value', 'unset-upstream': 'bool', 't|track': 'optional', 'no-track': 'bool',
    'merged': 'optional', 'no-merged': 'optional', 'contains': 'optional', 'no-contains': 'optional', 'points-at': 'value',
    'sort': 'value', 'format': 'value', 'color': 'optional', 'no-color': 'bool', 'column': 'optional', 'abbrev': 'optional',
    'i|ignore-case': 'bool', 'edit-description': 'bool', 'create-reflog': 'bool', 'recurse-submodules': 'bool', 'omit-empty': 'bool',
  });
  if (opts.copy || opts.C) git.unsupported('branch --copy');
  if (opts['edit-description']) git.unsupported('branch --edit-description');
  await git.repo();
  if (opts['show-current']) {
    const repo = await git.repo();
    if (!repo.head.detached) git.print(`${repo.head.branch}\n`);
    return;
  }
  if (opts.delete || opts.D) {
    if (!args.length) git.fatal('branch name required');
    await git.assertRepoWritable({ worktree: false });
    let failed = false;
    for (const name of args) {
      try {
        const r = await git.call('branch-delete', { name, force: opts.D || opts.force, remote: opts.remotes });
        if (!opts.quiet) git.print(`Deleted ${opts.remotes ? 'remote-tracking ' : ''}branch ${name} (was ${r.short}).\n`);
      } catch (error) {
        failed = true;
        if (error.kind === 'notfound') git.warn(`error: ${opts.remotes ? 'remote-tracking ' : ''}branch '${name}' not found\n`);
        else if (error.kind === 'notmerged') git.warn(`error: the branch '${name}' is not fully merged\nhint: If you are sure you want to delete it, run 'git branch -D ${name}'\nhint: Disable this message with "git config set advice.forceDeleteBranch false"\n`);
        else if (error.kind === 'current') git.warn(`error: cannot delete branch '${name}' used by worktree at '${(await git.repo()).workdir}'\n`);
        else git.failOp(error);
      }
    }
    if (failed) throw new Exit(1);
    return;
  }
  if (opts.move || opts.M) {
    const repo = await git.repo();
    const [from, to] = args.length >= 2 ? args : [repo.head.branch, args[0]];
    if (!to) git.fatal('branch name required');
    await git.assertRepoWritable({ worktree: false });
    try {
      await git.call('branch-rename', { from, to, force: opts.M || opts.force });
    } catch (error) {
      if (error.kind === 'notfound') git.error(`refname refs/heads/${from} not found\nfatal: branch rename failed`, 128);
      if (error.kind === 'exists') git.fatal(`a branch named '${to}' already exists`);
      git.failOp(error);
    }
    return;
  }
  if (opts['set-upstream-to'] !== undefined || opts['unset-upstream']) {
    const repo = await git.repo();
    const name = args[0] ?? repo.head.branch;
    await git.assertRepoWritable({ worktree: false });
    try {
      await git.call('branch-upstream', { name, upstream: opts['unset-upstream'] ? '' : opts['set-upstream-to'] });
    } catch (error) {
      if (error.kind === 'noupstream') git.fatal(`the requested upstream branch '${opts['set-upstream-to']}' does not exist`);
      if (error.kind === 'notfound') git.fatal(`branch '${name}' does not exist`);
      git.failOp(error);
    }
    if (!opts['unset-upstream'] && !opts.quiet) git.print(`branch '${name}' set up to track '${opts['set-upstream-to']}'.\n`);
    return;
  }
  const listing = opts.list || opts.all || opts.remotes || opts.verbose || opts.merged !== undefined || opts['no-merged'] !== undefined || opts.contains !== undefined || opts['points-at'] || opts.format;
  if (args.length && !listing) {
    const [name, start] = args;
    await git.assertRepoWritable({ worktree: false });
    try {
      const r = await git.call('branch-create', { name, start, force: opts.force, track: opts['no-track'] ? 0 : undefined });
      if (r.tracking && !opts.quiet) git.print(`branch '${name}' set up to track '${r.tracking}'.\n`);
    } catch (error) {
      if (error.kind === 'exists') git.fatal(`a branch named '${name}' already exists`);
      if (error.kind === 'badname') git.fatal(`'${name}' is not a valid branch name`);
      if (error.kind === 'unborn' || error.kind === 'badrev') git.fatal(`not a valid object name: '${start ?? 'HEAD'}'`);
      git.failOp(error);
    }
    return;
  }
  const r = await git.call('branches', { all: opts.all, remotes: opts.remotes }).catch((e) => git.failOp(e));
  let list = r.branches;
  if (args.length) list = list.filter((b) => args.some((p) => wildcard(p).test(b.name)));
  for (const [key, keep] of [['merged', true], ['no-merged', false]]) {
    if (opts[key] === undefined) continue;
    const base = opts[key] === true ? 'HEAD' : opts[key];
    const kept = [];
    for (const b of list) {
      if (!b.oid) continue;
      const mb = await git.call('merge-base', { spec: [b.oid, base] }).catch(() => null);
      if (Boolean(mb?.ancestor) === keep) kept.push(b);
    }
    list = kept;
  }
  if (opts.contains !== undefined) {
    const target = opts.contains === true ? 'HEAD' : opts.contains;
    const kept = [];
    for (const b of list) {
      const mb = b.oid && (await git.call('merge-base', { spec: [target, b.oid] }).catch(() => null));
      if (mb?.ancestor) kept.push(b);
    }
    list = kept;
  }
  if (opts['points-at']) {
    const [target] = await git.call('revparse', { spec: opts['points-at'], peel: 1 });
    list = list.filter((b) => b.oid === target?.oid);
  }
  list.sort((a, b) => Number(a.remote) - Number(b.remote) || a.name.localeCompare(b.name));
  if (opts.format) {
    git.print(list.map((b) => `${opts.format.replace(/%\((refname(?::short)?|objectname(?::short)?|upstream(?::short)?|HEAD|subject)\)/g, (_, key) => ({
      refname: b.ref, 'refname:short': b.name, objectname: b.oid, 'objectname:short': b.short,
      upstream: b.upstream ? `refs/remotes/${b.upstream}` : '', 'upstream:short': b.upstream ?? '', HEAD: b.head ? '*' : ' ', subject: b.subject ?? '',
    })[key] ?? '')}\n`).join(''));
    return;
  }
  const display = (b) => (b.remote && opts.all ? `remotes/${b.name}` : b.name);
  const width = Math.max(0, ...list.map((b) => display(b).length));
  const verbose = opts.verbose ?? 0;
  const lines = list.map((b) => {
    const mark = b.head ? '* ' : '  ';
    if (b.symbolic) return `${mark}${display(b)} -> ${b.symbolic.replace(/^refs\/remotes\//, '')}\n`;
    if (!verbose) return `${mark}${display(b)}\n`;
    let track = '';
    if (b.upstream) {
      const state = b.gone ? 'gone' : [b.ahead && `ahead ${b.ahead}`, b.behind && `behind ${b.behind}`].filter(Boolean).join(', ');
      if (verbose > 1) track = `[${b.upstream}${state ? `: ${state}` : ''}] `;
      else if (state) track = `[${state}] `;
    }
    return `${mark}${display(b).padEnd(width)} ${b.short} ${track}${b.subject ?? ''}\n`;
  });
  if (r.head.detached && !opts.remotes && !args.length) lines.unshift(`* (HEAD detached at ${r.head.oid.slice(0, 7)})\n`);
  git.print(lines.join(''));
}

/** Switch HEAD: shared by checkout and switch. */
async function switchTo(git, { target, create, reset, detach, force, guess, track, orphan, quiet, allowDetach }) {
  await git.assertRepoWritable();
  if (target === '-') {
    const [prev] = await git.call('revparse', { spec: '@{-1}' }).catch(() => [null]);
    if (!prev) git.fatal('invalid reference: @{-1}');
    target = prev.ref?.startsWith('refs/heads/') ? prev.ref.slice(11) : prev.oid;
  }
  let r;
  try {
    r = await git.call('checkout', {
      target, create, reset, detach, force, guess, orphan, allowDetach,
      track: track === false ? 0 : undefined,
    });
  } catch (error) {
    if (!(error instanceof OpError)) throw error;
    if (error.kind === 'overwrite') {
      const files = JSON.parse(error.message);
      git.error(`Your local changes to the following files would be overwritten by checkout:\n${files.map((f) => `\t${f}\n`).join('')}Please commit your changes or stash them before you switch branches.\nAborting`);
    }
    if (error.kind === 'exists') git.fatal(`a branch named '${create}' already exists`);
    if (error.kind === 'badname') git.fatal(`'${create}' is not a valid branch name`);
    throw error;
  }
  if (quiet) return r;
  if (orphan) {
    git.warn(`Switched to a new branch '${create}'\n`);
    return r;
  }
  if (r.tracking) git.print(`branch '${r.branch}' set up to track '${r.tracking}'.\n`);
  if (!r.branch) {
    git.warn(`Note: switching to '${target}'.\n\nYou are in 'detached HEAD' state. You can look around, make experimental\nchanges and commit them, and you can discard any commits you make in this\nstate without impacting any branches by switching back to a branch.\n\nIf you want to create a new branch to retain commits you create, you may\ndo so (now or later) by using -c with the switch command. Example:\n\n  git switch -c <new-branch-name>\n\nOr undo this operation with:\n\n  git switch -\n\nHEAD is now at ${r.oid.slice(0, 7)} ${r.subject}\n`);
    return r;
  }
  if (r.already) git.warn(`Already on '${r.branch}'\n`);
  else git.warn(`Switched to ${r.created ? 'a new branch' : 'branch'} '${r.branch}'\n`);
  git.print(trackingLines(r.head));
  return r;
}

async function checkout(git, argv) {
  const { opts, args, rest } = parseArgs(git, argv, {
    'b': 'value', 'B': 'value', 'f|force': 'bool', 'detach': 'bool', 't|track': 'optional', 'no-track': 'bool',
    'orphan': 'value', 'q|quiet': 'bool', 'p|patch': 'bool', 'ours': 'bool', 'theirs': 'bool', 'm|merge': 'bool',
    'guess': 'bool', 'overlay': 'bool', 'progress': 'bool', 'conflict': 'value', 'ignore-other-worktrees': 'bool',
    'recurse-submodules': 'bool', 'pathspec-from-file': 'value', 'l': 'bool',
  });
  if (opts.patch) git.unsupported('checkout --patch');
  if (opts.ours || opts.theirs || opts.merge) git.unsupported('checkout --ours/--theirs/--merge');
  await git.repo();
  const create = opts.b ?? opts.B ?? opts.orphan;
  // `checkout [<tree-ish>] -- <paths>`: restore files.
  if (rest !== undefined && !create) {
    const paths = await git.pathspecs(rest);
    await git.assertRepoWritable();
    await restorePaths(git, { source: args[0], staged: Boolean(args[0]), worktree: true, paths, specs: rest });
    return;
  }
  let target = args[0];
  if (opts.track && opts.track !== true && !target) target = opts.track;
  if (!create && opts.track !== undefined && opts.track !== false && target?.includes('/')) {
    // -t origin/x: create x tracking origin/x.
    return switchTo(git, { target, create: target.slice(target.indexOf('/') + 1), quiet: opts.quiet, force: opts.force });
  }
  if (!target && !create) git.fatal('you must specify a branch to switch to');
  try {
    await switchTo(git, {
      target: target ?? 'HEAD', create, reset: Boolean(opts.B), detach: opts.detach, force: opts.force,
      guess: opts.guess !== false, track: opts['no-track'] ? false : undefined, orphan: Boolean(opts.orphan),
      quiet: opts.quiet, allowDetach: true,
    });
  } catch (error) {
    if (!(error instanceof OpError)) throw error;
    if (error.kind === 'notfound' && !create) {
      // Not a branch or commit: treat the arguments as paths (git's fallback).
      const exists = args.every((a) => fs.existsSync(path.resolve(git.cwd, a)));
      if (exists || args.length > 1) {
        const paths = await git.pathspecs(args);
        await restorePaths(git, { worktree: true, paths, specs: args });
        return;
      }
      git.error(`pathspec '${target}' did not match any file(s) known to git`);
    }
    if (error.kind === 'badrev' || error.kind === 'notfound') git.fatal(`'${target}' is not a commit and a branch '${create}' cannot be created from it`);
    git.failOp(error);
  }
}

async function switchCommand(git, argv) {
  const { opts, args } = parseOperands(git, argv, {
    'c|create': 'value', 'C|force-create': 'value', 'd|detach': 'bool', 'f|force|discard-changes': 'bool',
    't|track': 'optional', 'no-track': 'bool', 'orphan': 'value', 'q|quiet': 'bool', 'guess': 'bool', 'm|merge': 'bool',
    'progress': 'bool', 'conflict': 'value', 'ignore-other-worktrees': 'bool', 'recurse-submodules': 'bool',
  });
  if (opts.merge) git.unsupported('switch --merge');
  await git.repo();
  const create = opts.create ?? opts['force-create'] ?? opts.orphan;
  const target = args[0];
  if (!target && !create) git.fatal('missing branch or commit argument');
  try {
    await switchTo(git, {
      target: target ?? 'HEAD', create, reset: Boolean(opts['force-create']), detach: opts.detach, force: opts.force,
      guess: opts.guess !== false, track: opts['no-track'] ? false : undefined, orphan: Boolean(opts.orphan),
      quiet: opts.quiet, allowDetach: opts.detach || Boolean(create),
    });
  } catch (error) {
    if (!(error instanceof OpError)) throw error;
    if (error.kind === 'needdetach') git.fatal(`a branch is expected, got commit '${target}'\nhint: If you want to detach HEAD at the commit, try again with the --detach option.`);
    if (error.kind === 'notfound' || error.kind === 'badrev') git.fatal(`invalid reference: ${target}`);
    git.failOp(error);
  }
}

/** The label git puts in a merge commit message for `target`. */
async function mergeLabel(git, target) {
  const [r] = await git.call('revparse', { spec: target }).catch(() => [null]);
  const repo = await git.repo();
  const into = repo.head.branch && !['main', 'master'].includes(repo.head.branch) ? ` into ${repo.head.branch}` : '';
  if (r?.ref?.startsWith('refs/heads/')) return `branch '${r.ref.slice(11)}'${into}`;
  if (r?.ref?.startsWith('refs/remotes/')) return `remote-tracking branch '${r.ref.slice(13)}'${into}`;
  if (r?.ref?.startsWith('refs/tags/')) return `tag '${r.ref.slice(10)}'${into}`;
  return `commit '${target}'${into}`;
}

export async function mergeInto(git, target, opts, { label } = {}) {
  await git.assertRepoWritable();
  let r;
  try {
    r = await git.call('merge', {
      target, ffOnly: opts['ff-only'], noFf: opts.ff === false, noCommit: opts.commit === false, squash: opts.squash,
      favor: opts['strategy-option']?.at(-1),
      message: opts.message?.join('\n\n'), label: label ?? (await mergeLabel(git, target)), ...git.identity(),
    });
  } catch (error) {
    if (!(error instanceof OpError)) throw error;
    if (error.kind === 'overwrite') {
      const files = JSON.parse(error.message);
      git.error(`Your local changes to the following files would be overwritten by merge:\n${files.map((f) => `\t${f}\n`).join('')}Please commit your changes or stash them before you merge.\nAborting`);
    }
    if (error.kind === 'notff') git.fatal('Not possible to fast-forward, aborting.');
    if (error.kind === 'badrev') git.fatal(`${target} - not something we can merge`);
    git.failOp(error);
  }
  if (r.result === 'up-to-date') {
    git.print('Already up to date.\n');
    return r;
  }
  if (r.result === 'fast-forward') {
    git.print(`${r.from ? `Updating ${r.from.slice(0, 7)}..${r.to.slice(0, 7)}\n` : ''}Fast-forward\n${r.stat ?? ''}`);
    return r;
  }
  const conflicted = new Set(r.conflicts?.map((c) => c.path));
  for (const p of r.automerged ?? []) if (!conflicted.has(p) || r.conflicts.find((c) => c.path === p)?.kind !== 'modify/delete') git.print(`Auto-merging ${p}\n`);
  if (r.result === 'conflict') {
    for (const c of r.conflicts) {
      git.print(c.kind === 'content' ? `CONFLICT (content): Merge conflict in ${c.path}\n` : c.kind === 'add/add' ? `CONFLICT (add/add): Merge conflict in ${c.path}\n` : `CONFLICT (modify/delete): ${c.path} deleted in one branch and modified in the other.\n`);
    }
    git.print('Automatic merge failed; fix conflicts and then commit the result.\n');
    throw new Exit(1);
  }
  if (r.result === 'squashed') git.print(`Squash commit -- not updating HEAD\n${r.stat ?? ''}`);
  else if (r.result === 'uncommitted') git.print('Automatic merge went well; stopped before committing as requested\n');
  else git.print(`Merge made by the 'ort' strategy.\n${r.stat ?? ''}`);
  return r;
}

async function merge(git, argv) {
  const { opts, args } = parseOperands(git, argv, {
    'ff': 'bool', 'ff-only': 'bool', 'commit': 'bool', 'squash': 'bool', 'm|message': 'list', 'abort': 'bool',
    'continue': 'bool', 'quit': 'bool', 'no-edit': 'bool', 'e|edit': 'bool', 'q|quiet': 'bool', 'v|verbose': 'bool',
    's|strategy': 'value', 'X|strategy-option': 'list', 'stat': 'bool', 'n': 'bool', 'log': 'optional', 'signoff': 'bool',
    'allow-unrelated-histories': 'bool', 'verify': 'bool', 'progress': 'bool', 'autostash': 'bool', 'S|gpg-sign': 'optional',
    'F|file': 'value', 'into-name': 'value', 'rerere-autoupdate': 'bool', 'cleanup': 'value',
  });
  if (opts.strategy && !['ort', 'recursive'].includes(opts.strategy)) git.unsupported(`merge strategy '${opts.strategy}'`);
  const favor = opts['strategy-option']?.at(-1);
  if (favor && !['ours', 'theirs', 'union'].includes(favor)) git.unsupported(`merge -X ${favor}`);
  await git.repo();
  if (opts.abort) {
    await git.assertRepoWritable();
    await git.call('merge', { abort: true }).catch((e) => (e.kind === 'nomerge' ? git.fatal(e.message) : git.failOp(e)));
    return;
  }
  if (opts.continue) {
    return worktreeCommands.commit(git, ['--no-edit']);
  }
  if (!args.length) {
    const repo = await git.repo();
    if (!repo.head.upstream) git.fatal('No remote for the current branch.');
    args.push(repo.head.upstream);
  }
  if (args.length > 1) git.unsupported('octopus merges');
  await mergeInto(git, args[0], { ...opts, 'strategy-option': favor && [favor] });
}

async function tag(git, argv) {
  const { opts, args } = parseOperands(git, argv, {
    'l|list': 'bool', 'd|delete': 'bool', 'a|annotate': 'bool', 'm|message': 'list', 'F|file': 'value', 'f|force': 'bool',
    'n': 'optional', 's|sign': 'bool', 'u|local-user': 'value', 'v|verify': 'bool', 'sort': 'value', 'contains': 'optional',
    'points-at': 'value', 'merged': 'optional', 'no-merged': 'optional', 'format': 'value', 'i|ignore-case': 'bool',
    'e|edit': 'bool', 'cleanup': 'value', 'create-reflog': 'bool', 'column': 'optional', 'color': 'optional',
  });
  if (opts.sign || opts['local-user'] || opts.verify) git.unsupported('signed tags');
  await git.repo();
  if (opts.delete) {
    await git.assertRepoWritable({ worktree: false });
    let failed = false;
    for (const name of args) {
      try {
        const r = await git.call('tag', { action: 'delete', name });
        git.print(`Deleted tag '${name}' (was ${r.short})\n`);
      } catch (error) {
        if (error.kind !== 'notfound') git.failOp(error);
        git.warn(`error: tag '${name}' not found.\n`);
        failed = true;
      }
    }
    if (failed) throw new Exit(1);
    return;
  }
  if (opts.list || !args.length || opts.n !== undefined || opts['points-at'] || opts.contains !== undefined) {
    const names = await git.call('tag', { action: 'list', pattern: opts.list ? args[0] : undefined });
    let list = names;
    if (opts['points-at']) {
      const [target] = await git.call('revparse', { spec: opts['points-at'], peel: 1 });
      const kept = [];
      for (const n of list) {
        const [t] = await git.call('revparse', { spec: `refs/tags/${n}`, peel: 1 });
        if (t?.oid === target?.oid) kept.push(n);
      }
      list = kept;
    }
    if (opts.sort?.replace(/^-/, '') === 'version:refname' || opts.sort?.replace(/^-/, '') === 'v:refname') {
      list = [...list].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (opts.sort.startsWith('-')) list.reverse();
    } else if (opts.sort?.startsWith('-')) {
      list = [...list].reverse();
    }
    git.print(list.map((n) => `${n}\n`).join(''));
    return;
  }
  const [name, target] = args;
  let message = opts.message?.join('\n\n');
  if (opts.file) message = readInput(git, opts.file);
  if (opts.annotate && message === undefined) git.fatal('no tag message given; git on iOS has no editor (use -m or -F)');
  if (message !== undefined && !message.endsWith('\n')) message += '\n';
  await git.assertRepoWritable({ worktree: false });
  try {
    await git.call('tag', { action: 'create', name, target, message, force: opts.force, ...git.identity() });
  } catch (error) {
    if (error.kind === 'exists') git.fatal(`tag '${name}' already exists`);
    if (error.kind === 'badrev') git.fatal(`Failed to resolve '${target}' as a valid ref.`);
    git.failOp(error);
  }
}

async function worktree(git, argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  await git.repo();
  if (sub === 'list') {
    const { opts } = parseOperands(git, rest, { 'porcelain': 'bool', 'v|verbose': 'bool', 'z': 'bool', 'expire': 'value' });
    const [main, ...linked] = await git.call('worktree', { action: 'list' }).catch((e) => git.failOp(e));
    const clean = (p) => p.replace(/\/$/, '');
    const list = [main, ...linked.sort((a, b) => (clean(a.path) < clean(b.path) ? -1 : 1))];
    if (opts.porcelain) {
      const end = opts.z ? '\0' : '\n';
      git.print(list.map((w) => [
        `worktree ${clean(w.path)}`,
        ...(w.bare ? ['bare'] : [`HEAD ${w.head.oid ?? '0'.repeat(40)}`, w.head.detached ? 'detached' : `branch ${w.head.ref}`]),
        ...(w.locked ? ['locked'] : []), ...(w.prunable ? ['prunable'] : []),
      ].map((l) => `${l}${end}`).join('') + end).join(''));
      return;
    }
    const width = Math.max(...list.map((w) => clean(w.path).length));
    git.print(list.map((w) => `${clean(w.path).padEnd(width)}  ${w.bare ? '(bare)' : `${(w.head.oid ?? '0000000').slice(0, 7)} ${w.head.detached ? '(detached HEAD)' : `[${w.head.branch}]`}`}${w.locked ? ' locked' : ''}${w.prunable ? ' prunable' : ''}\n`).join(''));
    return;
  }
  if (sub === 'add') {
    const { opts, args } = parseOperands(git, rest, {
      'b': 'value', 'B': 'value', 'd|detach': 'bool', 'f|force': 'bool', 'no-checkout': 'bool', 'checkout': 'bool',
      'lock': 'bool', 'reason': 'value', 'q|quiet': 'bool', 'track': 'bool', 'no-track': 'bool', 'guess-remote': 'bool', 'orphan': 'bool',
    });
    if (opts.orphan || opts.lock) git.unsupported('worktree add --orphan/--lock');
    const [target, commitish] = args;
    if (!target) git.usage('usage: git worktree add [<options>] <path> [<commit-ish>]');
    const dir = path.resolve(git.cwd, target);
    const { commondir } = await git.repo();
    git.assertWritable(dir, commondir);
    // libgit2 makes neither the parents nor a unique record name; git does both.
    let name = path.basename(dir);
    for (let i = 1; fs.existsSync(path.join(commondir, 'worktrees', name)); i++) name = `${path.basename(dir)}${i}`;
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    let create = opts.b ?? opts.B;
    let branchName;
    let from = commitish;
    if (!create && !opts.detach && commitish) {
      const [ref] = await git.call('revparse', { spec: commitish }).catch(() => [null]);
      if (ref?.ref?.startsWith('refs/heads/')) branchName = ref.ref.slice(11);
    }
    if (!create && !opts.detach && !commitish) create = path.basename(dir);
    if (opts.detach && !from) from = 'HEAD';
    try {
      await git.call('worktree', {
        action: 'add', path: dir, name, create, branch: branchName, commit: branchName ? undefined : from,
        force: opts.force || Boolean(opts.B), noCheckout: opts['no-checkout'],
      });
    } catch (error) {
      if (error.kind === 'exists') git.fatal(`a branch named '${create}' already exists`);
      if (error.kind === 'checkedout') git.fatal(`'${branchName}' is already used by worktree`);
      if (error.kind === 'badrev') git.fatal(`invalid reference: ${from}`);
      git.failOp(error);
    }
    if (!opts.quiet) {
      git.warn(`Preparing worktree (${create ? `new branch '${create}'` : branchName ? `checking out '${branchName}'` : `detached HEAD ${from}`})\n`);
      if (!opts['no-checkout']) {
        const [c] = await git.call('log', { rev: create ?? branchName ?? from, max: 1 }).catch(() => [null]);
        if (c) git.print(`HEAD is now at ${c.short} ${c.message.split('\n')[0]}\n`);
      }
    }
    return;
  }
  if (sub === 'remove' || sub === 'prune') {
    const { opts, args } = parseOperands(git, rest, { 'f|force': 'list', 'n|dry-run': 'bool', 'v|verbose': 'bool', 'expire': 'value' });
    if (args.length !== (sub === 'remove' ? 1 : 0)) git.usage(`usage: git worktree ${sub} ${sub === 'remove' ? '[-f] <worktree>' : '[<options>]'}`);
    await git.assertRepoWritable({ worktree: false });
    try {
      await git.call('worktree', { action: sub, path: args[0] && path.resolve(git.cwd, args[0]), force: Boolean(opts.force) });
    } catch (error) {
      if (error.kind === 'notworktree') git.fatal(`'${args[0]}' is not a working tree`);
      if (error.kind === 'dirty') git.fatal(error.message);
      git.failOp(error);
    }
    return;
  }
  git.unsupported(`worktree ${sub ?? ''}`.trim());
}

export default { branch, checkout, switch: switchCommand, merge, tag, worktree };
