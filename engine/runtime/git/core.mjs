// One git invocation: its environment, output, the repository it addresses,
// and the helpers commands share (option parsing, pathspecs, errors).
import fs from 'node:fs';
import path from 'node:path';
import { binding } from './binding.mjs';

/** Ends the command with an exit status; the output so far is kept. */
export class Exit extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.exitCode = code;
  }
}

/** A failed addon op: `kind` is the stable error code from native/git. */
export class OpError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const ZERO = '0'.repeat(40);

function realpath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

export class Git {
  /**
   * @param io.cwd absolute working directory
   * @param io.env the command's environment (strings)
   * @param io.stdin standard input as text
   * @param io.writable roots writable under confinement; undefined when unconfined
   * @param io.signal cancellation
   */
  constructor({ cwd, env = {}, stdin = '', writable, signal }) {
    // libgit2 reports canonical paths; the relative paths git prints are
    // computed against the same spelling.
    this.cwd = realpath(cwd);
    this.env = env;
    this.stdin = stdin;
    this.writable = writable;
    this.signal = signal;
    this.out = [];
    this.err = [];
    this.overrides = new Map();
    this.gitDir = env.GIT_DIR ? path.resolve(cwd, env.GIT_DIR) : undefined;
    this.workTree = env.GIT_WORK_TREE ? path.resolve(cwd, env.GIT_WORK_TREE) : undefined;
    this.literal = env.GIT_LITERAL_PATHSPECS === '1';
    // GIT_CONFIG_COUNT/KEY_n/VALUE_n, as `-c` would set them.
    const count = Number(env.GIT_CONFIG_COUNT ?? 0);
    for (let i = 0; i < count; i++) {
      if (env[`GIT_CONFIG_KEY_${i}`]) this.overrides.set(env[`GIT_CONFIG_KEY_${i}`].toLowerCase(), env[`GIT_CONFIG_VALUE_${i}`] ?? '');
    }
  }

  /** `-C <dir>`: a new working directory, canonical like the first. */
  resolveCwd(dir) { return realpath(path.resolve(this.cwd, dir)); }

  print(text) { this.out.push(text); }
  warn(text) { this.err.push(text); }
  fatal(message, code = 128) { this.warn(`fatal: ${message}\n`); throw new Exit(code); }
  error(message, code = 1) { this.warn(`error: ${message}\n`); throw new Exit(code); }
  usage(message) { this.warn(`${message}\n`); throw new Exit(129); }
  unsupported(what) {
    this.fatal(`${what} is not supported by git on iOS (in-process libgit2)`);
  }

  repoOptions() {
    const env = this.env;
    const resolve = (p) => (p ? path.resolve(this.cwd, p) : undefined);
    return {
      cwd: this.cwd,
      gitDir: this.gitDir,
      workTree: this.workTree,
      indexFile: resolve(env.GIT_INDEX_FILE),
      objectDirectory: resolve(env.GIT_OBJECT_DIRECTORY),
      alternates: env.GIT_ALTERNATE_OBJECT_DIRECTORIES?.split(':').map((p) => resolve(p)).join(':'),
    };
  }

  /** Run an addon op; `args` values: true → "1", arrays repeat the key, nullish/false skip. */
  async call(op, args = {}, extra = {}) {
    const list = [];
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === null || value === false) continue;
      for (const item of Array.isArray(value) ? value : [value]) list.push(`${key}=${item === true ? 1 : item}`);
    }
    const promise = binding().run(op, list, { ...this.repoOptions(), ...extra });
    const cancel = () => promise.cancel();
    this.signal?.addEventListener('abort', cancel, { once: true });
    try {
      const result = await promise;
      const value = JSON.parse(result.json);
      return result.data ? { value, data: result.data } : value;
    } catch (error) {
      if (error instanceof SyntaxError) throw error;
      throw new OpError(error.code ?? 'git', error.message);
    } finally {
      this.signal?.removeEventListener('abort', cancel);
    }
  }

  /** The repository, or git's fatal error outside one. */
  async repo() {
    if (!this._repo) {
      try {
        this._repo = await this.call('discover');
      } catch (error) {
        if (error.kind === 'notrepo') this.fatal('not a git repository (or any of the parent directories): .git');
        throw error;
      }
      this._repo.workdir = this._repo.workdir?.replace(/\/$/, '');
      this._repo.gitdir = this._repo.gitdir.replace(/\/$/, '');
      this._repo.commondir = this._repo.commondir.replace(/\/$/, '');
    }
    return this._repo;
  }

  async workdir() {
    const repo = await this.repo();
    if (!repo.workdir) this.fatal('this operation must be run in a work tree');
    return repo.workdir;
  }

  /** `-c` / GIT_CONFIG_* value, or undefined. */
  override(key) { return this.overrides.get(key.toLowerCase()); }

  /** A config value from overrides or the repository's (or global) config. */
  async configValue(key) {
    if (this.overrides.has(key.toLowerCase())) return this.override(key);
    try {
      const entries = await this.call('config', { action: 'get-all', key });
      return entries.at(-1)?.value;
    } catch {
      return undefined;
    }
  }

  /** Author/committer identity arguments for ops that write commits. */
  identity() {
    const env = this.env;
    const date = (value) => (value ? parseDate(value) : undefined);
    const name = this.override('user.name');
    const email = this.override('user.email');
    return {
      authorName: env.GIT_AUTHOR_NAME ?? name,
      authorEmail: env.GIT_AUTHOR_EMAIL ?? email,
      authorTime: date(env.GIT_AUTHOR_DATE),
      committerName: env.GIT_COMMITTER_NAME ?? name,
      committerEmail: env.GIT_COMMITTER_EMAIL ?? email,
      committerTime: date(env.GIT_COMMITTER_DATE),
    };
  }

  /**
   * Pathspecs relative to cwd → relative to the work tree root, in libgit2's
   * syntax: `.` and the root itself match everything, `:/x` and `:(top)x` are
   * root-relative, `:(exclude)x` / `:!x` / `:^x` become `!x`.
   */
  async pathspecs(specs) {
    if (!specs.length) return [];
    const root = await this.workdir();
    const out = [];
    for (let spec of specs) {
      let negate = false;
      let top = false;
      const magic = /^:\(([^)]*)\)(.*)$/s.exec(spec);
      if (magic) {
        const words = magic[1].split(',');
        negate = words.includes('exclude');
        top = words.includes('top');
        if (words.includes('literal')) this.literal = true;
        spec = magic[2];
      } else if (/^:[!^]/.test(spec)) {
        negate = true;
        spec = spec.slice(2);
      } else if (spec.startsWith(':/')) {
        top = true;
        spec = spec.slice(2);
      }
      const base = top ? root : this.cwd;
      const rel = path.relative(root, path.resolve(base, spec || '.'));
      if (rel.startsWith('..') || path.isAbsolute(rel)) this.fatal(`${spec}: '${spec}' is outside repository at '${root}'`);
      if (rel === '') {
        if (negate) continue;
        return negateOnly(out);
      }
      out.push(`${negate ? '!' : ''}${rel}`);
    }
    return out;
  }

  /** A repository-relative path as git shows it from cwd. */
  show(repoPath, root) {
    const rel = path.relative(this.cwd, path.join(root, repoPath));
    return repoPath.endsWith('/') && !rel.endsWith('/') ? `${rel}/` : rel || '.';
  }

  /** Under confinement, refuse writes outside the writable roots, as the filesystem would. */
  assertWritable(...targets) {
    if (!this.writable) return;
    for (const target of targets.filter(Boolean)) {
      const inside = this.writable.some((root) => target === root || target.startsWith(`${root}/`));
      if (!inside) this.fatal(`Unable to write '${target}': Read-only file system`);
    }
  }

  /** Writes to the index, objects and refs of the current repository (and its work tree). */
  async assertRepoWritable({ worktree = true } = {}) {
    if (!this.writable) return;
    const repo = await this.repo();
    const options = this.repoOptions();
    this.assertWritable(options.indexFile ?? repo.gitdir, options.objectDirectory ?? repo.commondir, worktree ? repo.workdir : undefined);
  }

  /** Report an addon error the way git would, by kind. */
  failOp(error, context = {}) {
    if (!(error instanceof OpError)) throw error;
    switch (error.kind) {
      case 'notrepo': this.fatal('not a git repository (or any of the parent directories): .git');
      case 'noident': this.identityError(error.message);
      case 'auth': this.fatal(`Authentication failed for '${context.url ?? ''}'`);
      case 'network': this.fatal(`unable to access '${context.url ?? ''}': ${error.message}`);
      case 'badrev': this.fatal(`ambiguous argument '${error.message}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
      case 'nomatch': this.fatal(`pathspec '${error.message}' did not match any files`);
      case 'unborn': this.fatal(`your current branch '${context.branch ?? 'master'}' does not have any commits yet`);
      case 'cancelled': this.fatal('operation cancelled', 130);
      default: this.fatal(error.message);
    }
  }

  identityError(detail) {
    this.warn(`Author identity unknown

*** Please tell me who you are.

Run

  git config --global user.email "you@example.com"
  git config --global user.name "Your Name"

to set your account's default identity.
Omit --global to set the identity only in this repository.

`);
    this.fatal(detail || 'unable to auto-detect email address');
  }
}

function negateOnly(specs) {
  // The root matched everything: keep only exclusions (which libgit2 needs a positive base for).
  const excludes = specs.filter((s) => s.startsWith('!'));
  return excludes.length ? ['*', ...excludes] : [];
}

/** Dates as git accepts them in GIT_*_DATE / --date: "<unix> <tz>", ISO 8601, or anything Date parses. */
export function parseDate(text) {
  const raw = /^@?(\d+)(?: ([+-])(\d\d)(\d\d))?$/.exec(text.trim());
  if (raw) {
    const offset = raw[2] ? (raw[2] === '-' ? -1 : 1) * (Number(raw[3]) * 60 + Number(raw[4])) : 0;
    return `${raw[1]} ${offset}`;
  }
  const iso = /([+-])(\d\d):?(\d\d)$/.exec(text.trim());
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return undefined;
  const offset = iso ? (iso[1] === '-' ? -1 : 1) * (Number(iso[2]) * 60 + Number(iso[3])) : -new Date(ms).getTimezoneOffset();
  return `${Math.floor(ms / 1000)} ${offset}`;
}

/**
 * Parse options against a spec: `{ 'm|message': 'list', 'a|all': 'bool', 'b': 'value',
 * 'u|untracked-files': 'optional', 'v|verbose': 'count' }`. Short flags combine (`-am msg`); `--no-x`
 * negates a bool; `--` ends options. Returns { opts, args, rest } where `rest`
 * holds what followed `--` (undefined without one).
 */
export function parseArgs(git, argv, spec, { stopAtFirstArg = false } = {}) {
  const byName = new Map();
  for (const [names, type] of Object.entries(spec)) {
    const list = names.split('|');
    const key = list.reduce((a, b) => (b.length > a.length ? b : a));
    for (const name of list) byName.set(name, { key, type });
  }
  const opts = {};
  const args = [];
  let rest;
  const set = (key, type, value) => {
    if (type === 'list') (opts[key] ??= []).push(value);
    else if (type === 'count') opts[key] = (opts[key] || 0) + 1;
    else opts[key] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      let entry = byName.get(name);
      if (!entry && name.startsWith('no-') && byName.get(name.slice(3))) {
        entry = byName.get(name.slice(3));
        opts[entry.key] = false;
        continue;
      }
      if (!entry) {
        // Unambiguous long-option prefixes, as git's parse-options allows.
        const matches = [...byName.keys()].filter((n) => n.length > 1 && n.startsWith(name));
        if (matches.length === 1) entry = byName.get(matches[0]);
      }
      if (!entry) git.usage(`error: unknown option \`${name}'`);
      if (entry.type === 'bool' || entry.type === 'count') set(entry.key, entry.type, true);
      else if (entry.type === 'optional') set(entry.key, 'optional', eq < 0 ? true : a.slice(eq + 1));
      else if (eq >= 0) set(entry.key, entry.type, a.slice(eq + 1));
      else if (i + 1 < argv.length) set(entry.key, entry.type, argv[++i]);
      else git.usage(`error: option \`${name}' requires a value`);
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && a !== '-') {
      for (let k = 1; k < a.length; k++) {
        const entry = byName.get(a[k]);
        if (!entry) git.usage(`error: unknown switch \`${a[k]}'`);
        if (entry.type === 'bool' || entry.type === 'count') {
          set(entry.key, entry.type, true);
        } else if (entry.type === 'optional') {
          set(entry.key, 'optional', k + 1 < a.length ? a.slice(k + 1) : true);
          break;
        } else {
          if (k + 1 < a.length) set(entry.key, entry.type, a.slice(k + 1));
          else if (i + 1 < argv.length) set(entry.key, entry.type, argv[++i]);
          else git.usage(`error: switch \`${a[k]}' requires a value`);
          break;
        }
      }
      continue;
    }
    args.push(a);
    if (stopAtFirstArg) {
      args.push(...argv.slice(i + 1));
      break;
    }
  }
  return { opts, args, rest };
}

/** parseArgs for commands whose operands mean the same on either side of `--`. */
export function parseOperands(git, argv, spec, options) {
  const parsed = parseArgs(git, argv, spec, options);
  parsed.args.push(...(parsed.rest ?? []));
  return parsed;
}

export function isZero(oid) { return !oid || oid === ZERO; }

/** Read a file argument (or stdin for "-"), relative to cwd. */
export function readInput(git, file) {
  if (file === '-') return git.stdin;
  try {
    return fs.readFileSync(path.resolve(git.cwd, file), 'utf8');
  } catch {
    git.fatal(`could not read '${file}': No such file or directory`);
  }
}
