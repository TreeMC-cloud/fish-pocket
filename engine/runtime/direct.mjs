// Commands that are, in the end, "start this Node program" — `node x.js`,
// pnpm/npx, `#!…node` scripts and the shell shims pnpm writes into
// node_modules/.bin — run as a Node worker directly instead of through
// just-bash. The interpreter returns a command's output only when it exits,
// so a dev server (`pnpm dev` → `sh -c "next dev"` → .bin/next → node) would
// never show a line; a worker streams. Anything with real shell syntax
// (pipes, lists, expansions, redirections) still goes to the interpreter.
import fs from 'node:fs';
import path from 'node:path';
import { NODE_CLIS, parseNodeArgv } from './node-worker.mjs';

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh']);

// pnpm prefixes every run script with `trap '…' INT;` to forward Ctrl-C.
// There are no signals in-process, so leading trap statements change nothing.
const LEADING_TRAP = /^\s*trap\s+(?:'[^']*'|"[^"$`\\]*"|\S+)(?:\s+[A-Z0-9]+)+\s*;/;

/** Split a simple command line into words; undefined when it uses shell syntax beyond plain quoting. */
export function simpleWords(script) {
  const words = [];
  let word;
  let i = 0;
  let text = script;
  while (LEADING_TRAP.test(text)) text = text.replace(LEADING_TRAP, '');
  text = text.trim().replace(/^exec\s+/, '');
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (word !== undefined) { words.push(word); word = undefined; }
      i++;
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word = (word ?? '') + text.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) return undefined;
      const inner = text.slice(i + 1, end);
      if (/[$`\\]/.test(inner)) return undefined;
      word = (word ?? '') + inner;
      i = end + 1;
    } else if (/[|&;<>()$`\\*?[\]{}~#!\n]/.test(ch)) {
      return undefined;
    } else {
      word = (word ?? '') + ch;
      i++;
    }
  }
  if (word !== undefined) words.push(word);
  return words.length > 0 ? words : undefined;
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function head(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      // pnpm 11's shims run past 5 KB before their exec lines.
      const buffer = Buffer.alloc(16384);
      return buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

/** The JavaScript a file runs when executed: itself (`#!…node`) or a pnpm/npm .bin shim's target. */
function nodeTarget(file) {
  const text = head(file);
  const first = text.split('\n')[0];
  if (first.startsWith('#!') && /\bnode\b/.test(first)) return file;
  if (!first.startsWith('#!') || !/\b(sh|bash)\b/.test(first)) return undefined;
  // pnpm/cmd-shim: exec node  "$basedir/../next/dist/bin/next" "$@"
  // (pnpm 11: "$basedir_abs/…", the shim's directory with symlinks resolved)
  const shim = /exec\s+node\s+"\$basedir(?:_abs)?\/([^"]+)"\s+"\$@"/.exec(text);
  if (!shim) return undefined;
  let directory = path.dirname(file);
  try { directory = fs.realpathSync(directory); } catch {}
  return path.resolve(directory, shim[1]);
}

function lookup(program, cwd, env) {
  if (program.includes('/')) return path.resolve(cwd, program);
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = path.resolve(cwd, dir, program);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Plan argv (or a `sh -c` script) as one Node program, if it is one.
 * @returns {{ script?: string, code?: string, print?: boolean, version?: boolean, args: string[], env: object } | undefined}
 */
export function planDirect(argv, { cwd, env }) {
  let words = argv;
  let assignments = {};
  const name = path.basename(argv[0] ?? '');
  if (SHELLS.has(name)) {
    const c = argv.indexOf('-c');
    if (c < 0 || argv[c + 1] === undefined) return undefined;
    words = simpleWords(argv[c + 1]);
    if (words === undefined) return undefined;
  }
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    const [key, ...value] = words[0].split('=');
    assignments[key] = value.join('=');
    words = words.slice(1);
  }
  if (words.length === 0) return undefined;
  const [program, ...args] = words;
  const runEnv = { ...env, ...assignments };
  const base = path.basename(program);
  if (base === 'node') return { ...parseNodeArgv(args, cwd), env: runEnv };
  if (base === 'npx') return { script: NODE_CLIS.pnpx(), args: args.filter((a) => a !== '-y' && a !== '--yes'), env: runEnv };
  if (NODE_CLIS[base] && !program.includes('/')) return { script: NODE_CLIS[base](), args, env: runEnv };
  const file = lookup(program, cwd, runEnv);
  const target = file && nodeTarget(file);
  return target ? { script: target, args, env: runEnv } : undefined;
}
