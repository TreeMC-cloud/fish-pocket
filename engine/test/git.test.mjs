// git on libgit2 (runtime/git + native/git): through the execution world, under
// confinement, and line for line against the host's git. Needs the host build
// of the addon (scripts/build-git-addon.sh); skipped without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import IosSubprocessRuntime from '../plugins/subprocess-ios/index.mjs';
import { CONFINE } from '../plugins/sandbox-ios/index.mjs';

import { configureHome, gitAvailable, runGit } from '../runtime/git/index.mjs';

// A private ~/.gitconfig for both gits.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-git-home-')));
fs.writeFileSync(path.join(home, '.gitconfig'), '[init]\n\tdefaultBranch = main\n');
configureHome(home);

const addon = gitAvailable();
const hostGit = spawnSync('git', ['--version']).status === 0;
const skip = addon ? false : 'libgit2 addon not built (scripts/build-git-addon.sh)';

const identity = {
  HOME: home, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_AUTHOR_DATE: '1700000000 +0800', GIT_COMMITTER_DATE: '1700000000 +0800',
};

async function runtime() {
  const ctx = new Context();
  ctx.plugin(IosSubprocessRuntime);
  await ctx.inject(['subprocess'], () => {});
  await new Promise((r) => setTimeout(r, 10));
  return ctx.get('subprocess');
}

const collect = { maxBytes: 1 << 20 };
async function spawn(sp, argv, cwd, env = {}) {
  const h = sp.spawn({ argv, cwd, graceMs: 100, stdio: { stdin: 'ignore', stdout: collect, stderr: collect }, env: { PATH: '/bin', ...identity, ...env } });
  const { exitCode } = await h.done;
  return { exitCode, stdout: h.collected.stdout.readFrom(0).text, stderr: h.collected.stderr.readFrom(0).text };
}

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-git-')));

test('git is a command of the execution world', { skip }, async () => {
  const sp = await runtime();
  assert.equal(await sp.resolveExecutable('git'), '/bin/git');
  const dir = tmp();
  assert.equal((await spawn(sp, ['git', 'init', '-q'], dir)).exitCode, 0);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  const r = await spawn(sp, ['bash', '-c', 'git add a.txt && git commit -qm first && git log --oneline | wc -l && git status --short | wc -l'], dir);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split(/\s+/), ['1', '0']);
  const outside = await spawn(sp, ['git', 'status'], os.tmpdir());
  assert.equal(outside.exitCode, 128);
  assert.match(outside.stderr, /not a git repository/);
});

test('confinement fences git writes like the filesystem', { skip }, async () => {
  const sp = await runtime();
  const dir = tmp();
  await spawn(sp, ['git', 'init', '-q'], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  const readOnly = (argv) => [CONFINE, '--', ...argv];
  const status = await spawn(sp, readOnly(['git', 'status', '--short']), dir);
  assert.equal(status.exitCode, 0);
  assert.equal(status.stdout, '?? a.txt\n');
  const add = await spawn(sp, readOnly(['git', 'add', 'a.txt']), dir);
  assert.equal(add.exitCode, 128);
  assert.match(add.stderr, /Read-only file system/);
  const allowed = await spawn(sp, [CONFINE, '--write', dir, '--', 'git', 'add', 'a.txt'], dir);
  assert.equal(allowed.exitCode, 0, allowed.stderr);
});

test('unsupported commands say so instead of misbehaving', { skip }, async () => {
  const dir = tmp();
  await runGit(['init', '-q'], { cwd: dir, env: identity });
  const r = await runGit(['rebase', 'main'], { cwd: dir, env: identity });
  assert.equal(r.exitCode, 128);
  assert.match(r.stderr, /not supported by git on iOS/);
  const ssh = await runGit(['clone', 'git@github.com:a/b.git'], { cwd: dir, env: identity });
  assert.match(ssh.stderr, /SSH remotes are not supported/);
});

/**
 * Run a scenario in two identical directories, one with the host's git and
 * one with ours, and compare stdout, stderr and exit codes step by step.
 */
async function compare(t, file) {
  const steps = JSON.parse(fs.readFileSync(new URL(`./git/${file}`, import.meta.url), 'utf8'));
  const base = tmp();
  const env = { ...identity, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };
  const dirs = { real: path.join(base, 'real'), ours: path.join(base, 'ours') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d);
  const mismatches = [];
  for (const step of steps) {
    if (step.sh) {
      for (const d of Object.values(dirs)) execFileSync('sh', ['-c', step.sh], { cwd: d, env });
      continue;
    }
    const extra = (d) => (step.env === 'snap' ? {
      GIT_INDEX_FILE: path.join(d, 'scratch/index'), GIT_OBJECT_DIRECTORY: path.join(d, 'scratch/objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(d, 'work/.git/objects'), GIT_CONFIG_COUNT: '0',
    } : {});
    const cwd = (d) => path.join(d, step.cwd ?? '');
    const argv = (d) => step.git.map((a) => a.replaceAll('<D>', d));
    const real = spawnSync('git', argv(dirs.real), { cwd: cwd(dirs.real), env: { ...env, ...extra(dirs.real) }, input: step.stdin ?? '', encoding: 'utf8' });
    const ours = await runGit(argv(dirs.ours), { cwd: cwd(dirs.ours), env: { ...env, ...extra(dirs.ours) }, stdin: step.stdin ?? '' });
    if (step.skip) continue;
    const norm = (s) => {
      let out = s.replaceAll(dirs.real, '<D>').replaceAll(dirs.ours, '<D>');
      if (step.mask) out = out.replace(new RegExp(step.mask, 'g'), '<masked>');
      return out;
    };
    const a = { stdout: norm(real.stdout), stderr: step.stderr === false ? '' : norm(real.stderr), exitCode: real.status };
    const b = { stdout: norm(ours.stdout), stderr: step.stderr === false ? '' : norm(ours.stderr), exitCode: ours.exitCode };
    try {
      assert.deepEqual(b, a);
    } catch {
      mismatches.push(`git ${step.git.join(' ')}\n--- git\n${JSON.stringify(a, null, 1)}\n--- ours\n${JSON.stringify(b, null, 1)}`);
    }
  }
  assert.deepEqual(mismatches, []);
}

const compareSkip = skip || (hostGit ? false : 'no git on this machine to compare with');
test('matches git: everyday local commands', { skip: compareSkip }, (t) => compare(t, 'basic.json'));
test('matches git: remotes, merges, stash, worktrees, snapshot plumbing', { skip: compareSkip }, (t) => compare(t, 'flow.json'));
