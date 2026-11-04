// The in-process "execution world" on iOS: just-bash (a bash interpreter in
// TypeScript) over the real filesystem, plus the JavaScript CLIs — node, pnpm —
// run as worker threads. Used by ctx.subprocess and by the child_process shim.
import path from 'node:path';
import { Bash, InMemoryFs, MountableFs, OverlayFs, ReadWriteFs, decodeBytesToUtf8, defineCommand, getCommandNames, getNetworkCommandNames } from 'just-bash';
import { NODE_CLIS, parseNodeArgv, startNodeWorker } from './node-worker.mjs';
import { gitAvailable, gitCommand } from './git/index.mjs';

export const SHELLS = new Set(['bash', 'sh', 'dash', 'zsh']);
export const BIN = '/bin';

/** A JavaScript CLI as a shell command; `script` fixed for pnpm-like CLIs, parsed for node. */
function nodeLikeCommand(name, script) {
  return defineCommand(name, async (args, ctx) => {
    // just-bash can hand commands a root-relative cwd ("private/tmp/x").
    const cwd = path.resolve('/', ctx.cwd);
    const input = decodeBytesToUtf8(ctx.stdin ?? '');
    const parsed = script ? { script: script(), args } : parseNodeArgv(args, cwd);
    if (parsed.version) return { stdout: `${process.version}\n`, stderr: '', exitCode: 0 };
    // `node` with neither a script nor -e runs its stdin.
    if (parsed.script === undefined && parsed.code === undefined) parsed.code = input;
    const child = startNodeWorker({ ...parsed, cwd, env: ctx.exportedEnv ?? Object.fromEntries(ctx.env), stdin: true });
    child.stdin.end(parsed.code === input ? '' : input);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const stop = () => child.worker.terminate();
    ctx.signal?.addEventListener('abort', stop, { once: true });
    const exitCode = await child.exited;
    ctx.signal?.removeEventListener('abort', stop);
    return { stdout, stderr, exitCode };
  });
}

/**
 * ripgrep as DSH's search tools invoke it (dsh-tool-fs-search, through
 * shims/ripgrep.mjs): just-bash's rg plus what it lacks — `--no-config`
 * (it reads no config anyway), `--` before the search paths, `--sort=modified`
 * for `--files` (oldest first, like ripgrep), root-level matches for globs
 * that start with a double-star directory, and `--max-columns` (Claude Code's
 * Grep passes it). Its default is smart case; ripgrep's is case-sensitive.
 */
function rgCommand() {
  return defineCommand('rg', async (args, ctx) => {
    const end = args.indexOf('--');
    let options = (end >= 0 ? args.slice(0, end) : args).filter((a) => a !== '--no-config');
    // A path after `--` may start with '-'; './' keeps it a path without the marker.
    const paths = end >= 0 ? args.slice(end + 1).map((p) => (p.startsWith('-') ? `./${p}` : p)) : [];
    let maxColumns = 0;
    options = options.filter((a, i, all) => {
      const inline = /^--max-columns=(\d+)$/.exec(a);
      if (inline) { maxColumns = Number(inline[1]); return false; }
      if (a === '--max-columns' || a === '-M') { maxColumns = Number(all[i + 1]) || 0; all[i + 1] = undefined; return false; }
      return a !== undefined;
    });
    if (!options.some((a) => /^(-[a-zA-Z]*[isS][a-zA-Z]*|--ignore-case|--smart-case|--case-sensitive)$/.test(a))) options.unshift('--case-sensitive');
    const sortModified = options.includes('--sort=modified');
    // In ripgrep `**/x` also matches x at the search root; just-bash needs a
    // directory level, so each such glob also gets its root-level form.
    const expanded = options.filter((a) => a !== '--sort=modified').flatMap((a) => {
      const glob = /^--glob=(!?)\*\*\/(.+)$/.exec(a);
      return glob ? [a, `--glob=${glob[1]}${glob[2]}`] : [a];
    });
    const result = await ctx.origCommand([...expanded, ...paths]);
    const linesOut = !options.some((a) => /^(--json|--files|--files-with-matches|--files-without-match|--count|--count-matches|-[a-zA-Z]*[lLc][a-zA-Z]*)$/.test(a));
    if (maxColumns > 0 && result.exitCode === 0 && linesOut) {
      // ripgrep keeps the path:line: prefix and replaces the over-long text.
      const lines = result.stdout.split('\n').map((line) => {
        const prefix = /^(.*?[:-]\d+[:-]|[^:]*:)?/.exec(line)[0];
        return line.length - prefix.length > maxColumns ? `${prefix}[Omitted long line]` : line;
      });
      return { ...result, stdout: lines.join('\n') };
    }
    if (!sortModified || !options.includes('--files') || result.exitCode !== 0) return result;
    const cwd = path.resolve('/', ctx.cwd);
    const files = result.stdout.split('\n').filter(Boolean);
    const mtimes = new Map();
    for (const file of files) {
      try { mtimes.set(file, (await ctx.fs.stat(path.resolve(cwd, file))).mtime?.getTime?.() ?? 0); } catch { mtimes.set(file, 0); }
    }
    files.sort((a, b) => mtimes.get(a) - mtimes.get(b));
    return { ...result, stdout: files.map((f) => `${f}\n`).join('') };
  });
}

/**
 * `trap`: accepted and ignored. Nothing in the in-process world delivers
 * signals, and EXIT traps do not run — scripts that rely on them for cleanup
 * leave it undone.
 */
const trapCommand = () => defineCommand('trap', async () => ({ stdout: '', stderr: '', exitCode: 0 }));

const custom = [
  rgCommand(),
  trapCommand(),
  nodeLikeCommand('node'),
  ...Object.entries(NODE_CLIS).map(([name, script]) => nodeLikeCommand(name, script)),
];

/** Every command name this world can run (git when the libgit2 addon is present). */
export const COMMANDS = new Set([...getCommandNames(), ...getNetworkCommandNames(), ...custom.map((c) => c.name), ...(gitAvailable() ? ['git'] : [])]);

// just-bash's real-directory filesystems rooted at "/" return realpath()
// without the leading slash ("Users/x"), which then leaks into $PWD and pwd.
const absoluteRealpath = (Base) => class extends Base {
  async realpath(target) { return path.posix.resolve('/', await super.realpath(target)); }
};
const RootReadWriteFs = absoluteRealpath(ReadWriteFs);
const RootOverlayFs = absoluteRealpath(OverlayFs);

/**
 * /dev for the interpreter: `null` discards writes and reads empty. The real
 * /dev holds device files, which just-bash refuses to write (EACCES), so
 * `> /dev/null` — ubiquitous in agent commands — would otherwise fail.
 */
class DevFs extends InMemoryFs {
  constructor() { super({ '/null': '' }); }
  async writeFile(target, content, options) { if (target !== '/null') await super.writeFile(target, content, options); }
  async appendFile(target, content, options) { if (target !== '/null') await super.appendFile(target, content, options); }
}

const shells = new Map();

/**
 * One interpreter per confinement: `writable` undefined is the whole
 * filesystem; otherwise everything is read-only except the listed roots (see
 * sandbox-ios). /bin and /usr/bin hold just-bash's command stubs, which make
 * its commands resolvable through PATH.
 */
export function shell(writable) {
  // Mounts cannot nest; a root inside another granted root is already covered.
  writable = writable?.filter((root) => !writable.some((other) => other !== root && root.startsWith(`${other}/`))).sort();
  const key = writable === undefined ? '*' : JSON.stringify(writable);
  let bash = shells.get(key);
  if (bash) return bash;
  bash = new Bash({
    fs: new MountableFs({
      base: writable === undefined ? new RootReadWriteFs({ root: '/', allowSymlinks: true }) : new RootOverlayFs({ root: '/', mountPoint: '/', readOnly: true, allowSymlinks: true }),
      mounts: [
        { mountPoint: '/bin', filesystem: new InMemoryFs() },
        { mountPoint: '/usr/bin', filesystem: new InMemoryFs() },
        { mountPoint: '/dev', filesystem: new DevFs() },
        ...(writable ?? []).map((root) => ({ mountPoint: root, filesystem: new ReadWriteFs({ root, allowSymlinks: true }) })),
      ],
    }),
    // git writes through libgit2, not this filesystem, so it gets the confinement itself.
    customCommands: gitAvailable() ? [...custom, gitCommand(defineCommand, decodeBytesToUtf8, writable)] : custom,
    network: { dangerouslyAllowFullInternetAccess: true },
    executionLimitProfile: 'normal',
    // While a script runs this replaces global eval with a proxy, so any direct
    // eval in the engine, which shares this thread, loses its scope. cordis
    // evaluates plugin `disabled` expressions that way, and the engine failed
    // to start with `ctx is not defined` when a command overlapped it. It
    // guards nothing here: the fence is the filesystem, node runs outside it.
    defenseInDepth: false,
  });
  shells.set(key, bash);
  return bash;
}

/**
 * Turn an argv into one shell invocation: `bash -c script`, `bash file`,
 * `bash` reading stdin, or a single command with its arguments.
 */
export function planArgv(argv, readFile) {
  const [file, ...args] = argv;
  const name = path.basename(file);
  if (SHELLS.has(name)) {
    // Like bash, options come first and may follow -c (`bash -c -l cmd`, as
    // Claude Code runs commands); the first operand is the command string
    // under -c, else a script file.
    let command = false;
    let i = 0;
    for (; i < args.length && /^[-+]./.test(args[i]); i++) {
      if (args[i] === '--') { i++; break; }
      if (/^-[a-z]*c[a-z]*$/i.test(args[i])) command = true;
      else if (args[i] === '-o' || args[i] === '+o' || args[i] === '-O' || args[i] === '+O') i++;
    }
    if (command) return { script: args[i] ?? '' };
    if (args[i] !== undefined) return { script: readFile(args[i]) };
    return { scriptFromStdin: true };
  }
  return { script: name, args };
}

/**
 * Environment values the interpreter accepts (strings only), with /bin first
 * on PATH: the interpreter's own commands (node, pnpm, rg…) live there, and a
 * caller's PATH may name host directories holding same-named scripts it would
 * otherwise try to interpret.
 */
export function stringEnv(env) {
  const result = Object.fromEntries(Object.entries(env ?? {}).filter(([, value]) => typeof value === 'string'));
  // The working directory is the caller's `cwd`; a shell sets these from it.
  delete result.PWD;
  delete result.OLDPWD;
  result.PATH = [BIN, ...(result.PATH ?? '').split(':').filter((entry) => entry && entry !== BIN)].join(':');
  return result;
}
