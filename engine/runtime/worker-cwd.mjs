// The working directory of an emulated Node child (see worker-main.mjs).
// Workers share the process's real working directory and cannot chdir, so
// each worker keeps its own: process.cwd()/chdir() report and change it, which
// is what path.resolve() and most tools consult. fs, though, hands a relative
// path to libuv, which resolves it against the process's real directory — so
// every fs entry point that takes paths gets relative ones prefixed with the
// emulated cwd first. Prefixing (not path.resolve) keeps what the kernel would
// do from a real cwd: `..` is the physical parent and a trailing slash stays.
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const ONE_PATH = [
  'access', 'appendFile', 'chmod', 'chown', 'createReadStream', 'createWriteStream', 'exists',
  'lchmod', 'lchown', 'lstat', 'lutimes', 'mkdir', 'mkdtemp', 'mkdtempDisposable', 'open',
  'openAsBlob', 'opendir', 'readdir', 'readFile', 'readlink', 'realpath', 'rm', 'rmdir', 'stat',
  'statfs', 'truncate', 'unlink', 'unwatchFile', 'utimes', 'watch', 'watchFile', 'writeFile',
];
/** Which arguments are paths, by name; the Sync and promises variants follow suit. */
const PATH_ARGS = {
  ...Object.fromEntries(ONE_PATH.map((name) => [name, [0]])),
  copyFile: [0, 1], cp: [0, 1], link: [0, 1], rename: [0, 1],
  // A symlink's target is stored as written, relative to the link itself.
  symlink: [1],
};

/** A path as libuv would resolve it from the emulated cwd; URLs, fds and absolute paths pass through. */
function absolute(target) {
  if (typeof target === 'string') {
    if (target === '' || path.isAbsolute(target)) return target;
    return `${process.cwd().replace(/\/$/, '')}/${target}`;
  }
  if (Buffer.isBuffer(target) && target.length > 0 && target[0] !== 0x2f) {
    return Buffer.concat([Buffer.from(`${process.cwd().replace(/\/$/, '')}/`), target]);
  }
  return target;
}

/** `fn` with the arguments at `positions` made absolute; its own properties (realpath.native, promisify.custom) carried over. */
function withAbsolutePaths(fn, positions) {
  const wrapped = function (...args) {
    for (const i of positions) if (i < args.length) args[i] = absolute(args[i]);
    return fn.apply(this, args);
  };
  Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(fn));
  if (typeof fn.native === 'function') wrapped.native = withAbsolutePaths(fn.native, positions);
  return wrapped;
}

/** glob's patterns are relative to `options.cwd`, which defaults to the real directory: default it to ours. */
function withCwdOption(fn) {
  const wrapped = function (pattern, options, ...rest) {
    if (typeof options === 'function') { rest.unshift(options); options = undefined; }
    const cwd = options?.cwd instanceof URL ? options.cwd : absolute(options?.cwd ?? process.cwd());
    return fn.call(this, pattern, { ...options, cwd }, ...rest);
  };
  Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(fn));
  return wrapped;
}

let installed = false;
/** Give this worker its own working directory, starting at `initial`. */
export function emulateCwd(initial) {
  if (installed) return;
  installed = true;
  let cwd = initial;
  Object.defineProperty(process, 'cwd', { value: () => cwd, configurable: true, writable: true });
  process.chdir = (directory) => { cwd = path.resolve(cwd, String(directory)); };
  // What a shell sets for the commands it starts; some tools read it instead of cwd().
  process.env.PWD = cwd;

  for (const [name, positions] of Object.entries(PATH_ARGS)) {
    for (const [api, key] of [[fs, name], [fs, `${name}Sync`], [fs.promises, name]]) {
      if (typeof api[key] === 'function') api[key] = withAbsolutePaths(api[key], positions);
    }
  }
  for (const [api, key] of [[fs, 'glob'], [fs, 'globSync'], [fs.promises, 'glob']]) {
    if (typeof api[key] === 'function') api[key] = withCwdOption(api[key]);
  }
  const loadEnvFile = process.loadEnvFile;
  if (loadEnvFile) process.loadEnvFile = (file = '.env') => loadEnvFile.call(process, absolute(file));
  // ESM named imports (`import { readFileSync } from 'node:fs'`) see the wrappers.
  syncBuiltinESMExports();
}
