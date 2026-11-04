// Plumbing and configuration: rev-parse, ls-files, ls-tree, cat-file, write-tree,
// check-ignore, hash-object, merge-base, show-ref, symbolic-ref, check-ref-format, config.
import path from 'node:path';
import { Exit, OpError, parseArgs, parseOperands } from '../core.mjs';
import { octal } from '../format.mjs';

/** GIT_DIR as git spells it: ".git" from the top of the work tree, absolute otherwise. */
function gitDirShown(git, repo) {
  return repo.workdir && git.cwd === repo.workdir && repo.gitdir === path.join(repo.workdir, '.git') ? '.git' : repo.gitdir;
}

async function revParse(git, argv) {
  const out = [];
  let verify = false;
  let quiet = false;
  let short;
  let abbrevRef = false;
  let revsSeen = false;
  const revs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const needRepo = async () => git.repo();
    switch (a) {
      case '--show-toplevel': out.push((await git.workdir())); break;
      case '--git-dir': out.push(gitDirShown(git, await needRepo())); break;
      case '--absolute-git-dir': out.push((await needRepo()).gitdir); break;
      case '--git-common-dir': out.push((await needRepo()).commondir); break;
      case '--git-path': {
        const repo = await needRepo();
        const name = argv[++i];
        const perWorktree = /^(HEAD|index|logs\/HEAD|ORIG_HEAD|MERGE_HEAD|FETCH_HEAD)$/.test(name);
        const dir = perWorktree || repo.gitdir === repo.commondir ? gitDirShown(git, repo) : repo.commondir;
        out.push(path.join(dir, name));
        break;
      }
      case '--is-inside-work-tree': {
        const repo = await git.call('discover').catch(() => null);
        out.push(repo?.workdir && (git.cwd + '/').startsWith(repo.workdir) ? 'true' : 'false');
        if (!repo) git.fatal('not a git repository (or any of the parent directories): .git');
        break;
      }
      case '--is-inside-git-dir': {
        const repo = await needRepo();
        out.push((git.cwd + '/').startsWith(repo.gitdir + '/') ? 'true' : 'false');
        break;
      }
      case '--is-bare-repository': out.push(String((await needRepo()).bare)); break;
      case '--is-shallow-repository': out.push(String((await needRepo()).shallow)); break;
      case '--show-prefix': {
        const rel = path.relative(await git.workdir(), git.cwd);
        out.push(rel ? `${rel}/` : '');
        break;
      }
      case '--show-cdup': {
        const rel = path.relative(git.cwd, await git.workdir());
        out.push(rel ? `${rel}/` : '');
        break;
      }
      case '--show-superproject-working-tree': break;
      case '--local-env-vars': out.push('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'); break;
      case '--verify': verify = true; break;
      case '-q': case '--quiet': quiet = true; break;
      case '--short': short = 7; break;
      case '--abbrev-ref': abbrevRef = true; break;
      case '--symbolic-full-name': abbrevRef = 'full'; break;
      case '--sq-quote': out.push(argv.slice(i + 1).map((s) => `'${s.replace(/'/g, "'\\''")}'`).join(' ')); i = argv.length; break;
      case '--':
      case '--end-of-options': revsSeen = true; break;
      case '--default': i++; break;
      case '--all': {
        const r = await git.call('refs');
        out.push(...r.refs.filter((x) => x.oid && x.name !== 'HEAD').map((x) => x.oid));
        break;
      }
      default:
        if (a.startsWith('--short=')) short = Number(a.slice(8));
        else if (a.startsWith('--abbrev-ref=')) abbrevRef = true;
        else if (a.startsWith('--git-path=')) argv.splice(i + 1, 0, a.slice(11));
        else if (a.startsWith('-') && !revsSeen) out.push(a);
        else revs.push(a);
    }
  }
  if (verify && revs.length !== 1) {
    if (quiet) throw new Exit(1);
    git.fatal('Needed a single revision');
  }
  if (revs.length) {
    await git.repo();
    const peel = (spec) => {
      const m = /^(.*)\^\{(commit|tree|blob|tag|)\}$/.exec(spec);
      return m ? { spec: m[1], type: m[2] } : { spec };
    };
    for (const raw of revs) {
      const { spec, type } = peel(raw);
      const [r] = await git.call('revparse', { spec, peel: type ? { commit: 1, tree: 2, blob: 3, tag: 4 }[type] : undefined }).catch(() => [null]);
      if (!r) {
        if (verify) {
          if (quiet) throw new Exit(1);
          git.fatal('Needed a single revision');
        }
        if (abbrevRef === true && raw === 'HEAD') {
          const repo = await git.repo();
          out.push(repo.head.detached ? 'HEAD' : repo.head.branch);
          continue;
        }
        git.print(`${out.map((l) => `${l}\n`).join('')}${raw}\n`);
        git.fatal(`ambiguous argument '${raw}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
      }
      if (abbrevRef === true) out.push(r.ref ? r.ref.replace(/^refs\/(heads|tags|remotes)\//, '') : raw === 'HEAD' || /^HEAD/.test(raw) ? 'HEAD' : raw);
      else if (abbrevRef === 'full') out.push(r.ref ?? raw);
      else out.push(short ? r.oid.slice(0, Math.max(short, r.short.length)) : r.oid);
    }
  }
  git.print(out.map((l) => `${l}\n`).join(''));
}

async function lsFiles(git, argv) {
  const { opts, args, rest } = parseArgs(git, argv, {
    'c|cached': 'bool', 's|stage': 'bool', 'o|others': 'bool', 'i|ignored': 'bool', 'm|modified': 'bool', 'd|deleted': 'bool',
    'u|unmerged': 'bool', 'z': 'bool', 'exclude-standard': 'bool', 'directory': 'bool', 'no-empty-directory': 'bool',
    'full-name': 'bool', 'error-unmatch': 'bool', 'x|exclude': 'list', 'X|exclude-from': 'value', 'v': 'bool', 't': 'bool',
    'eol': 'bool', 'deduplicate': 'bool', 'recurse-submodules': 'bool', 'abbrev': 'optional', 'format': 'value',
  });
  const root = await git.workdir();
  const end = opts.z ? '\0' : '\n';
  const specs = [...args, ...(rest ?? [])];
  const prefix = path.relative(root, git.cwd);
  const show = (p) => (opts['full-name'] ? p : path.relative(git.cwd, path.join(root, p)));
  const inScope = (p) => !prefix || p === prefix || p.startsWith(`${prefix}/`);
  const paths = await git.pathspecs(specs);
  const matches = (p) => !paths.length || paths.some((s) => s === '*' || p === s || p.startsWith(`${s}/`) || (/[*?[]/.test(s) && new RegExp(`^${s.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(p)));
  const lines = [];
  if (opts.others || opts.ignored) {
    const s = await git.call('status', { untracked: opts.directory ? 'normal' : 'all', ignored: opts.ignored });
    for (const e of s.entries) {
      if ((opts.others && e.xy === '??' && !opts.ignored) || (opts.ignored && e.xy === '!!')) if (inScope(e.path) && matches(e.path)) lines.push(`${show(e.path)}${end}`);
    }
  }
  if (opts.modified || opts.deleted) {
    const s = await git.call('status', { untracked: 'no' });
    for (const e of s.entries) {
      if ((opts.modified && /[MDT]/.test(e.xy[1])) || (opts.deleted && e.xy[1] === 'D')) if (inScope(e.path) && matches(e.path)) lines.push(`${show(e.path)}${end}`);
    }
  }
  if (opts.cached || opts.stage || opts.unmerged || (!opts.others && !opts.ignored && !opts.modified && !opts.deleted)) {
    const entries = await git.call('ls-files');
    for (const e of entries) {
      if (opts.unmerged && e.stage === 0) continue;
      if (!inScope(e.path) || !matches(e.path)) continue;
      lines.push(opts.stage || opts.unmerged ? `${octal(e.mode)} ${e.oid} ${e.stage}\t${show(e.path)}${end}` : `${show(e.path)}${end}`);
    }
  }
  if (opts['error-unmatch'] && specs.length && !lines.length) {
    git.error(`pathspec '${specs[0]}' did not match any file(s) known to git\nDid you forget to 'git add'?`);
  }
  git.print([...new Set(lines)].join(''));
}

async function lsTree(git, argv) {
  const { opts, args, rest } = parseArgs(git, argv, {
    'r': 'bool', 't': 'bool', 'd': 'bool', 'l|long': 'bool', 'z': 'bool', 'name-only|name-status': 'bool', 'object-only': 'bool',
    'full-name': 'bool', 'full-tree': 'bool', 'abbrev': 'optional', 'format': 'value',
  });
  const [tree, ...more] = args;
  if (!tree) git.usage('usage: git ls-tree [<options>] <tree-ish> [<path>...]');
  const specs = [...more, ...(rest ?? [])];
  const root = (await git.repo()).workdir ?? git.cwd;
  const filters = specs.map((s) => path.relative(root, path.resolve(git.cwd, s)) + (s.endsWith('/') ? '/' : ''));
  let entries;
  try {
    entries = await git.call('ls-tree', { tree, recursive: true, trees: true, sizes: opts.long });
  } catch (error) {
    if (error instanceof OpError && error.kind === 'badrev') git.fatal('not a tree object');
    git.failOp(error);
  }
  const depth = (p) => p.split('/').length;
  const shown = entries.filter((e) => {
    if (filters.length) {
      return filters.some((f) => {
        if (f.endsWith('/')) return e.path.startsWith(f) && (opts.r ? e.type !== 'tree' || opts.t : depth(e.path) === depth(f));
        if (e.path === f) return true;
        return opts.r && e.path.startsWith(`${f}/`) && (e.type !== 'tree' || opts.t);
      });
    }
    if (opts.d) return e.type === 'tree' && (opts.r || depth(e.path) === 1);
    if (opts.r) return e.type !== 'tree' || opts.t;
    return depth(e.path) === 1;
  });
  const end = opts.z ? '\0' : '\n';
  git.print(shown.map((e) => {
    if (opts['name-only']) return `${e.path}${end}`;
    if (opts['object-only']) return `${e.oid}${end}`;
    const size = opts.long ? ` ${String(e.type === 'blob' ? e.size ?? '-' : '-').padStart(7)}` : '';
    return `${octal(e.mode)} ${e.type} ${e.oid}${size}\t${e.path}${end}`;
  }).join(''));
}

async function catFile(git, argv) {
  const { opts, args } = parseOperands(git, argv, {
    't': 'bool', 's': 'bool', 'p': 'bool', 'e': 'bool', 'batch': 'optional', 'batch-check': 'optional', 'textconv': 'bool', 'filters': 'bool', 'allow-unknown-type': 'bool',
  });
  if (opts.batch !== undefined || opts['batch-check'] !== undefined) {
    const lines = git.stdin.split('\n').filter(Boolean);
    for (const spec of lines) {
      try {
        const r = await git.call('cat', { spec });
        const { value, data } = r.value ? r : { value: r };
        git.print(`${value.oid} ${value.type} ${value.size}\n`);
        if (opts.batch !== undefined) git.print(`${data ? data.toString('utf8') : ''}\n`);
      } catch {
        git.print(`${spec} missing\n`);
      }
    }
    return;
  }
  let [type, spec] = args;
  if (!spec) {
    spec = type;
    type = undefined;
  }
  let r;
  try {
    r = await git.call('cat', { spec, peel: type });
  } catch (error) {
    if (opts.e) throw new Exit(1);
    if (error instanceof OpError && (error.kind === 'badrev' || error.kind === 'notcommit')) git.fatal(`Not a valid object name ${spec}`);
    git.failOp(error);
  }
  if (opts.e) return;
  const { value, data } = r.value ? r : { value: r };
  if (opts.t) git.print(`${value.type}\n`);
  else if (opts.s) git.print(`${value.size}\n`);
  else if (value.type === 'tree' && (opts.p || type)) git.print(value.entries.map((e) => `${octal(e.mode)} ${e.type} ${e.oid}\t${e.name}\n`).join(''));
  else git.print(data.toString('utf8'));
}

async function writeTree(git) {
  await git.assertRepoWritable({ worktree: false });
  const r = await git.call('write-tree').catch((e) => git.failOp(e));
  git.print(`${r.oid}\n`);
}

async function checkIgnore(git, argv) {
  const { opts, args } = parseOperands(git, argv, { 'q|quiet': 'bool', 'v|verbose': 'bool', 'stdin': 'bool', 'z': 'bool', 'n|non-matching': 'bool', 'no-index': 'bool' });
  const root = await git.workdir();
  const inputs = opts.stdin ? git.stdin.split(opts.z ? '\0' : '\n').filter(Boolean) : args;
  if (!inputs.length) git.fatal('no path specified');
  const rel = new Map(inputs.map((p) => [path.relative(root, path.resolve(git.cwd, p)), p]));
  const ignored = await git.call('check-ignore', { path: [...rel.keys()] }).catch((e) => git.failOp(e));
  const end = opts.z ? '\0' : '\n';
  if (!opts.quiet) git.print(ignored.map((p) => `${opts.verbose ? `::\t` : ''}${rel.get(p) ?? p}${end}`).join(''));
  if (!ignored.length) throw new Exit(1);
}

async function hashObject(git, argv) {
  const { opts, args } = parseOperands(git, argv, { 'w': 'bool', 't': 'value', 'stdin': 'bool', 'stdin-paths': 'bool', 'no-filters': 'bool', 'literally': 'bool', 'path': 'value' });
  if (opts.stdin || (opts.t && opts.t !== 'blob')) git.unsupported('hash-object --stdin/-t');
  const files = opts['stdin-paths'] ? git.stdin.split('\n').filter(Boolean) : args;
  if (opts.w) await git.assertRepoWritable({ worktree: false });
  const oids = await git.call('hash-object', { write: opts.w, path: files.map((f) => path.resolve(git.cwd, f)) }).catch((e) => git.failOp(e));
  git.print(oids.map((o) => `${o}\n`).join(''));
}

async function mergeBase(git, argv) {
  const { opts, args } = parseOperands(git, argv, { 'is-ancestor': 'bool', 'a|all': 'bool', 'octopus': 'bool', 'independent': 'bool', 'fork-point': 'bool' });
  if (opts.octopus || opts.independent || opts['fork-point']) git.unsupported('merge-base --octopus/--independent/--fork-point');
  if (args.length < 2) git.usage('usage: git merge-base [-a | --all] <commit> <commit>...');
  let r;
  try {
    r = await git.call('merge-base', { spec: args.slice(0, 2) });
  } catch (error) {
    if (error.kind === 'nobase') throw new Exit(1);
    if (error.kind === 'badrev') git.fatal(`Not a valid object name ${error.message}`);
    git.failOp(error);
  }
  if (opts['is-ancestor']) {
    if (!r.ancestor) throw new Exit(1);
    return;
  }
  git.print(`${r.oid}\n`);
}

async function showRef(git, argv) {
  const { opts, args } = parseOperands(git, argv, {
    'verify': 'bool', 'q|quiet': 'bool', 'heads|branches': 'bool', 'tags': 'bool', 'head': 'bool', 'd|dereference': 'bool',
    's|hash': 'optional', 'abbrev': 'optional', 'exists': 'bool', 'exclude-existing': 'optional',
  });
  const r = await git.call('refs').catch((e) => git.failOp(e));
  let refs = r.refs.filter((x) => x.oid);
  if (opts.verify || opts.exists) refs = refs.filter((x) => args.includes(x.name));
  else {
    if (!opts.head) refs = refs.filter((x) => x.name !== 'HEAD');
    if (opts.heads || opts.tags) refs = refs.filter((x) => (opts.heads && x.name.startsWith('refs/heads/')) || (opts.tags && x.name.startsWith('refs/tags/')));
    if (args.length) refs = refs.filter((x) => args.some((p) => x.name === p || x.name.endsWith(`/${p}`)));
  }
  if (opts.exists) {
    if (!refs.length) throw new Exit(2);
    return;
  }
  if (!refs.length) {
    if (opts.verify && !opts.quiet) git.fatal(`'${args[0]}' - not a valid ref`);
    throw new Exit(1);
  }
  if (opts.quiet) return;
  git.print(refs.sort((a, b) => a.name.localeCompare(b.name)).map((x) => {
    const oid = opts.hash !== undefined ? x.oid : `${x.oid} ${x.name}`;
    const peeled = opts.dereference && x.commit && x.commit !== x.oid ? `\n${x.commit} ${x.name}^{}` : '';
    return `${oid}${peeled}\n`;
  }).join(''));
}

async function symbolicRef(git, argv) {
  const { opts, args } = parseOperands(git, argv, { 'q|quiet': 'bool', 'short': 'bool', 'd|delete': 'bool', 'm': 'value', 'no-recurse': 'bool' });
  if (args.length > 1 || opts.delete) git.unsupported('symbolic-ref (writing)');
  if (args[0] && args[0] !== 'HEAD') git.unsupported(`symbolic-ref ${args[0]}`);
  const repo = await git.repo();
  if (repo.head.detached) {
    if (opts.quiet) throw new Exit(1);
    git.fatal('ref HEAD is not a symbolic ref');
  }
  git.print(`${opts.short ? repo.head.branch : repo.head.ref}\n`);
}

/** git's refname rules (check-ref-format(1)). */
export function validRefName(name, { allowOneLevel = false } = {}) {
  if (!allowOneLevel && !name.includes('/')) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.includes('//')) return false;
  if (name === '@' || name.includes('@{') || name.includes('..')) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return name.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

async function checkRefFormat(git, argv) {
  const { opts, args } = parseOperands(git, argv, { 'branch': 'bool', 'allow-onelevel': 'bool', 'refspec-pattern': 'bool', 'normalize|print': 'bool' });
  const name = args[0] ?? '';
  const ok = opts.branch ? validRefName(`refs/heads/${name}`) && !name.startsWith('-') : validRefName(name, { allowOneLevel: opts['allow-onelevel'] });
  if (!ok) {
    if (opts.branch) git.fatal(`'${name}' is not a valid branch name`, 128);
    throw new Exit(1);
  }
  if (opts.branch || opts.normalize) git.print(`${name.replace(/\/+/g, '/')}\n`);
}

async function config(git, argv) {
  // `git config get|set|unset|list` (git 2.46+) and the classic flag forms.
  const verbs = { get: '--get', set: null, unset: '--unset', list: '--list' };
  if (argv[0] in verbs) {
    const verb = argv[0];
    argv = argv.slice(1);
    if (verb === 'get') argv = ['--get', ...argv.map((a) => (a === '--all' ? '--get-all' : a))].filter((a, i, all) => !(a === '--get' && all.includes('--get-all')));
    else if (verb === 'unset') argv = [argv.includes('--all') ? '--unset-all' : '--unset', ...argv.filter((a) => a !== '--all')];
    else if (verb === 'list') argv = ['--list', ...argv];
    else argv = argv.includes('--append') ? ['--add', ...argv.filter((a) => a !== '--append')] : argv;
  }
  const { opts, args } = parseOperands(git, argv, {
    'global': 'bool', 'system': 'bool', 'local': 'bool', 'worktree': 'bool', 'f|file': 'value', 'get': 'bool', 'get-all': 'bool',
    'get-regexp': 'bool', 'l|list': 'bool', 'unset': 'bool', 'unset-all': 'bool', 'add': 'bool', 'replace-all': 'bool',
    'name-only': 'bool', 'z|null': 'bool', 'show-origin': 'bool', 'show-scope': 'bool', 'bool': 'bool', 'int': 'bool',
    'type': 'value', 'default': 'value', 'includes': 'bool', 'e|edit': 'bool', 'blob': 'value', 'fixed-value': 'bool',
  });
  if (opts.edit) git.unsupported('config --edit');
  const scope = opts.global ? 'global' : opts.system ? 'system' : opts.local ? 'local' : opts.worktree ? 'local' : undefined;
  const file = opts.file && path.resolve(git.cwd, opts.file);
  const end = opts.null ? '\0' : '\n';
  const call = (action, extra) => git.call('config', { action, scope, file, home: git.env.HOME, ...extra });
  const fail = (error, key) => {
    if (error instanceof OpError && error.kind === 'nokey') throw new Exit(5);
    if (error instanceof OpError && error.kind === 'notrepo') git.fatal('not in a git directory');
    if (error instanceof OpError && /invalid config item name|invalid key/i.test(error.message)) git.error(`invalid key: ${key}`);
    git.failOp(error);
  };
  const normalize = (value) => {
    if (opts.bool || opts.type === 'bool') return /^(true|yes|on|1|)$/i.test(value ?? '') ? 'true' : 'false';
    return value;
  };
  const writeTarget = () => {
    if (scope === 'global') git.assertWritable(path.join(git.env.HOME ?? '', '.gitconfig'));
    else if (file) git.assertWritable(file);
  };
  if (opts.list) {
    const entries = await call('list').catch((e) => fail(e));
    git.print(entries.map((e) => `${opts['show-scope'] ? `${e.scope}\t` : ''}${opts['name-only'] ? e.name : `${e.name}=${e.value ?? ''}`}${end}`).join(''));
    return;
  }
  if (opts['get-regexp']) {
    const entries = await call('get-regexp', { pattern: args[0] }).catch((e) => fail(e));
    if (!entries.length) throw new Exit(1);
    git.print(entries.map((e) => (opts['name-only'] ? `${e.name}${end}` : `${e.name}${opts.null ? '\n' : ' '}${normalize(e.value) ?? ''}${end}`)).join(''));
    return;
  }
  if (opts.unset || opts['unset-all']) {
    if (!scope && !file) await git.repo();
    writeTarget();
    await call(opts.unset ? 'unset' : 'unset-all', { key: args[0] }).catch((e) => fail(e, args[0]));
    return;
  }
  const [key, value] = args;
  if (!key) git.usage('usage: git config [<options>]');
  if (opts.get || opts['get-all'] || value === undefined) {
    const entries = await call('get-all', { key }).catch((e) => fail(e, key));
    if (!entries.length) {
      if (opts.default !== undefined) {
        git.print(`${opts.default}${end}`);
        return;
      }
      throw new Exit(1);
    }
    const shown = opts['get-all'] ? entries : entries.slice(-1);
    git.print(shown.map((e) => `${opts['show-scope'] ? `${e.scope}\t` : ''}${normalize(e.value) ?? ''}${end}`).join(''));
    return;
  }
  if (!scope && !file) await git.repo();
  writeTarget();
  await call(opts.add ? 'add' : 'set', { key, value }).catch((e) => fail(e, key));
}

export default {
  'rev-parse': revParse, 'ls-files': lsFiles, 'ls-tree': lsTree, 'cat-file': catFile, 'write-tree': writeTree,
  'check-ignore': checkIgnore, 'hash-object': hashObject, 'merge-base': mergeBase, 'show-ref': showRef,
  'symbolic-ref': symbolicRef, 'check-ref-format': checkRefFormat, config,
};
