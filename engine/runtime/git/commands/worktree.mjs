// Work-tree commands: init, status, add, rm, mv, commit, restore, reset, clean, stash, apply.
import fs from 'node:fs';
import path from 'node:path';
import { Exit, OpError, parseArgs, parseDate, readInput, parseOperands } from '../core.mjs';

const LABELS = { A: 'new file', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange' };
const UNMERGED = {
  DD: 'both deleted', AU: 'added by us', UD: 'deleted by them', UA: 'added by them',
  DU: 'deleted by us', AA: 'both added', UU: 'both modified',
};
const isUnmerged = (xy) => xy in UNMERGED;

/** "Your branch is …" for the long status and checkout. */
export function trackingLines(head) {
  if (!head.upstream) return '';
  if (head.gone) return `Your branch is based on '${head.upstream}', but the upstream is gone.\n  (use "git branch --unset-upstream" to fixup)\n`;
  const { ahead = 0, behind = 0, upstream } = head;
  const plural = (n) => `${n} commit${n === 1 ? '' : 's'}`;
  if (!ahead && !behind) return `Your branch is up to date with '${upstream}'.\n`;
  if (ahead && !behind) return `Your branch is ahead of '${upstream}' by ${plural(ahead)}.\n  (use "git push" to publish your local commits)\n`;
  if (!ahead) return `Your branch is behind '${upstream}' by ${plural(behind)}, and can be fast-forwarded.\n  (use "git pull" to update your local branch)\n`;
  return `Your branch and '${upstream}' have diverged,\nand have ${ahead} and ${behind} different commits each, respectively.\n  (use "git pull" if you want to integrate the remote branch with yours)\n`;
}

function shortBranchLine(head) {
  if (head.detached) return '## HEAD (no branch)';
  if (head.unborn) return `## No commits yet on ${head.branch}`;
  let line = `## ${head.branch}`;
  if (head.upstream) {
    line += `...${head.upstream}`;
    if (head.gone) line += ' [gone]';
    else if (head.ahead || head.behind) line += ` [${[head.ahead && `ahead ${head.ahead}`, head.behind && `behind ${head.behind}`].filter(Boolean).join(', ')}]`;
  }
  return line;
}

/** The long `git status` text (also printed by a commit with nothing to commit). */
export function longStatus(git, status) {
  const root = status.workdir.replace(/\/$/, '');
  const show = (p) => git.show(p, root);
  const head = status.head;
  let out = head.detached ? `HEAD detached at ${head.oid.slice(0, 7)}\n` : `On branch ${head.branch}\n`;
  if (!head.detached) out += trackingLines(head);
  const staged = [];
  const unstaged = [];
  const unmerged = [];
  const untracked = [];
  const ignored = [];
  for (const e of status.entries) {
    if (e.xy === '??') untracked.push(e);
    else if (e.xy === '!!') ignored.push(e);
    else if (isUnmerged(e.xy)) unmerged.push(e);
    else {
      if (e.xy[0] !== '.') staged.push(e);
      if (e.xy[1] !== '.') unstaged.push(e);
    }
  }
  const line = (label, text, width = 12) => `\t${`${label}:`.padEnd(width)}${text}\n`;
  // Sections end with a blank line; tracking info and "No commits yet" are set off by one.
  if (!head.detached && head.upstream) out += '\n';
  if (head.unborn) out += '\nNo commits yet\n\n';
  if (status.state === 'merge') {
    out += unmerged.length
      ? 'You have unmerged paths.\n  (fix conflicts and run "git commit")\n  (use "git merge --abort" to abort the merge)\n\n'
      : 'All conflicts fixed but you are still merging.\n  (use "git commit" to conclude merge)\n\n';
  }
  if (unmerged.length) {
    out += 'Unmerged paths:\n  (use "git add <file>..." to mark resolution)\n';
    for (const e of unmerged) out += line(UNMERGED[e.xy], show(e.path), 17);
    out += '\n';
  }
  if (staged.length) {
    out += `Changes to be committed:\n  (use "git ${head.unborn ? 'rm --cached' : 'restore --staged'} <file>..." to unstage)\n`;
    for (const e of staged) out += line(LABELS[e.xy[0]], e.orig ? `${show(e.orig)} -> ${show(e.path)}` : show(e.path));
    out += '\n';
  }
  if (unstaged.length) {
    const deleted = unstaged.some((e) => e.xy[1] === 'D');
    out += `Changes not staged for commit:\n  (use "git add${deleted ? '/rm' : ''} <file>..." to update what will be committed)\n  (use "git restore <file>..." to discard changes in working directory)\n`;
    for (const e of unstaged) out += line(LABELS[e.xy[1]], show(e.path));
    out += '\n';
  }
  if (untracked.length) {
    out += 'Untracked files:\n  (use "git add <file>..." to include in what will be committed)\n';
    for (const e of untracked) out += `\t${show(e.path)}\n`;
    out += '\n';
  }
  if (ignored.length) {
    out += 'Ignored files:\n  (use "git add -f <file>..." to include in what will be committed)\n';
    for (const e of ignored) out += `\t${show(e.path)}\n`;
    out += '\n';
  }
  if (!staged.length) {
    if (unstaged.length || unmerged.length) out += 'no changes added to commit (use "git add" and/or "git commit -a")\n';
    else if (untracked.length) out += 'nothing added to commit but untracked files present (use "git add" to track)\n';
    else if (head.unborn) out += 'nothing to commit (create/copy files and use "git add" to track)\n';
    else out += 'nothing to commit, working tree clean\n';
  }
  return out;
}

async function status(git, argv) {
  const { opts, args, rest } = parseArgs(git, argv, {
    's|short': 'bool', 'b|branch': 'bool', 'porcelain': 'optional', 'z': 'bool', 'u|untracked-files': 'optional',
    'ignored': 'optional', 'long': 'bool', 'v|verbose': 'bool', 'show-stash': 'bool', 'ahead-behind': 'bool',
    'renames': 'bool', 'find-renames': 'optional', 'column': 'optional', 'ignore-submodules': 'optional',
  });
  if (opts.porcelain && opts.porcelain !== true && opts.porcelain !== 'v1') git.unsupported(`status --porcelain=${opts.porcelain}`);
  const untracked = opts['untracked-files'] === true ? 'all' : opts['untracked-files'] || 'normal';
  const paths = await git.pathspecs([...args, ...(rest ?? [])]);
  const s = await git.call('status', { untracked, ignored: Boolean(opts.ignored), path: paths, literal: git.literal });
  if (opts.porcelain || opts.short || opts.z) {
    const z = opts.z;
    const root = s.workdir.replace(/\/$/, '');
    // Porcelain paths are repository-relative; short ones are relative to cwd.
    const show = (p) => (opts.porcelain || z ? p : git.show(p, root));
    let out = opts.branch ? `${shortBranchLine(s.head)}${z ? '\0' : '\n'}` : '';
    const order = (e) => (e.xy === '??' ? 1 : e.xy === '!!' ? 2 : 0);
    for (const e of [...s.entries].sort((a, b) => order(a) - order(b))) {
      const xy = e.xy.replace(/\./g, ' ');
      if (e.orig) out += z ? `${xy} ${e.path}\0${e.orig}\0` : `${xy} ${show(e.orig)} -> ${show(e.path)}\n`;
      else out += `${xy} ${show(e.path)}${z ? '\0' : '\n'}`;
    }
    git.print(out);
    return;
  }
  git.print(longStatus(git, s));
}

async function init(git, argv) {
  const { opts, args } = parseOperands(git, argv, {
    'q|quiet': 'bool', 'bare': 'bool', 'b|initial-branch': 'value', 'template': 'value', 'shared': 'optional',
    'separate-git-dir': 'value', 'object-format': 'value',
  });
  if (opts['separate-git-dir']) git.unsupported('init --separate-git-dir');
  if (opts['object-format'] && opts['object-format'] !== 'sha1') git.unsupported(`init --object-format=${opts['object-format']}`);
  const target = path.resolve(git.cwd, args[0] ?? '.');
  git.assertWritable(target);
  const branch = opts['initial-branch'] ?? git.override('init.defaultBranch');
  const r = await git.call('init', { path: target, bare: opts.bare, branch }).catch((e) => git.failOp(e));
  if (!opts.quiet) git.print(`${r.reinit ? 'Reinitialized existing' : 'Initialized empty'} Git repository in ${r.gitdir}\n`);
}

async function add(git, argv) {
  const { opts, args, rest } = parseArgs(git, argv, {
    'A|all': 'bool', 'u|update': 'bool', 'f|force': 'bool', 'n|dry-run': 'bool', 'v|verbose': 'bool',
    'ignore-errors': 'bool', 'N|intent-to-add': 'bool', 'p|patch': 'bool', 'i|interactive': 'bool',
    'ignore-removal': 'bool', 'renormalize': 'bool', 'pathspec-from-file': 'value', 'chmod': 'value', 'no-all': 'bool',
  });
  if (opts.patch || opts.interactive) git.unsupported('interactive add');
  const specs = [...args, ...(rest ?? [])];
  if (!specs.length && !opts.all && !opts.update) {
    git.warn('Nothing specified, nothing added.\nhint: Maybe you wanted to say \'git add .\'?\nhint: Disable this message with "git config set advice.addEmptyPathspec false"\n');
    return;
  }
  const paths = await git.pathspecs(specs);
  await git.assertRepoWritable({ worktree: false });
  let added;
  try {
    added = await git.call('add', {
      mode: opts.update ? 'update' : 'all', force: opts.force, dry: opts['dry-run'], path: paths, literal: git.literal,
    });
  } catch (error) {
    if (error instanceof OpError && error.kind === 'ignored') {
      git.warn(`The following paths are ignored by one of your .gitignore files:\n${specs.join('\n')}\nhint: Use -f if you really want to add them.\nhint: Disable this message with "git config set advice.addIgnoredFile false"\n`);
      throw new Exit(1);
    }
    git.failOp(error);
  }
  if (opts.verbose || opts['dry-run']) {
    const root = await git.workdir();
    git.print(added.map((p) => `add '${git.show(p, root)}'\n`).join(''));
  }
}

async function rm(git, argv) {
  const { opts, args, rest } = parseArgs(git, argv, {
    'cached': 'bool', 'r': 'bool', 'f|force': 'bool', 'n|dry-run': 'bool', 'q|quiet': 'bool', 'ignore-unmatch': 'bool',
  });
  const specs = [...args, ...(rest ?? [])];
  if (!specs.length) git.usage('usage: git rm [<options>] [--] <file>...');
  const paths = await git.pathspecs(specs);
  await git.assertRepoWritable({ worktree: !opts.cached });
  let removed;
  try {
    removed = await git.call('rm', {
      cached: opts.cached, recursive: opts.r, force: opts.force, dry: opts['dry-run'],
      ignoreUnmatch: opts['ignore-unmatch'], path: paths,
    });
  } catch (error) {
    const which = { 'rm-both': 'staged content different from both the file and the HEAD', 'rm-staged': 'changes staged in the index', 'rm-modified': 'local modifications' };
    if (error.kind in which) {
      const hint = error.kind === 'rm-both' ? '(use -f to force removal)' : error.kind === 'rm-staged' ? '(use --cached to keep the file, or -f to force removal)' : '(use --cached to keep the file, or -f to force removal)';
      git.error(`the following file has ${which[error.kind]}:\n    ${error.message}\n${hint}`);
    }
    if (error.kind === 'recursive') git.fatal(`not removing '${error.message}' recursively without -r`);
    git.failOp(error);
  }
  if (!opts.quiet) git.print(removed.map((p) => `rm '${p}'\n`).join(''));
}

async function mv(git, argv) {
  const { opts, args } = parseOperands(git, argv, { 'f|force': 'bool', 'k': 'bool', 'n|dry-run': 'bool', 'v|verbose': 'bool' });
  if (args.length < 2) git.usage('usage: git mv [<options>] <source>... <destination>');
  const root = await git.workdir();
  const destination = args.at(-1);
  const destAbs = path.resolve(git.cwd, destination);
  const intoDir = args.length > 2 || (fs.existsSync(destAbs) && fs.statSync(destAbs).isDirectory());
  await git.assertRepoWritable();
  for (const source of args.slice(0, -1)) {
    const from = path.relative(root, path.resolve(git.cwd, source));
    const to = path.relative(root, intoDir ? path.join(destAbs, path.basename(source)) : destAbs);
    if (opts['dry-run'] || opts.verbose) git.print(`Renaming ${from} to ${to}\n`);
    if (opts['dry-run']) continue;
    try {
      await git.call('mv', { from, to, force: opts.force });
    } catch (error) {
      if (opts.k) continue;
      if (error.kind === 'mv-untracked') git.fatal(`not under version control, source=${from}, destination=${to}`);
      if (error.kind === 'mv-exists') git.fatal(`destination exists, source=${from}, destination=${to}`);
      if (error.kind === 'mv-failed') git.fatal(`renaming '${from}' failed: No such file or directory`);
      git.failOp(error);
    }
  }
}

async function commit(git, argv) {
  const { opts, args, rest } = parseArgs(git, argv, {
    'm|message': 'list', 'F|file': 'value', 'a|all': 'bool', 'amend': 'bool', 'allow-empty': 'bool',
    'allow-empty-message': 'bool', 'no-edit': 'bool', 'e|edit': 'bool', 'n|no-verify': 'bool', 'verify': 'bool',
    'q|quiet': 'bool', 'v|verbose': 'bool', 's|signoff': 'bool', 'author': 'value', 'date': 'value',
    'S|gpg-sign': 'optional', 'no-gpg-sign': 'bool', 'cleanup': 'value', 'reset-author': 'bool', 'C|reuse-message': 'value',
    'c|reedit-message': 'value', 'fixup': 'value', 'squash': 'value', 'o|only': 'bool', 'i|include': 'bool',
    'status': 'bool', 'dry-run': 'bool', 'u|untracked-files': 'optional', 'trailer': 'list', 'p|patch': 'bool',
  });
  if (opts.patch) git.unsupported('commit --patch');
  if (opts.fixup || opts.squash) git.unsupported('commit --fixup/--squash');
  const identity = git.identity();
  let message;
  if (opts.message) message = opts.message.join('\n\n');
  else if (opts.file) message = readInput(git, opts.file);
  else if (opts['reuse-message'] || opts['reedit-message']) {
    const spec = opts['reuse-message'] ?? opts['reedit-message'];
    const [c] = await git.call('log', { rev: spec, max: 1 }).catch((e) => git.failOp(e));
    message = c.message;
  }
  if (message !== undefined && opts.trailer) message = `${message.replace(/\n+$/, '')}\n\n${opts.trailer.join('\n')}\n`;
  if (opts.author) {
    const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(opts.author);
    if (!m) git.fatal(`--author '${opts.author}' is not 'Name <email>' and matches no existing author`);
    identity.authorName = m[1];
    identity.authorEmail = m[2];
  }
  if (opts.date) identity.authorTime = parseDate(opts.date);
  // Without -m there is no editor to open: amend and --no-edit reuse the old
  // message, a merge takes MERGE_MSG, anything else is refused.
  if (message === undefined && !opts.amend && !opts['no-edit'] && (await git.repo()).state !== 'merge') {
    git.error('no commit message given; git on iOS has no editor (use -m or -F)');
  }
  if (opts.signoff) {
    const name = identity.committerName ?? (await git.configValue('user.name'));
    const email = identity.committerEmail ?? (await git.configValue('user.email'));
    const line = `Signed-off-by: ${name} <${email}>`;
    const base = (message ?? '').replace(/\n+$/, '');
    if (!base.includes(line)) message = `${base}\n\n${line}\n`;
  }
  const specs = [...args, ...(rest ?? [])];
  await git.assertRepoWritable({ worktree: false });
  if (specs.length) {
    // `git commit <paths>`: stage those paths first (an approximation of --only).
    await git.call('add', { mode: 'update', path: await git.pathspecs(specs) }).catch((e) => git.failOp(e));
  }
  if (opts['dry-run']) {
    const s = await git.call('status', {});
    git.print(longStatus(git, s));
    return;
  }
  let r;
  try {
    r = await git.call('commit', {
      message, amend: opts.amend, all: opts.all, allowEmpty: opts['allow-empty'],
      allowEmptyMessage: opts['allow-empty-message'], resetAuthor: opts['reset-author'],
      verbatim: opts.cleanup === 'verbatim', ...identity,
    });
  } catch (error) {
    if (!(error instanceof OpError)) throw error;
    if (error.kind === 'nothing') {
      const s = await git.call('status', {});
      git.print(longStatus(git, s));
      throw new Exit(1);
    }
    if (error.kind === 'nomsg') {
      git.warn('Aborting commit due to empty commit message.\n');
      throw new Exit(1);
    }
    if (error.kind === 'unmerged') {
      git.error('Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use \'git add/rm <file>\'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.', 128);
    }
    if (error.kind === 'amend-unborn') git.fatal('You have nothing to amend.');
    git.failOp(error);
  }
  if (opts.quiet) return;
  const where = r.head.detached ? 'detached HEAD' : r.head.branch;
  git.print(`[${where}${r.root ? ' (root-commit)' : ''} ${r.oid.slice(0, 7)}] ${r.subject}\n${r.stats}`);
}

async function restore(git, argv) {
  const { opts, args, rest } = parseArgs(git, argv, {
    's|source': 'value', 'S|staged': 'bool', 'W|worktree': 'bool', 'q|quiet': 'bool', 'p|patch': 'bool',
    'ours': 'bool', 'theirs': 'bool', 'm|merge': 'bool', 'overlay': 'bool', 'ignore-unmerged': 'bool',
    'pathspec-from-file': 'value', 'conflict': 'value', 'progress': 'bool', 'recurse-submodules': 'bool',
  });
  if (opts.patch) git.unsupported('restore --patch');
  if (opts.ours || opts.theirs || opts.merge) git.unsupported('restore --ours/--theirs/--merge');
  const specs = [...args, ...(rest ?? [])];
  if (!specs.length) git.fatal('you must specify path(s) to restore');
  const staged = Boolean(opts.staged);
  const worktree = opts.worktree || !staged;
  const paths = await git.pathspecs(specs);
  await git.assertRepoWritable({ worktree });
  await restorePaths(git, { source: opts.source, staged, worktree, paths, specs });
}

export async function restorePaths(git, { source, staged, worktree, paths, specs }) {
  try {
    await git.call('restore', { source, staged, worktree, path: paths.length ? paths : ['*'], literal: git.literal });
  } catch (error) {
    if (error.kind === 'nomatch') git.error(`pathspec '${specs.find((s) => error.message.endsWith(s.replace(/^\.\//, ''))) ?? error.message}' did not match any file(s) known to git`);
    if (error.kind === 'badrev') git.fatal(`could not resolve ${error.message}`);
    git.failOp(error);
  }
}

async function reset(git, argv) {
  const { opts, args, rest } = parseArgs(git, argv, {
    'soft': 'bool', 'mixed': 'bool', 'hard': 'bool', 'merge': 'bool', 'keep': 'bool', 'q|quiet': 'bool',
    'p|patch': 'bool', 'N|intent-to-add': 'bool', 'pathspec-from-file': 'value', 'recurse-submodules': 'bool', 'no-refresh': 'bool',
  });
  if (opts.patch) git.unsupported('reset --patch');
  let target;
  let specs = rest ?? [];
  if (args.length) {
    // The first argument is a commit when it resolves to one (and isn't a path after --).
    const [resolved] = await git.call('revparse', { spec: args[0], peel: 1 }).catch(() => [null]);
    if (resolved && resolved.type === 'commit') {
      target = args[0];
      specs = [...args.slice(1), ...specs];
    } else {
      specs = [...args, ...specs];
    }
  }
  const mode = opts.hard ? 'hard' : opts.soft ? 'soft' : opts.keep || opts.merge ? 'hard' : 'mixed';
  if (specs.length && (opts.hard || opts.soft)) git.fatal(`Cannot do ${mode} reset with paths.`);
  const paths = await git.pathspecs(specs);
  await git.assertRepoWritable({ worktree: mode === 'hard' });
  const r = await git.call('reset', { mode, target, path: paths }).catch((e) => git.failOp(e));
  if (opts.quiet) return;
  if (mode === 'hard' && !paths.length) {
    git.print(`HEAD is now at ${r.oid.slice(0, 7)} ${r.subject}\n`);
  } else if (mode === 'mixed') {
    const diff = await git.call('diff', { mode: 'workdir' });
    if (diff.files.length) git.print(`Unstaged changes after reset:\n${diff.files.map((f) => `${f.status}\t${f.new}\n`).join('')}`);
  }
}

async function clean(git, argv) {
  const { opts, args, rest } = parseArgs(git, argv, {
    'n|dry-run': 'bool', 'f|force': 'list', 'd': 'bool', 'x': 'bool', 'X': 'bool', 'q|quiet': 'bool', 'i|interactive': 'bool', 'e|exclude': 'list',
  });
  if (opts.interactive) git.unsupported('clean --interactive');
  if (!opts.force && !opts['dry-run']) git.fatal('clean.requireForce is true and -f not given: refusing to clean');
  const paths = await git.pathspecs([...args, ...(rest ?? [])]);
  const root = await git.workdir();
  if (!opts['dry-run']) await git.assertRepoWritable();
  const removed = await git.call('clean', {
    dirs: opts.d, ignored: opts.x, onlyIgnored: opts.X, dry: opts['dry-run'], path: paths,
  });
  if (opts.quiet) return;
  git.print(removed.map((p) => `${opts['dry-run'] ? 'Would remove' : 'Removing'} ${git.show(p, root)}\n`).join(''));
}

async function stash(git, argv) {
  const sub = ['push', 'save', 'list', 'show', 'pop', 'apply', 'drop', 'clear', 'branch', 'create', 'store'].includes(argv[0]) ? argv[0] : 'push';
  const rest = sub === 'push' && argv[0] !== 'push' ? argv : argv.slice(1);
  const index = (spec) => {
    if (!spec) return 0;
    const m = /^(?:stash@\{)?(\d+)\}?$/.exec(spec);
    if (!m) git.fatal(`'${spec}' is not a stash-like commit`);
    return Number(m[1]);
  };
  if (sub === 'branch' || sub === 'create' || sub === 'store') git.unsupported(`stash ${sub}`);
  if (sub === 'list') {
    const list = await git.call('stash', { action: 'list' }).catch((e) => git.failOp(e));
    git.print(list.map((s) => `stash@{${s.index}}: ${s.message}\n`).join(''));
    return;
  }
  if (sub === 'show') {
    const { opts, args } = parseOperands(git, rest, { 'p|patch': 'bool', 'stat': 'bool', 'u|include-untracked': 'bool', 'name-only': 'bool' });
    const ref = `stash@{${index(args[0])}}`;
    const d = await git.call('diff', { mode: 'trees', from: `${ref}^1`, to: ref, patch: opts.patch, stat: !opts.patch && !opts['name-only'] }).catch((e) => git.failOp(e));
    git.print(opts.patch ? d.patch : opts['name-only'] ? d.files.map((f) => `${f.new}\n`).join('') : d.stat);
    return;
  }
  await git.assertRepoWritable();
  if (sub === 'clear') {
    const list = await git.call('stash', { action: 'list' });
    for (let i = list.length - 1; i >= 0; i--) await git.call('stash', { action: 'drop', index: i });
    return;
  }
  if (sub === 'drop') {
    const i = index(rest[0]);
    const list = await git.call('stash', { action: 'list' });
    const entry = list.find((s) => s.index === i);
    if (!entry) git.error(`stash@{${i}} is not a valid reference`);
    await git.call('stash', { action: 'drop', index: i }).catch((e) => git.failOp(e));
    git.print(`Dropped refs/stash@{${i}} (${entry.oid})\n`);
    return;
  }
  if (sub === 'pop' || sub === 'apply') {
    const { opts, args } = parseOperands(git, rest, { 'index': 'bool', 'q|quiet': 'bool' });
    const i = index(args[0]);
    const list = await git.call('stash', { action: 'list' });
    const entry = list.find((s) => s.index === i);
    if (!entry) git.error(list.length ? `stash@{${i}} is not a valid reference` : 'No stash entries found.');
    try {
      await git.call('stash', { action: sub, index: i, restoreIndex: opts.index });
    } catch (error) {
      if (error.kind === 'overwrite-stash') {
        git.error(`${error.message}\nThe stash entry is kept in case you need it again.`);
      }
      git.failOp(error);
    }
    if (!opts.quiet) {
      const s = await git.call('status', {});
      git.print(longStatus(git, s));
      if (sub === 'pop') git.print(`Dropped refs/stash@{${i}} (${entry.oid})\n`);
    }
    return;
  }
  const { opts, args, rest: paths } = parseArgs(git, rest, {
    'm|message': 'value', 'u|include-untracked': 'bool', 'k|keep-index': 'bool', 'q|quiet': 'bool',
    'a|all': 'bool', 'p|patch': 'bool', 'S|staged': 'bool',
  });
  if (opts.patch || opts.staged) git.unsupported('stash --patch/--staged');
  if (paths?.length || (sub === 'push' && args.length)) git.unsupported('stash push <pathspec>');
  const message = sub === 'save' && args.length ? args.join(' ') : opts.message;
  const status = await git.call('status', {});
  const head = status.head;
  if (head.unborn) git.fatal('You do not have the initial commit yet');
  const [c] = await git.call('log', { max: 1 });
  const label = message ? `On ${head.branch ?? '(no branch)'}: ${message}` : undefined;
  try {
    await git.call('stash', { action: 'push', message: label, untracked: opts['include-untracked'] || opts.all, keepIndex: opts['keep-index'], ...git.identity() });
  } catch (error) {
    if (error.kind === 'nothing') {
      git.print('No local changes to save\n');
      return;
    }
    git.failOp(error);
  }
  if (!opts.quiet) git.print(`Saved working directory and index state ${label ?? `WIP on ${head.branch ?? '(no branch)'}: ${c.short} ${c.message.split('\n')[0]}`}\n`);
}

async function apply(git, argv) {
  const { opts, args } = parseOperands(git, argv, {
    'check': 'bool', 'index': 'bool', 'cached': 'bool', 'stat': 'bool', 'numstat': 'bool', 'v|verbose': 'bool',
    'R|reverse': 'bool', '3|3way': 'bool', 'reject': 'bool', 'whitespace': 'value', 'p': 'value', 'unidiff-zero': 'bool',
    'allow-empty': 'bool', 'recount': 'bool', 'directory': 'value', 'include': 'list', 'exclude': 'list', 'q|quiet': 'bool',
  });
  if (opts.reverse || opts['3way'] || opts.reject || opts.directory || (opts.p && opts.p !== '1')) git.unsupported('apply -R/--3way/--reject/--directory/-p');
  const patches = args.length ? args.map((f) => readInput(git, f)) : [git.stdin];
  const location = opts.cached ? 'index' : opts.index ? 'both' : 'workdir';
  if (!opts.check) await git.assertRepoWritable({ worktree: location !== 'index' });
  for (const patch of patches) {
    if (!patch.trim()) {
      if (opts['allow-empty']) continue;
      git.error('No valid patches in input (allow with "--allow-empty")', 128);
    }
    try {
      const files = await git.call('apply', { patch, location, check: opts.check || opts.stat || opts.numstat });
      if (opts.verbose) git.warn(files.map((f) => `Applied patch ${f} cleanly.\n`).join(''));
    } catch (error) {
      if (error.kind === 'apply' || error.kind === 'badpatch') git.error(error.message);
      git.failOp(error);
    }
  }
}

export default { status, init, add, rm, mv, commit, restore, reset, clean, stash, apply };
