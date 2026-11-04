// Remote commands over HTTPS: clone, fetch, pull, push, remote, ls-remote.
// Credentials come from the URL, ~/.git-credentials (credential-store format),
// or GH_TOKEN / GITHUB_TOKEN for github.com; libgit2 has no SSH here.
import fs from 'node:fs';
import path from 'node:path';
import { Exit, OpError, parseArgs, parseOperands } from '../core.mjs';
import { mergeInto } from './branches.mjs';

const isUrl = (s) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
const isScp = (s) => /^[^/:]+@[^/:]+:/.test(s);

function refuseSsh(git, url) {
  if (/^ssh:\/\//i.test(url) || isScp(url)) {
    git.fatal(`SSH remotes are not supported by git on iOS; use an https:// URL instead of '${url}'`);
  }
}

/** Username/password for an HTTPS URL, or {} to let the server decide. */
function credentialsFor(git, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }
  if (!/^https?:$/.test(parsed.protocol)) return {};
  if (parsed.password) return { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) };
  const home = git.env.HOME ?? process.env.HOME;
  try {
    for (const line of fs.readFileSync(path.join(home, '.git-credentials'), 'utf8').split('\n')) {
      let entry;
      try {
        entry = new URL(line.trim());
      } catch {
        continue;
      }
      if (entry.protocol === parsed.protocol && entry.host === parsed.host && entry.password) {
        return { username: decodeURIComponent(entry.username), password: decodeURIComponent(entry.password) };
      }
    }
  } catch {}
  const token = git.env.GH_TOKEN ?? git.env.GITHUB_TOKEN;
  if (token && parsed.host === 'github.com') return { username: 'x-access-token', password: token };
  return {};
}

/** git's message for a failed network op. */
function networkFailure(git, error, url) {
  if (!(error instanceof OpError)) throw error;
  if (error.kind === 'auth' || /401|403/.test(error.message)) git.fatal(`Authentication failed for '${url}'`);
  if (/404|not found/i.test(error.message)) {
    git.warn('remote: Repository not found.\n');
    git.fatal(`repository '${url}' not found`);
  }
  if (error.kind === 'noremote') git.fatal(`'${url}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`);
  if (/unsupported URL protocol/i.test(error.message)) git.fatal(`Unable to find remote helper for '${url.split(':')[0]}'`);
  git.failOp(error.kind === 'network' ? error : error, { url });
}

async function remoteUrl(git, name) {
  if (isUrl(name) || isScp(name) || name.startsWith('/') || name.startsWith('.')) return name;
  const r = await git.call('remote', { action: 'get-url', name }).catch(() => null);
  if (!r) git.fatal(`'${name}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`);
  return r.url;
}

const shortRef = (ref) => ref.replace(/^refs\/(heads|tags|remotes)\//, '');

/**
 * " * [new branch]      main       -> origin/main" lines: git pads the summary
 * to 17 columns (two abbreviated ids and "..") and, for fetch, the source
 * names to the longest one (at least 10).
 */
function updateLines(rows, { padFrom = false } = {}) {
  const summaryWidth = Math.max(17, ...rows.map((r) => r.summary.length));
  const fromWidth = padFrom ? Math.max(10, ...rows.map((r) => r.from.length)) : 0;
  return rows.map((r) => ` ${r.flag} ${r.summary.padEnd(summaryWidth)} ${r.to === undefined ? r.from : `${r.from.padEnd(fromWidth)} -> ${r.to}`}${r.note ? ` ${r.note}` : ''}\n`).join('');
}

async function clone(git, argv) {
  const { opts, args } = parseOperands(git, argv, {
    'depth': 'value', 'b|branch': 'value', 'single-branch': 'bool', 'bare': 'bool', 'mirror': 'bool', 'n|no-checkout': 'bool',
    'q|quiet': 'bool', 'v|verbose': 'bool', 'recurse-submodules|recursive': 'optional', 'filter': 'value', 'o|origin': 'value',
    'shallow-since': 'value', 'shallow-exclude': 'value', 'c|config': 'list', 'progress': 'bool', 'tags': 'bool', 'template': 'value',
    'l|local': 'bool', 'no-hardlinks': 'bool', 's|shared': 'bool', 'reference': 'value', 'dissociate': 'bool', 'j|jobs': 'value',
    'separate-git-dir': 'value', 'also-filter-submodules': 'bool', 'remote-submodules': 'bool', 'shallow-submodules': 'bool', 'sparse': 'bool',
  });
  if (opts.mirror || (opts.origin && opts.origin !== 'origin') || opts['shallow-since'] || opts['shallow-exclude'] || opts['separate-git-dir'] || opts.sparse) {
    git.unsupported('clone --mirror/--origin/--shallow-since/--separate-git-dir/--sparse');
  }
  const [source, dirArg] = args;
  if (!source) git.usage('usage: git clone [<options>] [--] <repo> [<dir>]');
  refuseSsh(git, source);
  const url = isUrl(source) ? source : path.resolve(git.cwd, source);
  const name = dirArg ?? `${path.basename(source.replace(/\/+$/, '')).replace(/\.git$/, '')}${opts.bare ? '.git' : ''}`;
  const target = path.resolve(git.cwd, name);
  if (fs.existsSync(target) && fs.readdirSync(target).length) git.fatal(`destination path '${name}' already exists and is not an empty directory.`);
  git.assertWritable(target);
  if (!opts.quiet) git.warn(`Cloning into ${opts.bare ? 'bare repository ' : ''}'${name}'...\n`);
  if (opts['recurse-submodules']) git.warn('warning: submodules are not supported by git on iOS; skipping them\n');
  let r;
  try {
    r = await git.call('clone', {
      url, path: target, branch: opts.branch, depth: opts.depth, bare: opts.bare, noCheckout: opts['no-checkout'],
    }, credentialsFor(git, url));
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    if (error.kind === 'git' && /reference .* not found|cannot find remote branch/i.test(error.message)) git.fatal(`Remote branch ${opts.branch} not found in upstream origin`);
    networkFailure(git, error, source);
  }
  if (r.empty) git.warn('warning: You appear to have cloned an empty repository.\n');
  if (!opts.quiet) git.warn('done.\n');
}

async function fetchRemote(git, remote, refspecs, opts) {
  const url = await remoteUrl(git, remote);
  refuseSsh(git, url);
  const named = url !== remote;
  // `git fetch origin main` also updates origin/main, as git does for configured remotes.
  const specs = refspecs.map((s) => (s.includes(':') || s.startsWith('refs/') || s.includes('*') ? s : named ? `+refs/heads/${s}:refs/remotes/${remote}/${s}` : `refs/heads/${s}`));
  let r;
  try {
    r = await git.call('fetch', {
      remote, refspec: specs, depth: opts.depth, unshallow: opts.unshallow, prune: opts.prune,
      tags: opts.tags ? 'all' : opts.tags === false ? 'none' : undefined,
    }, credentialsFor(git, url));
  } catch (error) {
    networkFailure(git, error, url);
  }
  const rows = [];
  for (const u of r.updates) {
    if (u.ref === 'FETCH_HEAD') continue;
    const tag = u.ref.startsWith('refs/tags/');
    const from = u.source ? shortRef(u.source) : '(none)';
    const to = shortRef(u.ref);
    if (!u.new) rows.push({ flag: '-', summary: '[deleted]', from: '(none)', to });
    else if (!u.old) rows.push({ flag: '*', summary: tag ? '[new tag]' : '[new branch]', from, to });
    else rows.push({ flag: ' ', summary: `${u.old.slice(0, 7)}..${u.new.slice(0, 7)}`, from, to });
  }
  if (!named) for (const s of refspecs) rows.push({ flag: '*', summary: 'branch', from: s, to: 'FETCH_HEAD' });
  if (rows.length && !opts.quiet) git.warn(`From ${url}\n${updateLines(rows, { padFrom: true })}`);
  return { url, updates: r.updates };
}

const FETCH_OPTIONS = {
  'all': 'bool', 'p|prune': 'bool', 't|tags': 'bool', 'depth': 'value', 'unshallow': 'bool', 'q|quiet': 'bool',
  'v|verbose': 'bool', 'f|force': 'bool', 'progress': 'bool', 'recurse-submodules': 'optional', 'n': 'bool',
  'dry-run': 'bool', 'multiple': 'bool', 'P|prune-tags': 'bool', 'update-shallow': 'bool', 'j|jobs': 'value',
  'set-upstream': 'bool', 'atomic': 'bool', 'k|keep': 'bool', 'append': 'bool', 'write-fetch-head': 'bool', 'shallow-since': 'value',
};

async function fetch(git, argv) {
  const { opts, args } = parseOperands(git, argv, FETCH_OPTIONS);
  if (opts['dry-run'] || opts['shallow-since']) git.unsupported('fetch --dry-run/--shallow-since');
  const repo = await git.repo();
  await git.assertRepoWritable({ worktree: false });
  if (opts.all || opts.multiple) {
    const remotes = opts.all ? (await git.call('remote', { action: 'list' })).map((r) => r.name) : args;
    for (const name of remotes) {
      if (!opts.quiet && opts.verbose) git.warn(`Fetching ${name}\n`);
      await fetchRemote(git, name, [], opts);
    }
    return;
  }
  const remote = args[0] ?? (repo.head.upstream ? repo.head.upstream.split('/')[0] : 'origin');
  await fetchRemote(git, remote, args.slice(1), opts);
}

async function pull(git, argv) {
  const { opts, args } = parseOperands(git, argv, {
    ...FETCH_OPTIONS, 'r|rebase': 'optional', 'ff': 'bool', 'ff-only': 'bool', 'squash': 'bool', 'commit': 'bool',
    'e|edit': 'bool', 'autostash': 'bool', 'allow-unrelated-histories': 'bool', 's|strategy': 'value', 'X|strategy-option': 'list',
    'stat': 'bool', 'log': 'optional', 'signoff': 'bool', 'verify': 'bool', 'S|gpg-sign': 'optional', 'cleanup': 'value',
  });
  if (opts.autostash) git.unsupported('pull --autostash');
  const repo = await git.repo();
  if (repo.head.detached && !args.length) git.fatal('You are not currently on a branch.');
  let [remote, branch] = args;
  if (!remote) {
    if (!repo.head.upstream) {
      git.warn(`There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.\nSee git-pull(1) for details.\n\n    git pull <remote> <branch>\n\nIf you wish to set tracking information for this branch you can do so with:\n\n    git branch --set-upstream-to=origin/<branch> ${repo.head.branch}\n\n`);
      throw new Exit(1);
    }
    remote = await git.configValue(`branch.${repo.head.branch}.remote`) ?? repo.head.upstream.split('/')[0];
    branch = (await git.configValue(`branch.${repo.head.branch}.merge`))?.replace(/^refs\/heads\//, '') ?? repo.head.upstream.slice(remote.length + 1);
  } else if (!branch) {
    branch = repo.head.branch;
  }
  await git.assertRepoWritable();
  const { url } = await fetchRemote(git, remote, branch ? [branch] : [], opts);
  const rebase = opts.rebase !== undefined ? opts.rebase !== false && opts.rebase !== 'false' : ['true', 'merges', 'interactive'].includes(await git.configValue('pull.rebase'));
  const ffOnly = opts['ff-only'] || (opts.ff === undefined && (await git.configValue('pull.ff')) === 'only');
  const named = url !== remote;
  const target = named ? `refs/remotes/${remote}/${branch}` : 'FETCH_HEAD';
  const label = `branch '${branch}' of ${url}`;
  try {
    await mergeInto(git, target, { ...opts, 'ff-only': ffOnly || rebase }, { label });
  } catch (error) {
    const notFf = error instanceof Exit && rebase && git.err.some((l) => l.includes('Not possible to fast-forward'));
    if (notFf) {
      git.err = git.err.filter((l) => !l.includes('Not possible to fast-forward'));
      git.fatal('rebase is not supported by git on iOS (in-process libgit2) and the branches have diverged; run `git pull --no-rebase` to merge instead');
    }
    throw error;
  }
}

/** Expand one push refspec the way git does for short names. */
async function expandRefspec(git, spec, { force, current }) {
  let plus = force ? '+' : '';
  if (spec.startsWith('+')) {
    plus = '+';
    spec = spec.slice(1);
  }
  let [src, dst] = spec.includes(':') ? spec.split(':') : [spec, undefined];
  if (src === 'HEAD') {
    if (!current) git.fatal('You are not currently on a branch.');
    src = current;
  }
  const full = async (name) => {
    if (!name || name.startsWith('refs/')) return name;
    for (const prefix of ['refs/heads/', 'refs/tags/']) {
      const [r] = await git.call('revparse', { spec: `${prefix}${name}` }).catch(() => [null]);
      if (r) return `${prefix}${name}`;
    }
    return undefined;
  };
  const srcRef = src ? await full(src) : '';
  if (src && !srcRef) git.error(`src refspec ${src} does not match any`);
  const dstRef = dst === undefined ? srcRef : dst.startsWith('refs/') ? dst : `${srcRef?.startsWith('refs/tags/') ? 'refs/tags/' : 'refs/heads/'}${dst}`;
  return `${plus}${srcRef}:${dstRef}`;
}

async function push(git, argv) {
  const { opts, args } = parseOperands(git, argv, {
    'u|set-upstream': 'bool', 'f|force': 'bool', 'force-with-lease': 'optional', 'force-if-includes': 'bool', 'tags': 'bool',
    'all|branches': 'bool', 'd|delete': 'bool', 'n|dry-run': 'bool', 'q|quiet': 'bool', 'v|verbose': 'bool', 'porcelain': 'bool',
    'verify': 'bool', 'follow-tags': 'bool', 'atomic': 'bool', 'o|push-option': 'list', 'mirror': 'bool', 'prune': 'bool',
    'signed': 'optional', 'progress': 'bool', 'recurse-submodules': 'value', 'thin': 'bool', 'receive-pack|exec': 'value', '4|ipv4': 'bool', '6|ipv6': 'bool',
  });
  if (opts.mirror || opts.prune || opts['push-option'] || opts.signed) git.unsupported('push --mirror/--prune/--push-option/--signed');
  const repo = await git.repo();
  const current = repo.head.detached ? undefined : repo.head.branch;
  const remotes = (await git.call('remote', { action: 'list' })).map((r) => r.name);
  let remote = args[0];
  if (!remote) {
    remote = repo.head.upstream ? repo.head.upstream.split('/')[0] : remotes.length === 1 ? remotes[0] : remotes.includes('origin') ? 'origin' : undefined;
    if (!remote) git.fatal('No configured push destination.\nEither specify the URL from the command-line or configure a remote repository using\n\n    git remote add <name> <url>\n\nand then push using the remote name\n\n    git push <name>\n');
  }
  const force = opts.force || opts['force-with-lease'] !== undefined;
  let specs = args.slice(1);
  let setUpstream = opts['set-upstream'];
  if (opts.delete) {
    specs = specs.map((s) => `:${s.startsWith('refs/') ? s : `refs/heads/${s}`}`);
  } else if (opts.all) {
    const r = await git.call('branches', {});
    specs = r.branches.map((b) => `${force ? '+' : ''}${b.ref}:${b.ref}`);
  } else if (opts.tags && !specs.length) {
    specs = [];
  } else if (!specs.length) {
    if (!current) git.fatal('You are not currently on a branch.\nTo push the history leading to the current (detached HEAD)\nstate now, use\n\n    git push <remote> HEAD:<name-of-remote-branch>\n');
    const upstreamRemote = await git.configValue(`branch.${current}.remote`);
    const merge = await git.configValue(`branch.${current}.merge`);
    if (upstreamRemote === remote && merge) {
      specs = [`${force ? '+' : ''}refs/heads/${current}:${merge}`];
    } else if (!setUpstream && (await git.configValue('push.autoSetupRemote')) !== 'true' && args[0] === undefined) {
      git.fatal(`The current branch ${current} has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream ${remote} ${current}\n\nTo have this happen automatically for branches without a tracking\nupstream, see 'push.autoSetupRemote' in 'git help config'.\n`);
    } else {
      if ((await git.configValue('push.autoSetupRemote')) === 'true' && !merge) setUpstream = true;
      specs = [`${force ? '+' : ''}refs/heads/${current}:refs/heads/${current}`];
    }
  } else {
    specs = await Promise.all(specs.map((s) => expandRefspec(git, s, { force, current })));
  }
  if (opts.tags) {
    const tags = await git.call('tag', { action: 'list' });
    specs.push(...tags.map((t) => `refs/tags/${t}:refs/tags/${t}`));
  }
  if (opts['dry-run']) {
    git.warn(`To ${await remoteUrl(git, remote)}\n${specs.map((s) => ` * [dry run]  ${s}\n`).join('')}`);
    return;
  }
  const url = await remoteUrl(git, remote);
  refuseSsh(git, url);
  await git.assertRepoWritable({ worktree: false });
  let r;
  try {
    r = await git.call('push', { remote, refspec: specs }, credentialsFor(git, url));
  } catch (error) {
    if (error instanceof OpError && /non-fast-?forward/i.test(error.message)) {
      const names = specs.map((s) => s.replace(/^\+/, '').split(':').map(shortRef));
      git.warn(`To ${url}\n${updateLines(names.map(([a, b]) => ({ flag: '!', summary: '[rejected]', from: a, to: b, note: '(non-fast-forward)' })))}`);
      git.warn(`error: failed to push some refs to '${url}'\nhint: Updates were rejected because the tip of your current branch is behind\nhint: its remote counterpart. If you want to integrate the remote changes,\nhint: use 'git pull' before pushing again.\n`);
      throw new Exit(1);
    }
    networkFailure(git, error, url);
  }
  const failed = new Map(r.statuses.filter((s) => s.error).map((s) => [s.ref, s.error]));
  const rows = r.updates.filter((u) => u.old !== u.new || failed.has(u.dst)).map((u) => {
    const from = shortRef(u.src || '(delete)');
    const to = shortRef(u.dst);
    if (failed.has(u.dst)) return { flag: '!', summary: '[remote rejected]', from, to, note: `(${failed.get(u.dst)})` };
    if (!u.new) return { flag: '-', summary: '[deleted]', from: to };
    if (!u.old) return { flag: '*', summary: u.dst.startsWith('refs/tags/') ? '[new tag]' : '[new branch]', from, to };
    return { flag: force ? '+' : ' ', summary: `${u.old.slice(0, 7)}${force ? '...' : '..'}${u.new.slice(0, 7)}`, from, to, note: force ? '(forced update)' : '' };
  });
  if (!opts.quiet) git.warn(rows.length ? `To ${url}\n${updateLines(rows)}` : 'Everything up-to-date\n');
  if (failed.size) {
    git.warn(`error: failed to push some refs to '${url}'\n`);
    throw new Exit(1);
  }
  if (setUpstream) {
    for (const spec of specs) {
      const [src, dst] = spec.replace(/^\+/, '').split(':');
      if (!src.startsWith('refs/heads/') || !dst.startsWith('refs/heads/')) continue;
      const name = src.slice(11);
      const upstream = `${remote}/${dst.slice(11)}`;
      await git.call('branch-upstream', { name, upstream }).catch(() => {});
      if (!opts.quiet) git.print(`branch '${name}' set up to track '${upstream}'.\n`);
    }
  }
}

async function remoteCommand(git, argv) {
  const { opts, args } = parseOperands(git, argv, { 'v|verbose': 'bool' }, { stopAtFirstArg: true });
  const [sub, ...rest] = args;
  await git.repo();
  if (!sub) {
    const list = await git.call('remote', { action: 'list' });
    git.print(list.map((r) => (opts.verbose ? `${r.name}\t${r.url} (fetch)\n${r.name}\t${r.pushurl ?? r.url} (push)\n` : `${r.name}\n`)).join(''));
    return;
  }
  const write = ['add', 'remove', 'rm', 'rename', 'set-url', 'set-branches', 'set-head', 'prune'].includes(sub);
  if (write) await git.assertRepoWritable({ worktree: false });
  const fail = (error, name) => {
    if (error.kind === 'exists') git.error(`remote ${name} already exists.`, 3);
    if (error.kind === 'noremote') git.error(`No such remote: '${name}'`, 2);
    git.failOp(error);
  };
  switch (sub) {
    case 'add': {
      const { opts: o, args: a } = parseOperands(git, rest, { 'f|fetch': 'bool', 't|track': 'list', 'm|master': 'value', 'tags': 'bool', 'mirror': 'optional' });
      const [name, url] = a;
      if (!url) git.usage('usage: git remote add [<options>] <name> <url>');
      await git.call('remote', { action: 'add', name, url }).catch((e) => fail(e, name));
      if (o.fetch) await fetchRemote(git, name, [], {});
      return;
    }
    case 'remove':
    case 'rm':
      await git.call('remote', { action: 'remove', name: rest[0] }).catch((e) => fail(e, rest[0]));
      return;
    case 'rename':
      await git.call('remote', { action: 'rename', name: rest[0], to: rest[1] }).catch((e) => fail(e, rest[0]));
      return;
    case 'set-url': {
      const { opts: o, args: a } = parseOperands(git, rest, { 'push': 'bool', 'add': 'bool', 'delete': 'bool' });
      if (o.add || o.delete) git.unsupported('remote set-url --add/--delete');
      await git.call('remote', { action: 'set-url', name: a[0], url: a[1], push: o.push }).catch((e) => fail(e, a[0]));
      return;
    }
    case 'get-url': {
      const { opts: o, args: a } = parseOperands(git, rest, { 'push': 'bool', 'all': 'bool' });
      const r = await git.call('remote', { action: 'get-url', name: a[0], push: o.push }).catch((e) => fail(e, a[0]));
      git.print(`${r.url}\n`);
      return;
    }
    case 'show': {
      const list = await git.call('remote', { action: 'list' });
      const names = rest.filter((a) => !a.startsWith('-'));
      if (!names.length) {
        git.print(list.map((r) => `${r.name}\n`).join(''));
        return;
      }
      for (const name of names) {
        const r = list.find((x) => x.name === name);
        if (!r) git.fatal(`'${name}' does not appear to be a git repository`);
        const branches = (await git.call('branches', { remotes: true })).branches.filter((b) => b.name.startsWith(`${name}/`) && !b.symbolic);
        git.print(`* remote ${name}\n  Fetch URL: ${r.url}\n  Push  URL: ${r.pushurl ?? r.url}\n  Remote branches:\n${branches.map((b) => `    ${b.name.slice(name.length + 1)} tracked\n`).join('')}`);
      }
      return;
    }
    default:
      git.unsupported(`remote ${sub}`);
  }
}

async function lsRemote(git, argv) {
  const { opts, args: before, rest } = parseArgs(git, argv, {
    'h|heads|branches': 'bool', 't|tags': 'bool', 'refs': 'bool', 'q|quiet': 'bool', 'exit-code': 'bool', 'get-url': 'bool',
    'symref': 'bool', 'sort': 'value', 'upload-pack': 'value', 'o|server-option': 'list',
  });
  let [remote, ...patterns] = [...before, ...(rest ?? [])];
  if (!remote) {
    const repo = await git.repo();
    remote = repo.head.upstream ? repo.head.upstream.split('/')[0] : 'origin';
  }
  const url = await remoteUrl(git, remote);
  refuseSsh(git, url);
  if (opts['get-url']) {
    git.print(`${url}\n`);
    return;
  }
  let heads;
  try {
    heads = await git.call('ls-remote', { remote: isUrl(url) ? url : remote }, credentialsFor(git, url));
  } catch (error) {
    networkFailure(git, error, url);
  }
  heads = heads.filter((h) => {
    if (opts.heads && !h.name.startsWith('refs/heads/')) return false;
    if (opts.tags && !h.name.startsWith('refs/tags/')) return false;
    if (opts.refs && (h.name === 'HEAD' || h.name.endsWith('^{}'))) return false;
    return !patterns.length || patterns.some((p) => h.name === p || h.name.endsWith(`/${p}`) || new RegExp(`(^|/)${p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(h.name));
  });
  if (opts['exit-code'] && !heads.length) throw new Exit(2);
  if (opts.quiet) return;
  git.print(heads.map((h) => `${opts.symref && h.symref ? `ref: ${h.symref}\t${h.name}\n` : ''}${h.oid}\t${h.name}\n`).join(''));
}

export default { clone, fetch, pull, push, remote: remoteCommand, 'ls-remote': lsRemote };
