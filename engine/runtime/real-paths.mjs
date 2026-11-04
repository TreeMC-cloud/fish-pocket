// The Node entry points native/root cannot reach. fs.rmSync, fs.cpSync, recursive
// fs.rmdirSync and the remove of fs.mkdtempDisposableSync run inside libc++
// (std::filesystem), whose libc calls are not ours: handed an engine path they
// look in the real `/`, and rmSync then reports success having removed nothing.
// So these get real paths; all other fs calls reach libc from Node itself.
// scripts/check-root-imports.sh notices a new std::filesystem entry point in Node.
//
// Every thread needs this: main.mjs imports it, and each worker preloads it
// (PRELOAD, added by worker-defaults.mjs and node-worker.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

export const PRELOAD = [`--import=${import.meta.url}`];

const isPath = (value) => typeof value === 'string' || Buffer.isBuffer(value) || value instanceof URL;
const text = (value) => (value instanceof URL ? fileURLToPath(value) : String(value));

/** What native/root says about paths, through the linked binding; nothing on a desktop. */
function linkedView() {
  try { return process._linkedBinding('dsh_root'); } catch { return undefined; }
}

let installed = false;
/** @param {{ real(path: string): string, virtual(path: string): string }} view */
export function installRealPaths(view) {
  if (installed) return;
  installed = true;
  const real = (value) => (isPath(value) ? view.real(path.resolve(text(value))) : value);
  /** Run `call`; an error names the paths the caller gave, not the real ones. */
  const named = (call, ...paths) => {
    try {
      return call();
    } catch (error) {
      for (const given of paths) {
        if (!isPath(given)) continue;
        const shown = text(given);
        const actual = real(given);
        if (typeof error.message === 'string') error.message = error.message.replaceAll(actual, shown);
        if (error.path === actual) error.path = shown;
        if (error.dest === actual) error.dest = shown;
      }
      throw error;
    }
  };
  const { rmSync, rmdirSync, cpSync, mkdtempDisposableSync } = fs;
  fs.rmSync = function (target, options) {
    return named(() => rmSync.call(this, real(target), options), target);
  };
  fs.rmdirSync = function (target, options) {
    if (!options?.recursive) return rmdirSync.call(this, target, options);
    return named(() => rmdirSync.call(this, real(target), options), target);
  };
  fs.cpSync = function (source, destination, options) {
    const filter = options?.filter;
    const given = typeof filter === 'function'
      ? { ...options, filter: (from, to) => filter(view.virtual(from), view.virtual(to)) }
      : options;
    return named(() => cpSync.call(this, real(source), real(destination), given), source, destination);
  };
  if (mkdtempDisposableSync) {
    fs.mkdtempDisposableSync = function (...args) {
      const directory = mkdtempDisposableSync.apply(this, args);
      const remove = () => fs.rmSync(directory.path, { recursive: true, force: true });
      return { path: directory.path, remove, [Symbol.dispose]: remove };
    };
  }
  // ESM named imports (`import { rmSync } from 'node:fs'`) see the wrappers.
  syncBuiltinESMExports();
}

const view = linkedView();
if (view) installRealPaths(view);
