// Node entry for the iOS host (also runnable on a desktop Node for testing).
// The host starts Node with this file inside the engine's filesystem view
// (native/root) and passes DSH_IOS_HOME and DSH_IOS_DATA, a directory the two
// share. We lay out DSH_HOME/HOME/TMPDIR and run the DSH engine (boot.mjs) in a
// worker thread, publishing its web URL (it carries the access token) to a 0600
// file the host polls.
//
// The worker is what makes "restart DSH" possible: iOS starts Node once per
// process and an app cannot relaunch itself, yet some plugin changes only
// apply at startup. Replacing the worker gives the engine a new isolate and a
// fresh module cache in the same process, on the same port. The engine asks
// for it (plugins/ios-host) and we also restart it if it dies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { PRELOAD } from './runtime/real-paths.mjs';

const data = process.env.DSH_IOS_DATA;
if (!data) throw new Error('DSH_IOS_DATA is not set');
// Set by the iOS host. Without it (a desktop run) everything stays below `data`.
const home = process.env.DSH_IOS_HOME;
const dirs = home
  ? { DSH_HOME: path.join(home, '.dsh'), HOME: home, TMPDIR: '/tmp', workspace: path.join(home, 'workspace') }
  : { DSH_HOME: path.join(data, 'dsh'), HOME: path.join(data, 'home'), TMPDIR: path.join(data, 'tmp'), workspace: path.join(data, 'workspace') };
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

// 全局铁律：随包分发的 AGENTS.md 装到 $DSH_HOME/AGENTS.md，每轮注入。
// dsh-agent-instructions 只读这一处，不读包内路径。
//
// 关键：不能每次启动都覆盖写。场景身份（scene.mjs 写的 SCENE 段）和用户
// 自己加的内容都在这个文件里，覆盖会把它们冲掉——表现为「配好的场景重启后没了」。
// 做法：包内铁律放在 SCENE 段之外的前半部分，启动时只重写那一段，
// 保留 SCENE 段和用户追加的内容。
const rules = path.join(path.dirname(fileURLToPath(import.meta.url)), 'AGENTS.md');
const rulesTarget = path.join(dirs.DSH_HOME, 'AGENTS.md');
try {
  if (fs.existsSync(rules)) {
    const bundled = fs.readFileSync(rules, 'utf8');
    if (!fs.existsSync(rulesTarget)) {
      fs.writeFileSync(rulesTarget, bundled, 'utf8');
    } else {
      const existing = fs.readFileSync(rulesTarget, 'utf8');
      // 场景段和它之后的内容全部保留（那是运行时生成的 + 用户加的）
      const mark = existing.indexOf('<!-- SCENE:BEGIN -->');
      const tail = mark >= 0 ? existing.slice(mark) : '';
      // 用户可能还写了别的东西：以包内铁律的结尾为准，找最后一行非空内容之后
      const next = tail ? `${bundled.trimEnd()}\n\n${tail}` : existing;
      // 只有在内容真的变了时才写盘，避免每次都改 mtime
      if (next !== existing) fs.writeFileSync(rulesTarget, next, 'utf8');
    }
  }
} catch (error) {
  console.error('[dsh-ios] could not install AGENTS.md', error);
}

// The engine's environment, not this thread's: that one is the process's, and
// the system frameworks in the process read HOME and TMPDIR, which stay real.
const env = {
  ...process.env,
  DSH_HOME: dirs.DSH_HOME,
  HOME: dirs.HOME,
  TMPDIR: dirs.TMPDIR,
  // The first-use workspace goes under this directory (see ios.patch.yml).
  DSH_IOS_DOCUMENTS: process.env.DSH_IOS_DOCUMENTS ?? path.join(data, 'documents'),
  // Skills that ship with the app, ios-environment among them (dsh-skill-filesystem's bundled root).
  DSH_BUNDLED_SKILL_DIR: path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills'),
  // 技能里的自查脚本（selfcheck / handoff / selfaudit / verify）住在只读的 app bundle 里，
  // 而 Agent 的工作目录是可写的 workspace —— 技能文档里写相对路径必然找不到。
  // 把这个绝对前缀给出去，文档里就能写 $DSH_TOOLS/xxx.mjs。
  DSH_TOOLS: path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills'),
  SHELL: process.env.SHELL ?? '/bin/bash',
  // Commands resolve inside the in-process shell, whose binaries live in /bin;
  // the OS PATH (simulator runtime dirs, /usr/bin on device) means nothing there.
  PATH: '/bin:/usr/bin',
  // No terminal to answer prompts: pnpm would otherwise stop and ask before
  // purging a node_modules it wants to rebuild.
  pnpm_config_confirm_modules_purge: process.env.pnpm_config_confirm_modules_purge ?? 'false',
};
// iOS sets this to the real container, and nothing in the engine needs it.
delete env.CFFIXED_USER_HOME;
// Workers cannot chdir; the engine inherits the process working directory.
process.chdir(dirs.workspace);

const urlFile = path.join(data, 'web-url');
const log = fs.createWriteStream(path.join(data, 'engine.log'), { flags: 'a', mode: 0o600 });
const redact = (text) => text.replace(/token=[A-Za-z0-9_-]+/g, 'token=…');
let published = false;
// Worker output reaches the process through these streams, so the tee sees both.
for (const name of ['stdout', 'stderr']) {
  const stream = process[name];
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    log.write(redact(text));
    const match = !published && /dsh web: (http:\/\/\S+)/.exec(text);
    if (match) {
      published = true;
      fs.writeFileSync(`${urlFile}.tmp`, match[1], { mode: 0o600 });
      fs.renameSync(`${urlFile}.tmp`, urlFile);
    }
    return write(redact(text), ...rest);
  };
}
const jitless = String(process.config.variables.node_v8_options ?? '').includes('--jitless') || process.execArgv.includes('--jitless');
console.log(`[dsh-ios] node ${process.version} ${process.platform}/${process.arch} jitless=${jitless} data=${data}`);

let engine;
let restarting = false;
let crashes = 0;

function start() {
  fs.rmSync(urlFile, { force: true });
  published = false;
  const startedAt = Date.now();
  engine = new Worker(new URL('./boot.mjs', import.meta.url), {
    env,
    // Engine boot reads Node's module loader internals (see shims/).
    execArgv: [...PRELOAD, '--expose-internals'],
    trackUnmanagedFds: false,
  });
  engine.on('message', (message) => {
    if (message?.type === 'dsh-ios/restart') void restart(message.reason);
    // 自动守卫的提醒：写进 engine.log，用户能在「关于 → 引擎日志」里看到。
    // 不弹 toast 是有意的——这些提醒是"该做什么了"，不是错误，
    // 频繁弹窗会让人关掉通知，反而什么都看不到。
    if (message?.type === 'dsh-ios/notice') {
      console.warn(`[auto-guard] ${message.level ?? 'info'}: ${message.message ?? ''}`);
    }
  });
  engine.on('error', (error) => console.error('[dsh-ios] engine error', error));
  engine.on('exit', (code) => {
    if (restarting) return;
    // Unexpected exit: back off while it keeps failing early, then try again.
    crashes = Date.now() - startedAt > 60_000 ? 1 : crashes + 1;
    const delay = Math.min(30_000, 1000 * 2 ** (crashes - 1));
    console.error(`[dsh-ios] engine exited (${code}); restarting in ${delay} ms`);
    setTimeout(start, delay);
  });
}

async function restart(reason) {
  if (restarting) return;
  restarting = true;
  console.log(`[dsh-ios] restarting engine${reason ? ` (${reason})` : ''}`);
  await engine.terminate();
  restarting = false;
  start();
}

start();
