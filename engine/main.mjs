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
import { mergeAgentsMd } from './runtime/agents-md.mjs';
import { createNoticeAdmission } from './runtime/notice-admission.mjs';
import { reportInterrupted } from './runtime/flight-recorder.mjs';

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
//
// 但**也不能不更新**。原来的逻辑是「找 SCENE 标记，有就把标记后的内容接在新铁律
// 后面；没有就用原文件不动」。而包内 AGENTS.md 本身没有 SCENE 标记，所以
// 设备上那份（第一次安装时写入的旧版本）永远不会被更新——
// 改了身份描述、加了记忆工具说明，真机上一点变化都没有，而且完全静默。
//
// 现在的做法：包内铁律以一行 `<!-- BUNDLED:END -->` 结尾，
// 更新时按标记切分，只替换标记之前的那一段，其余原样保留。
// 老设备没有这个标记时：有 SCENE 就从 SCENE 切；两者都没有，先备份再覆盖
// （备份成 AGENTS.md.bak-<时间戳>，不静默丢内容）。
const rules = path.join(path.dirname(fileURLToPath(import.meta.url)), 'AGENTS.md');
const rulesTarget = path.join(dirs.DSH_HOME, 'AGENTS.md');
try {
  if (fs.existsSync(rules)) {
    const bundledRaw = fs.readFileSync(rules, 'utf8');
    const existing = fs.existsSync(rulesTarget) ? fs.readFileSync(rulesTarget, 'utf8') : null;
    const { next, changed, overwrite } = mergeAgentsMd(bundledRaw, existing);
    // 合并逻辑抽在 runtime/agents-md.mjs 里：这里一 import 就有副作用，没法测，
    // 而那段逻辑决定「身份更新能不能传到设备」，必须有测试。
    if (overwrite) {
      // 分不清哪部分是旧铁律、哪部分是用户手写：先留一份再覆盖。
      // 备份失败也继续——否则身份文件永远更新不了。
      try { fs.writeFileSync(`${rulesTarget}.bak-${Date.now()}`, existing, 'utf8'); } catch { /* 尽力而为 */ }
    }
    // 内容真的变了才写，避免每次都改 mtime。
    if (changed) fs.writeFileSync(rulesTarget, next, 'utf8');
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
  // 默认工作区。**必须设**，否则后台整理（Dream）会把经验写进一个没人读的库。
  //
  // memory-store 的 workspaceFromEnv() 回落链是
  //   DSH_IOS_WORKSPACE → DSH_WORKSPACE → DSH_IOS_DATA → cwd
  // 而会话是按 `session.header.cwd`（用户实际的工作区）定位记忆库的。
  // 两个都没设时，Dream 落到 `$DSH_IOS_DATA/.dsh-meow`，会话读
  // `<工作区>/.dsh-meow` —— 整理「成功」了，但一条都用不上，且不报错。
  //
  // 与 ios.patch.yml 里 workspace-controller 的首次工作区保持一致。
  // 已知限制：用户开了多个工作区时，Dream 只写默认这一个。
  // 那比「写进谁都读不到的地方」好，也比乱猜「当前会话」稳
  //（Dream 是定时的，可能没有活跃会话）。
  DSH_IOS_WORKSPACE: process.env.DSH_IOS_WORKSPACE
    ?? path.join(process.env.DSH_IOS_DOCUMENTS ?? path.join(data, 'documents'), 'deepseek-harness'),
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
const admitNotice = createNoticeAdmission();

function start() {
  fs.rmSync(urlFile, { force: true });
  published = false;
  // 上一代引擎留下的「正在跑」记录 = 被崩溃/重启打断的任务。
  // 必须在新引擎起来之前读走并清空：新引擎一启动就会覆盖写这个文件，
  // 那时残留就没了，用户也永远不知道刚才那个任务断了。
  const interrupted = reportInterrupted(data);
  if (interrupted.length > 0) {
    console.warn(`[dsh-ios] ${interrupted.length} task(s) were interrupted by the restart`);
  }
  const startedAt = Date.now();
  engine = new Worker(new URL('./boot.mjs', import.meta.url), {
    env,
    // Engine boot reads Node's module loader internals (see shims/).
    execArgv: [...PRELOAD, '--expose-internals'],
    trackUnmanagedFds: false,
  });
  engine.on('message', (message) => {
    if (message?.type === 'dsh-ios/restart') void restart(message.reason);
    // 自动守卫提醒先经过准入器：actionable allowlist + 每会话冷却，
    // 普通日志只留 engine.log，不进入用户 toast 通道。
    if (message?.type === 'dsh-ios/notice') {
      console.warn(`[auto-guard] ${message.level ?? 'info'}: ${message.message ?? ''}`);
      if (admitNotice(message)) {
        // ⚠ 字段契约：Swift 侧读的是**顶层** kind / message / sessions / turns。
        // 早先这里把 kind 写死成 'notice' 并把业务字段塞进 detail，结果：
        //   · 中断横幅永远不出现（判断 obj["kind"] == "interrupted" 永不成立）
        //   · 点「去查看」跳不到会话（sessions 在 detail 里，顶层读不到）
        // 现在把 detail 展开到顶层，kind 用实际业务类型。
        const detail = message.detail ?? {};
        const record = {
          // eventId 透传：App 靠它去重（outbox 是至少一次投递，重投是预期）。
          // 没有它，App 只能按行号判断，同一事件重投就会弹两遍。
          eventId: message.eventId ?? detail.eventId ?? null,
          kind: detail.kind ?? 'notice',
          message: message.message,
          sessions: detail.sessions ?? null,
          steps: detail.steps ?? null,
          turns: detail.turns ?? null,
          taskId: detail.taskId ?? null,
          detail,
          time: Date.now(),
        };
        try {
          fs.appendFileSync(path.join(data, 'notices.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
        } catch (error) {
          console.error('[dsh-ios] notice write failed', error?.message ?? error);
        }
      }
    }
    // 引擎里做的网页/文件想让用户在 App 里直接看：写一条 kind=preview 的通知。
    // 为什么走这个通道而不是新开一条 RPC：notices.jsonl 已经是引擎到 App 的现成
    // 单向通道（App 每 3 秒读一次），复用只多一个字段，不用改两边的协议。
    if (message?.type === 'dsh-ios/preview') {
      const previewPath = message.path;
      if (typeof previewPath === 'string' && previewPath.length > 0) {
        const record = { kind: 'preview', title: message.title ?? '', path: previewPath, time: Date.now() };
        try {
          fs.appendFileSync(
            path.join(data, 'notices.jsonl'),
            JSON.stringify(record) + '\n',
            { mode: 0o600 },
          );
        } catch (error) {
          console.error('[dsh-ios] preview notice failed', error?.message ?? error);
        }
      }
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
