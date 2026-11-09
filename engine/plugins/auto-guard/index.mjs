/**
 * 自动守卫 —— 把「靠自觉」的规矩变成「引擎每轮自己跑」。
 *
 * 为什么不做成 CLI 让人/AI 去调：忘一次就等于没有。一位实践者说过
 * 「你把它变成一个命令之后，它就是一个程序了」——这个插件就是那一步。
 *
 * 挂四条钩子（对应 DSH 的 tools 管线 + 会话事件）：
 *   1. turn/start        → 自动记轮次，超线报警
 *   2. tools/pre-execute → 派活类工具调用前查负载，内存吃紧就拦
 *   3. tools/post-execute → 派活后自动记账（谁派的、干什么），失败自动记
 *   4. compaction/start  → 上下文要压缩，提醒写交接
 *
 * 提醒先写引擎日志，再由宿主准入器决定是否进入 App toast；重复提醒有冷却，
 * 所以不是每条内部告警都会打断用户。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { parentPort } from 'node:worker_threads';
import { scanInjection } from '../../runtime/injection-guard.mjs';
import { writeInFlight, describeStep } from '../../runtime/flight-recorder.mjs';
import {
  load as loadTasks,
  save as saveTasks,
  pendingOutbox,
  ack as ackTaskEvent,
} from '../../runtime/task-registry.mjs';

const DEFAULT_TURNS_MAX = 40;
const DEFAULT_REPEAT_MAX = 3;
/**
 * 派活的负载红线，与 skills/cost-guard/load-gate.mjs 同一口径（用户定的规矩）：
 * 已用 ≥90% 停止派单，≥95% 停重活。
 * 这两个数只在 load-gate.mjs 里作为「权威定义」，这里是为了同步拦截而复制；
 * 改阈值必须两边一起改，否则会出现「命令行说可以派、插件却拒绝」的分裂。
 */
const MEMORY_STOP_PCT = 90;
const MEMORY_HEAVY_PCT = 95;
/**
 * 一轮的结果判定。**白名单**，不是黑名单。
 *
 * 为什么必须白名单：原来的 `reason !== 'error' ? true : false` 会把
 * `aborted`（用户中断）、`interrupted`（进程被杀）、`max-tokens`（答到一半截断）、
 * `quota`（额度耗尽）全部记成成功。蒸馏时这些会被当成「这条做法有效」的证据，
 * 于是把一次失败固化成技能。判错的代价比不判大得多。
 *
 * 返回：true / false / null（未知，蒸馏时排除）
 */
export function outcomeOf(reason) {
  switch (reason) {
    case 'completed':
    case 'user':            // 模型正常答完，用户没打断
    case 'stop':
      return true;
    case 'error':
    case 'failed':
    case 'aborted':
    case 'interrupted':
    case 'cancelled':
    case 'max-tokens':
    case 'quota':
      return false;
    default:
      return null;          // 未知一律不猜
  }
}

/**
 * 脱敏：凭证、Authorization、URL 里的 token、常见环境变量赋值。
 *
 * 为什么在写入前做：trace 会长期留存并参与蒸馏，一旦把密钥写进去，
 * 它会跟着备份、日志、导出的技能一起扩散，删都删不干净。
 * 这是「写入前过滤」而不是「展示时打码」——后者原文还在文件里。
 */
export function redact(text) {
  return String(text ?? '')
    // sk-xxxx / ghp_xxxx / AKIA... 等常见凭证前缀
    .replace(/\b(sk|ghp|gho|ghs|ghu|glpat|xox[abp])[-_][A-Za-z0-9_-]{16,}/gi, '[REDACTED_KEY]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
    // Authorization: Bearer xxx / api_key=xxx / token=xxx
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|bearer|token|password|secret)\b\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    // URL query 里的 token/key/sig
    .replace(/([?&](?:token|key|sig|signature|access_token)=)[^&\s]+/gi, '$1[REDACTED]')
    // 环境变量赋值形式 FOO_SECRET=xxx
    .replace(/\b[A-Z_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Z_]*\s*=\s*\S+/g, '[REDACTED_ENV]');
}

/** 这些工具名说明"在派活"，派之前要查负载、派之后要记账。 */
const DISPATCH_TOOL_PATTERN = /^(subagent|wb_submit_task|wb_task_status)$/;

/**
 * 会带回外部文本的工具：网页、搜索、MCP 远程工具。
 * 本地文件读写不算——那些内容的可信度来自用户自己的磁盘，不是公网。
 */
const EXTERNAL_CONTENT_TOOLS = /^(web_fetch|web_search|fetch|browser|curl|wget|mcp__.*)$/i;

function sessionId(session) {
  return String(session?.header?.id ?? session?.id ?? 'unknown');
}

/**
 * 按需加载 Dream 相关模块。
 *
 * 为什么不在顶层 import：这些模块会连带加载 skill-eval / memory-store，
 * 而 memory-store 又去 require meow-memory（一个大包）。顶层加载会让
 * 插件启动变慢，而 Dream 十分钟才可能跑一次——不值得为它付启动成本。
 */
function requireCapabilityStatus() {
  if (!globalThis.__capStatusMod) {
    const req = createRequire(import.meta.url);
    globalThis.__capStatusMod = req('../../runtime/capability-status.mjs');
  }
  return globalThis.__capStatusMod;
}

/**
 * 按需加载任务记账模块（Task Registry 的唯一调用者）。
 *
 * Task Registry 那套状态机写了很久，但一直**没有调用方**：
 * `.tasks.json` 从没被写过，能力地图只能显示「还没开始干活」。
 * 这里把它接上真实事件——一轮对话就是一个任务。
 */
function requireTaskTracking() {
  if (!globalThis.__taskTrackMod) {
    const req = createRequire(import.meta.url);
    globalThis.__taskTrackMod = req('../../runtime/task-tracking.mjs');
  }
  return globalThis.__taskTrackMod;
}

/** Router：准入、并发、租约、失败改道。运行时唯一的调度器。 */
function requireRouter() {
  if (!globalThis.__routerMod) {
    const req = createRequire(import.meta.url);
    globalThis.__routerMod = req('../../runtime/router.mjs');
  }
  return globalThis.__routerMod;
}

/** task-runner：把排队任务真的投进 DSH 会话。 */
function requireTaskRunner() {
  if (!globalThis.__taskRunnerMod) {
    const req = createRequire(import.meta.url);
    globalThis.__taskRunnerMod = req('../../runtime/task-runner.mjs');
  }
  return globalThis.__taskRunnerMod;
}

/** schedule-bridge：把 DSH 定时任务到期项收进 Router 队列。 */
function requireScheduleBridge() {
  if (!globalThis.__scheduleBridgeMod) {
    const req = createRequire(import.meta.url);
    globalThis.__scheduleBridgeMod = req('../../runtime/schedule-bridge.mjs');
  }
  return globalThis.__scheduleBridgeMod;
}

/** task-control：人工确认失败任务的入口（App 落文件、这里扫）。 */
function requireTaskControl() {
  if (!globalThis.__taskControlMod) {
    const req = createRequire(import.meta.url);
    globalThis.__taskControlMod = req('../../runtime/task-control.mjs');
  }
  return globalThis.__taskControlMod;
}

function requireSkillRegistry() {
  if (!globalThis.__skillRegMod) {
    const req = createRequire(import.meta.url);
    globalThis.__skillRegMod = req('../../runtime/skill-registry.mjs');
  }
  return globalThis.__skillRegMod;
}

function requireSafeEdit() {
  if (!globalThis.__safeEditMod) {
    const req = createRequire(import.meta.url);
    globalThis.__safeEditMod = req('../../runtime/safe-edit.mjs');
  }
  return globalThis.__safeEditMod;
}

function requireSkillStats() {
  if (!globalThis.__skillStatsMod) {
    const req = createRequire(import.meta.url);
    globalThis.__skillStatsMod = req('../../runtime/skill-stats.mjs');
  }
  return globalThis.__skillStatsMod;
}

function requireSceneSchema() {
  if (!globalThis.__sceneSchemaMod) {
    const req = createRequire(import.meta.url);
    globalThis.__sceneSchemaMod = req('../../runtime/scene-schema.mjs');
  }
  return globalThis.__sceneSchemaMod;
}

function requirePlan() {
  if (!globalThis.__planMod) {
    const req = createRequire(import.meta.url);
    globalThis.__planMod = req('../../runtime/plan.mjs');
  }
  return globalThis.__planMod;
}

function requireProactive() {
  if (!globalThis.__proactiveMod) {
    const req = createRequire(import.meta.url);
    globalThis.__proactiveMod = req('../../runtime/proactive.mjs');
  }
  return globalThis.__proactiveMod;
}

function requireSelfTest() {
  if (!globalThis.__selfTestMod) {
    const req = createRequire(import.meta.url);
    globalThis.__selfTestMod = req('../../runtime/selftest.mjs');
  }
  return globalThis.__selfTestMod;
}

function requireDream() {
  if (!globalThis.__dreamMods) {
    const req = createRequire(import.meta.url);
    globalThis.__dreamMods = req('../../runtime/dream.mjs');
  }
  return globalThis.__dreamMods;
}

function requireMemoryStore() {
  if (!globalThis.__memoryStoreMod) {
    const req = createRequire(import.meta.url);
    globalThis.__memoryStoreMod = req('../../runtime/memory-store.mjs');
  }
  return globalThis.__memoryStoreMod;
}

/**
 * 带体积上限的追加：文件超过 maxBytes 就轮转成 .1，旧 .1 丢弃。
 *
 * 为什么必须有：trace 是长期追加的，几周后能到几十 MB。它会被蒸馏读、
 * 会被备份带走、会在手机上占空间。只保留最近一段就够——「三个月前的
 * 一次失败」对现在提炼技能的价值已经很低，而且过期经验还可能误导。
 *
 * 轮转而不是删除：留着上一代方便回查最近的历史，同时总量有硬上限。
 */
function appendJsonlBounded(file, obj, { maxBytes = 2 * 1024 * 1024 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat && stat.size >= maxBytes) {
      const prev = `${file}.1`;
      try { fs.rmSync(prev, { force: true }); } catch { /* 旧文件删不掉不影响写入 */ }
      try { fs.renameSync(file, prev); } catch { /* 改名失败就继续追加，宁可超一点 */ }
    }
  } catch { /* stat 失败按未超限处理 */ }
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', { mode: 0o600 });
}

/**
 * 从摘要里认出「这件事属于什么话题」，给 trace 打标签。
 *
 * 为什么不用工具名当标签：工具名只有 Bash / Read / Edit 那么几个，按它聚类
 * 提炼出来的是「Bash 老出问题」——正确但没用。人想知道的是「下载这套流程
 * 我踩过什么坑」。所以按关键词认话题。
 *
 * 为什么用关键词而不是分词：中文分词要词库，iOS 包体积不值这个价；而且这些
 * 话题是封闭集合（这个项目常见的几摊事），关键词表够用且完全可预测——
 * 匹配不上就是没话题，不会瞎归类。
 */
const TOPIC_RULES = [
  [/下载|ipa|blob|分片|curl|wget/i, '下载'],
  [/构建|编译|build|xcode|gym|archive/i, '构建'],
  [/图标|icon|png|图片|image/i, '图片'],
  [/记忆|memory|meow/i, '记忆'],
  [/测试|test|pytest|断言|assert/i, '测试'],
  [/记忆|偏好|prefs/i, '偏好'],
  [/推送|push|commit|git|github/i, '版本'],
  [/UI|界面|swift|view/i, '界面'],
];

function topicsOf(text) {
  const t = String(text ?? '');
  const hit = [];
  for (const [re, name] of TOPIC_RULES) {
    if (re.test(t) && !hit.includes(name)) hit.push(name);
  }
  return hit;
}

export default class AutoGuard {
  static inject = [];

  constructor(ctx, config = {}) {
    /** 被截断过、模型只看到首尾的文件 → 时间戳。编辑前要拦一次。 */
    this.truncatedFiles = new Map();
    this.ctx = ctx;
    this.turnsMax = Number(config.turnsMax ?? process.env.DSH_TURNS_MAX ?? DEFAULT_TURNS_MAX) || DEFAULT_TURNS_MAX;
    this.repeatMax = Number(config.repeatMax ?? DEFAULT_REPEAT_MAX) || DEFAULT_REPEAT_MAX;
    this.state = new WeakMap();
    /** 派单台账：进程内记账，重启清空（持久台账归 sentinel.mjs）。 */
    this.dispatched = [];
    /**
     * 正在跑的会话 → 开始时间。每次变化覆盖写 in-flight.json，
     * 这份文件跨进程存活：崩溃后残留的内容就是「被打断的任务」。
     *
     * 不从文件里读回旧值（那会把上次崩溃的记录当成本次在跑），
     * 读取与清理由 main.mjs 在启动新引擎之前完成。
     */
    this.inFlight = new Map();
    /** 上次查「未回执派单」的时间，避免每轮重复 spawn sentinel。 */
    this.lastDispatchCheck = 0;

    // 启动时校验一次技能元数据。18 个技能的 version/source/permissions
    // 写在文件里但从没被读取验证过——等于没有约束。
    // 只写日志不阻断：某个技能元数据缺字段是维护问题，不该让 App 起不来。
    this.auditSkillsOnce();


// ══════════════════════════════════════════════════════════════════
// Router 调度循环：让队列里的「无主任务」真的被执行
//
// 在此之前 Router 和 Task Registry 只有测试在调，运行时从不触发——
// 任务表永远是空的，能力地图只能显示「还没开始干活」。
//
// 边界（iOS 现实，必须写清楚）：
//   这个循环只在**引擎进程活着**时跑。App 被杀后定时器一起消失，
//   到点该做的事不会发生。所以它是「存活期间的可靠执行队列」，
//   不是「常驻调度器」——后者在 iOS 上做不到，别对外宣称。
//
// 为什么用 ctx.get('agents') 而不是 inject：
//   inject 声明的是**硬依赖**，服务不存在时整个插件不激活。
//   如果哪天 DSH 改了服务名，注入会让守卫（cron/轮次/注入检测）一起失效——
//   为了一个附加能力赔上整个安全层，不划算。
//   ctx.get 是不带 inject 要求的读取，拿不到就跳过，主功能不受影响。
// ══════════════════════════════════════════════════════════════════
ctx.effect(() => {
  let timer = null;
  let stopped = false;
  let running = false;

  const INTERVAL_MS = 15_000;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(runOnce, INTERVAL_MS);
    // iOS 上 setTimeout 不该拖住进程退出
    try { timer?.unref?.(); } catch { /* 某些宿主没有 unref */ }
  };

  // 启动后跑一次端到端自测，结果落到 selftest.json 给 App 看。
  //
  // 为什么不放进调度循环：自测要开临时目录、跑 tick、写文件，属于重活，
  // 每 15 秒跑一次纯属浪费。每个进程跑一次就够——它查的是「模块之间的
  // 接线通不通」，跟具体数据无关。
  //
  // 延迟 5 秒：不和引擎启动、preload、首次会话加载抢 CPU；
  // 但也不能太久——App 被系统回收得早的话，自检页会一直停在「还没跑完自测」。
  // iOS 上启动瞬间内存很紧，这时候跑自测容易被系统杀掉。
  try {
    const bootTimer = setTimeout(() => {
      ;(async () => {
        try {
          const mod = requireSelfTest();
          const r = await mod.writeSelfTest(this.dataDir());
          this.ctx.logger?.info?.(`[auto-guard] 自测 ${r.passed}/${r.total}` + (r.passed < r.total
            ? '；未通过：' + r.items.filter((i) => !i.ok).map((i) => i.id).join(',')
            : ''));
        } catch (error) {
          try { this.ctx.logger?.warn?.('[auto-guard] 自测失败: %s', error?.message ?? error); } catch { /* 无 logger */ }
        }
      })();
    }, 5_000);
    try { bootTimer?.unref?.(); } catch { /* 某些宿主没有 unref */ }
  } catch { /* 自测起不来不影响调度 */ }

  const runOnce = async () => {
    if (stopped || running) { schedule(); return; }
    running = true;
    try {
      const { Router } = requireRouter();
      const { makeRunTask, tick } = requireTaskRunner();
      const agents = ctx.get?.('agents');
      if (!agents) {
        // 宿主没提供 agents：这个版本不支持投递，静默跳过。
        // 不写日志刷屏——每 15 秒一条会把 engine.log 淹掉。
        return;
      }
      const router = new Router({
        dataDir: this.dataDir(),
        runTask: makeRunTask({
          ctx,
          // dsh-llm 的 createUserMessage 由宿主注入的消息构造器代替：
          // 拿不到就退化成普通对象（inject 只要求有 content/source 形状）。
          createUserMessage: (input) => input,
          logger: this.ctx.logger,
        }),
      });
      // ⚠ 这里**不**去 harvest DSH 的定时任务。
      //
      // 曾经这么做过，是错的：DSH 的 schedule 自带完整的自动投递循环
      // （runtime.requestDrive + setTimeout + timer.unref），App 活着时它会
      // 自己到点投递、自己推进 scheduledAt。Router 再收一遍 = 同一个任务
      // 被执行两次；而且 Router 绕过 DSH 投递后 scheduledAt 不推进，
      // 同一个任务会每 15 秒被重新当成"到期"（幂等键也挡不住，因为键里带
      // scheduledAt，值根本没变才是它一直"到期"的原因）。
      //
      // 结论：定时任务的投递权归 DSH。Router 只处理那些**没有别人负责**的任务
      // （失败重排、子任务回收）。判断某个来源该不该接，先看它有没有自动执行者。
      // 顺带记一笔 schedule 的观察结果（只读，不接管投递）。
      // buildStatus 是同步的，读不到 ctx.get('schedule') 这种异步服务，
      // 所以由这里落一个文件给它读——和 in-flight.json 同一个模式。
      {
        // 无论能不能读到定时任务，都要落这个文件。
        // 原来只在 `ctx.get('schedule')` 拿得到时才写，于是「文件不存在」
        // 有两种完全不同的可能：插件没跑，或者 schedule 服务不可用——
        // 而自检只能看到「不存在」，没法区分。把不可用的原因也写进去，
        // 这个文件才是一个可靠的探针。
        const now = Date.now();
        let payload;
        try {
          const svc = ctx.get?.('schedule');
          if (svc && typeof svc.catalog === 'function') {
            const entries = await svc.catalog();
            const bridge = requireScheduleBridge();
            const rows = (Array.isArray(entries) ? entries : []).map((e) => ({
              ...bridge.summarize(e),
              due: bridge.isDue(e, now),
            }));
            payload = { at: now, ok: true, total: rows.length, rows: rows.slice(0, 50) };
          } else {
            payload = { at: now, ok: false, reason: 'ctx.get("schedule") 不可用', total: 0, rows: [] };
          }
        } catch (error) {
          payload = { at: now, ok: false, reason: String(error?.message ?? error).slice(0, 200), total: 0, rows: [] };
        }
        try {
          fs.writeFileSync(path.join(this.dataDir(), 'schedule-view.json'), JSON.stringify(payload), { mode: 0o600 });
        } catch { /* 写不了就算了，不影响调度 */ }
      }

      // 先处理人工确认请求（App 落的文件）：
      // 用户点了「重排」，这一步把它变成 queued，紧接着的 tick 就会跑它。
      try { requireTaskControl().drain(router, this.dataDir()); } catch { /* 控制面坏了不影响调度 */ }

      const result = await tick(router);

      // 主动层：看一遍状态，自己决定要不要动。
      // 放在 tick 之后：先把手头的活干完，再看有没有新问题。
      try { await this.maybeProactive(router); } catch { /* 主动层坏了不影响调度 */ }

      // 整理也在这里试一次。
      // 原先只在 turn/end 触发，于是「不对话就永远不整理」——而整理恰恰是
      // 用户不在场时最该发生的事。这里只是把「有机会就跑」扩到空闲时段，
      // 真正的门槛（≥20 条新 trace、≥1 小时间隔）仍由 dream.shouldRun 把着。
      try { this.maybeDream(); } catch { /* 整理失败不影响调度 */ }

      if (result.started.length > 0) {
        try {
          this.ctx.logger?.info?.(
            `[auto-guard] 调度启动了 ${result.started.length} 个任务: ${result.started.join(',')}`,
          );
        } catch { /* 无 logger */ }
      }
      // 有任务被 sweep 掉或跑起来了，立刻刷新能力快照，别等下一轮对话
      if (result.swept.length || result.started.length) {
        try { requireCapabilityStatus().writeStatus(this.dataDir()); } catch { /* 面板读不到不影响对话 */ }
      }
    } catch (error) {
      try { this.ctx.logger?.warn?.('[auto-guard] 调度循环异常: %s', error?.message ?? error); } catch { /* 无 logger */ }
    } finally {
      // 任务 outbox 的投递：放在 finally，而不是 tick 的成功分支里。
      // 为什么是这里：
      //   1. 失败/中断事件多半是**这一轮 tick 自己产生的**（后台任务跑失败、
      //      sweep 收了僵尸），必须当轮送出去——这时候用户并没有在发消息，
      //      等不到 turn/start。此前只有 onTurnStart 一处调用，等于「用户不说话
      //      就永远收不到后台失败提醒」，机制在、触发无。
      //   2. tick 抛异常、或宿主没给 agents（执行做不了）时也要投递：
      //      「执行不了」和「送不到消息」是两件事，不能让前者把后者一起带走。
      //   3. 重复投递由 task-registry 的 ack 挡住（pendingOutbox 只给未 ack 的），
      //      所以和 onTurnStart 那一处并存不会弹两次。
      // 外面再包一层 try：flush 内部已有 try/catch，但投递是"附加能力"，
      // 绝不能因为它的任何意外把 finally 打断——那样 schedule() 不执行，
      // 整个调度循环（连带失败重排、watchdog）就停了。
      try { this.flushTaskOutbox(); } catch { /* 投递失败不能拖垮调度循环 */ }
      running = false;
      schedule();
    }
  };

  schedule();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
});

    ctx.effect(() => {
      const offs = [
        ctx.on('session/event', (session, event) => {
          if (event?.type === 'turn/start') this.onTurnStart(session, event);
          else if (event?.type === 'turn/end') this.onTurnEnd(session, event);
          else if (event?.type === 'tool/result') this.onToolResult(session, event);
          else if (event?.type === 'compaction/start') this.onCompaction(session, event);
          // 工具调用的参数只在 assistant/message 里：借它更新「最后一步」。
          else if (event?.type === 'assistant/message') this.onAssistantMessage(session, event);
        }),
      ];

      // 工具调用前：拦截「负载过高还派子任务」这种会拖垮 App 的操作。
      // 用 ctx.on 注册管线事件，没有就静默跳过（不同版本可能没有这个事件）。
      //
      // 判据来自 cost-guard/load-gate.mjs：CPU 或内存 ≥90% 不许派单、≥95% 停重活。
      // 但这里**不能**用它的 1.5s 采样——pre-execute 是同步钩子，阻塞一秒半
      // 会让每次派活都卡一下。改用瞬时值（内存直接读 /proc/meminfo，CPU 用
      // 上一轮采样缓存），宁可保守也不拖慢交互。
      if (typeof ctx.on === 'function') {
        try {
          ctx.on('tools/pre-execute', (call, next) => {
            const name = call?.name ?? call?.tool;
            if (!name || !DISPATCH_TOOL_PATTERN.test(name)) {
              // 非派活工具：走编辑预检（只对会改文件的工具生效）
              // 被截断过的文件不许直接编辑：模型看到的是首尾拼接版，
              // 中间那段它没有，old_str 要么匹配不上，要么匹配到错误位置。
              const stale = this.staleTruncation(call);
              if (stale) return stale;
              const blocked = this.precheckEdit(call);
              return blocked ?? next?.(call);
            }
            const mem = this.memoryPressure();
            if (!mem) return next?.(call);   // 量不了不等于可以派，但也不该误杀正常派活
            const usedPct = (1 - mem.ratio) * 100;
            if (usedPct >= MEMORY_HEAVY_PCT) {
              // 拒绝：给出可行动的理由，不是干巴巴的 "denied"
              return `内存已用 ${usedPct.toFixed(0)}%（剩 ${mem.freeMB}MB/${mem.totalMB}MB），超过 ${MEMORY_HEAVY_PCT}% 停重活线。` +
                     `此时再派任务会被 iOS 静默杀掉（表现为 App 突然回到桌面）。` +
                     `先等现有任务结束或重启 App，再派活。`;
            }
            if (usedPct >= MEMORY_STOP_PCT) {
              return `内存已用 ${usedPct.toFixed(0)}%（剩 ${mem.freeMB}MB/${mem.totalMB}MB），超过 90% 派单线。` +
                     `先收尾现有任务，或者改用更小的任务；继续派子代理很可能被系统杀掉。`;
            }
            return next?.(call);
          });
        } catch {
          // 管线事件不存在：只保留会话事件那一套，功能降级但不崩。
        }

        // 上下文闸门：一次工具输出就能吃掉几万 token，而它会被**每一轮**重新读。
        //
        // 为什么要在 post-execute 改：这里能拿到工具结果本身，也能返回
        // `{kind:'accept', content}` 替换它（dsh-tools pipeline 的契约）。
        // 放到别处改不了，只能看着上下文涨。
        //
        // 阈值怎么定的：
        //   - 40k 字符 ≈ 15k token，已经是单次工具输出里罕见的大值；
        //   - 保留首尾各 1/3——命令输出通常开头是命令/头部、结尾是结论/错误；
        //   - 中间明确写「已截断 + 原长度 + 怎么拿全量」，让模型知道可以重跑取局部。
        try {
          ctx.on('tools/post-execute', (exec, result) => {
            const limit = 40000;
            const content = result?.content;
            if (!Array.isArray(content)) return { kind: 'accept' };
            let total = 0;
            for (const block of content) {
              if (block?.type === 'text' && typeof block.text === 'string') total += block.text.length;
            }
            if (total <= limit) return { kind: 'accept' };

            const perBlock = Math.max(2000, Math.floor(limit / Math.max(1, content.length)));
            let trimmed = 0;
            const next = content.map((block) => {
              if (block?.type !== 'text' || typeof block.text !== 'string') return block;
              if (block.text.length <= perBlock) return block;
              const head = block.text.slice(0, Math.floor(perBlock * 2 / 3));
              const tail = block.text.slice(-Math.floor(perBlock / 3));
              trimmed += 1;
              return {
                ...block,
                text: `${head}\n\n…（输出过长已截断：原文 ${block.text.length} 字符，` +
                      `保留首尾。需要中间部分请用更精确的命令重取，例如 grep/head/tail 限定范围）…\n\n${tail}`,
              };
            });
            if (trimmed > 0) {
              // 记下这个文件「模型只看到首尾」。编辑前要拦一次，
              // 否则它会拿截断版的 old_str 去匹配，改错位置或者干脆失败。
              try {
                const a = exec?.arguments ?? {};
                const target = a.file_path ?? a.path ?? a.filePath ?? a.file;
                if (typeof target === 'string' && target) {
                  // 插件级而不是会话级：exec 上拿 session 不可靠，
                  // 而「这个文件被截断过」这件事跨轮次都成立。
                  this.truncatedFiles.set(target, Date.now());
                }
              } catch { /* 记不下就退回只靠提示 */ }
              try {
                this.notify(`工具 ${exec?.name ?? '?'} 输出过长（${total} 字符），已截断后交给模型`,
                            { kind: 'compaction' });
              } catch { /* 提醒失败不影响结果 */ }
            }
            return { kind: 'accept', content: next };
          });
        } catch {
          // 没有这个钩子就退化成不裁剪：宁可费 token，也不能让工具结果送不回去。
        }
      }

      return () => offs.forEach((off) => off?.());
    }, 'auto-guard: session event hooks');
  }

  runtime(session) {
    let s = this.state.get(session);
    if (!s) {
      s = { turns: 0, warnedTurn: false, warnedCompact: false,
            lastTool: null, repeat: 0, warnedRepeat: false, warnedMem: false,
            // 本轮加载过哪些技能。记下来是为了在 turn/end 时配上**真实结果**——
            // 只在加载时记一笔的话，成功率永远是「未知」，降级规则拿不到输入。
            skillsThisTurn: [],
            // 用户连续纠错的检测：同一个毛病被反复指出，说明上次没改对。
            // 真机实测过：用户连说三次「文字超出框了」，模型每次都改、每次都犯。
            lastUserText: '',
            repeatComplaints: 0 };
      this.state.set(session, s);
    }
    return s;
  }

  /**
   * 读系统内存。优先 /proc/meminfo —— iSH 上 free -m 是静态桩（固定返回
   * 4096/0/4096），拿它判断等于没判断。
   */
  memoryPressure() {
    try {
      const text = fs.readFileSync('/proc/meminfo', 'utf8');
      const get = (k) => {
        const m = new RegExp(`^${k}:\\s+(\\d+)\\s+kB`, 'm').exec(text);
        return m ? Number(m[1]) : null;
      };
      const total = get('MemTotal');
      // ⚠ iSH 的 /proc/meminfo 没有 MemAvailable，只有 MemFree；而 MemFree 不含
      // 可回收缓存（实测 64MB/4GB），拿它当「可用」会算出 97% 的假警报。
      // 没有 MemAvailable 就走 os.freemem()——iOS 上它是真实值（实测 3447MB）。
      const avail = get('MemAvailable');
      if (total && avail !== null) {
        return {
          totalMB: Math.round(total / 1024),
          freeMB: Math.round(avail / 1024),
          ratio: avail / total,
        };
      }
      const totalBytes = os.totalmem();
      const freeBytes = os.freemem();
      if (!totalBytes) return null;
      return {
        totalMB: Math.round(totalBytes / 1048576),
        freeMB: Math.round(freeBytes / 1048576),
        ratio: freeBytes / totalBytes,
      };
    } catch {
      // /proc 不可用：退回 os.freemem（iOS 上通常是 0，但至少不崩）
      const total = os.totalmem();
      const free = os.freemem();
      if (!total) return null;
      return { totalMB: Math.round(total / 1048576), freeMB: Math.round(free / 1048576), ratio: free / total };
    }
  }

  /** 数据目录：与 main.mjs、turns/trace 同一口径。 */
  dataDir() {
    return process.env.DSH_IOS_DATA || process.cwd();
  }

  /** 在跑集合变了就覆盖写一次。写失败不影响对话。 */
  persistInFlight() {
    try {
      writeInFlight(this.dataDir(), Object.fromEntries(this.inFlight));
    } catch { /* 飞行记录是副产物 */ }
  }

  /**
   * 任务标题：用会话的工作区名，取不到就用轮次。
   *
   * 为什么不拿 projection 里的会话标题：那是异步投影，在 turn/start 这一刻
   * 不一定已经就位（而且它本身是模型生成的标题，一句话任务用它反而更啰嗦）。
   * 任务表要的是「这件事发生在哪个项目」，工作区名比会话标题更稳定。
   */
  sessionTitle(session) {
    const cwd = session?.header?.cwd;
    if (typeof cwd === 'string' && cwd) {
      const base = cwd.replace(/\/+$/, '').split('/').pop();
      if (base) return base;
    }
    return null;
  }

  onTurnStart(session, event) {
    // 记下最近的用户会话：主动层要派活，总得知道派给谁。
    // 放在 turn/start 而不是 turn/end——否则开机后第一轮结束前，
    // 主动层拿不到任何会话，「自己派活」这条永远不触发。
    try {
      if (String(session?.header?.origin ?? '') !== 'subagent') {
        this.lastSessionId = sessionId(session);

      // 计划进度：读工作区里的 .plan.md，落一份给 App 看。
      // 读失败 / 没有文件都正常（多数任务不需要计划文件），不记日志。
      try {
        const mod = requirePlan();
        const cwd = session?.header?.cwd ?? null;
        const plan = mod.readPlan(cwd);
        this.planProgress = mod.describeProgress(plan);
        fs.writeFileSync(
          path.join(this.dataDir(), 'plan-view.json'),
          JSON.stringify(mod.toView(plan, { cwd }), null, 0),
          { mode: 0o600 },
        );
      } catch { /* 计划是可选的，读不到不影响对话 */ }
      }
    } catch { /* 记不下就算了 */ }
    const s = this.runtime(session);
    s.turns += 1;


    // 子智能体的轮次不进飞行记录：用户在界面上看不到那些子会话，
    // 重启后提示「3 个任务被打断」只会让人莫名其妙——父会话自己会报。
    // （onTurnEnd 里原本就有同样的过滤，两处必须一致。）
    if (String(session?.header?.origin ?? '') !== 'subagent') {
      // turn 号三个来源，按可靠性排序：
      //   1. 事件自身 `event.data.turn`（turn/start 一定带，最可靠）
      //   2. 会话事件列表里最后一条 turn/start
      //   3. 放弃（记为 null，不猜 s.turns——那是插件进程内计数，
      //      重启后从 1 重来，拿它当幂等键会跟历史任务撞车）
      //
      // 之前只用了第 2 种，而真机上 session 对象未必有 ownEvents()/events
      // （结构随 Harness 版本变），于是 turn 永远是 undefined，
      // `Number.isInteger(turn)` 为 false，tasks.json 一次都没被写过。
      // 而 onTurnStart 连 event 参数都没接收，第 1 种来源根本没机会用。
      const eventTurn = Number.isInteger(event?.data?.turn) ? event.data.turn : null;
      const events = typeof session?.ownEvents === 'function' ? session.ownEvents() : session?.events;
      const listTurn = Array.isArray(events)
        ? [...events].reverse().find((item) => item?.type === 'turn/start')?.data?.turn
        : undefined;
      const turn = eventTurn ?? (Number.isInteger(listTurn) ? listTurn : null);
      this.inFlight.set(sessionId(session), { at: Date.now(), step: '', turn: Number.isInteger(turn) ? turn : null });
      this.persistInFlight();

      // 任务表：一轮 = 一个任务。幂等键是 sessionId:turn，重复事件不会建出两条。
      // 记失败不影响对话——这是补充信息，不是主流程。
      if (Number.isInteger(turn)) {
        try {
          const track = requireTaskTracking();
          this.currentTask = track.onTurnStart(this.dataDir(), {
            sessionId: sessionId(session),
            turn,
            title: this.sessionTitle(session),
          });
        } catch { /* 记账是副产物 */ }
      }
    }

    // 落盘记一笔 —— 这是 cost-guard 那条闭环的开关。
    //
    // 之前的窟窿：轮次只记在内存里（this.state 是 WeakMap），进程重启清零，
    // 而 skills/cost-guard/turns.mjs 读的是 .turns.jsonl —— 那个文件从来没人写。
    // 结果就是 `turns.mjs status` 永远显示 0 轮，40 轮红线永不触发，
    // 「该换会话了」这句提醒等于不存在。
    // 现在每轮往同一个文件追加一行，两边用同一份事实。
    this.recordTurn(session, s.turns);

    // 场景解析：确定「现在在哪个项目」。没有场景时停下问，而不是退回通用模式瞎干。
    // 这是 scene-schema.mjs 唯一的运行入口——之前它只有测试，从没被调用过。
    this.resolveSceneFor(session);

    if (s.turns > this.turnsMax && !s.warnedTurn) {
      s.warnedTurn = true;
      this.notify(
        `会话已 ${s.turns} 轮，超过 ${this.turnsMax} 轮红线。` +
        '该考虑换会话了：先把进度写进 HANDOFF.md（下一步要具体），再开新会话。',
        { kind: 'turns', turns: s.turns, session: sessionId(session) },
      );
    }

    // 派单催办：把 sentinel.mjs 那条「未回执」检查接进每轮，不再靠自觉去跑。
    //
    // 为什么必须是机制：sentinel.mjs 早就写好了 open/awaited 和超时判断，
    // 但全仓没有一处调用它——和轮次计数、记忆注入是同一个病：能力在，触发无。
    // 靠人记得跑，漏掉的恰好是「最该催」的那几条。
    this.checkDispatches(session);

    // 任务表：把 outbox 里还没投递的通知发出去。
    // 任务状态本身由 Router/调用方通过 task-registry 写，这里只负责「不丢消息」。
    this.flushTaskOutbox(session);

    // Dream：攒够 trace 就整理一次（10 分钟最多检查一次）。
    this.maybeDream();
  }

  /**
   * 把 task registry 的 outbox 投递到提醒通道，并 ack。
   *
   * 两个触发点，缺一不可：
   *   · 每轮 turn/start —— 用户在场时的低延迟通道
   *   · 15 秒调度循环的 finally —— 用户不在场时唯一的节拍
   *     （失败/中断事件本身就是后台 tick 产生的，那时没有轮次可等）
   *
   * 幂等：已 ack 的事件不会再被 pendingOutbox 选中。
   *
   * @returns {number} 本次真正交出去（因而 ack）的条数
   */
  flushTaskOutbox(session = null) {
    try {
      const state = loadTasks(this.dataDir());
      const pending = pendingOutbox(state);
      if (!pending.length) return 0;
      let delivered = 0;
      for (const event of pending.slice(0, 5)) {   // 一次最多 5 条，避免刷屏
        // eventId 跟着走：main.mjs 透传进 notices.jsonl，App 按 id 去重。
        const posted = this.notify(event.message, {
          ...(event.detail ?? {}),
          eventId: event.eventId,
          kind: event.kind,
          taskId: event.taskId,
          session: sessionId(session),
        });
        // 只有真的交给宿主才 ack。notify() 明确知道没送出去（没有 parentPort /
        // postMessage 抛错）时返回 false——这时候 ack 等于把事件吞了：
        // 用户看不到，outbox 里也翻不出来。留着重投，下一拍还会再试。
        // 用 !== false 而不是 === true：测试/宿主里替换 notify 的桩返回 undefined，
        // 那属于「未知」，按原来的语义照样 ack；只有明确的 false 才拦。
        if (posted !== false) {
          ackTaskEvent(state, event.eventId);
          delivered += 1;
        }
      }
      if (delivered) saveTasks(state, this.dataDir());
      return delivered;
    } catch (error) {
      try { this.ctx.logger?.warn?.('[auto-guard] task outbox 投递失败: %s', error?.message ?? error); } catch { /* 无 logger */ }
      return 0;
    }
  }

  /**
   * 每轮开始时看一眼：有没有发出去很久还没人回的派单。
   *
   * 每分钟最多查一次（同一进程内多会话会各自触发，不缓存就会重复 spawn）。
   * 只看 `open`（我发出没回的）；`awaited`（别人等我的）由 Agent 自己按
   * 技能文档处理，插件不替它回答。
   */
  checkDispatches(session) {
    const now = Date.now();
    if (now - (this.lastDispatchCheck ?? 0) < 60_000) return;
    this.lastDispatchCheck = now;

    try {
      const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../skills/dispatch-protocol/sentinel.mjs');
      if (!fs.existsSync(tool)) return;   // 被裁剪过的构建：静默跳过，不是错误

      // 用 execFileSync 而不是 shell：iOS 上没有真正的 fork/exec，但 Node 的
      // child_process 在引擎里已被 shim 成 worker（runtime/child-process.mjs），
      // 这条路是通的。反引号/空格也不用转义。
      let out;
      try {
        out = execFileSync(process.execPath, [tool, 'open', '--stale', '30'], {
          encoding: 'utf8',
          timeout: 5000,
          env: { ...process.env, DSH_SENTINEL_LEDGER: this.ledgerFile() },
        });
      } catch (error) {
        // 退出码 1 = 发现超时派单（这是我们要的）；2 = 用法错；其它 = 工具本身坏了。
        if (error?.status === 1 && typeof error.stdout === 'string') out = error.stdout;
        else return;
      }

      const overdue = String(out ?? '').match(/⚠\s*(\d+)\s*条超时未回执/);
      if (!overdue || Number(overdue[1]) === 0) return;
      this.notify(
        `有 ${overdue[1]} 个派单超时没回执。别假设对方在跑——查一下，或者直接催/自己接手。`,
        { kind: 'dispatch', count: Number(overdue[1]), session: sessionId(session) },
      );
    } catch { /* 催办是提醒，失败了不影响这一轮 */ }
  }

  /** 派单台账路径，与 sentinel.mjs 的默认口径一致。 */
  ledgerFile() {
    return process.env.DSH_SENTINEL_LEDGER
      || path.join(process.env.DSH_IOS_DATA || process.cwd(), '.sentinel.jsonl');
  }

  /**
   * 启动时体检技能元数据。结果写进引擎日志，不弹 toast。
   *
   * 为什么不弹：技能缺个 version 不是用户该操心的事，弹出来只会让人以为出错了。
   * 但必须留痕迹——否则「18 个技能都有版本和权限」这句话永远没人验证过。
   */
  auditSkillsOnce() {
    try {
      const { auditSkills } = requireSkillRegistry();
      // 技能目录与 main.mjs 的 DSH_BUNDLED_SKILL_DIR 同一口径
      const dir = process.env.DSH_BUNDLED_SKILL_DIR
        || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../skills');
      const r = auditSkills(dir);
      if (!r.skills?.length) return;
      const bad = r.skills.filter((s) => !s.ok);
      const warn = r.skills.filter((s) => s.ok && s.warnings?.length);
      if (bad.length === 0 && warn.length === 0) {
        this.ctx.logger?.info?.(`[auto-guard] 技能体检通过：${r.skills.length} 个`);
        return;
      }
      for (const s of bad) {
        this.ctx.logger?.warn?.(`[auto-guard] 技能 ${s.name} 不合格：${s.errors.join('；')}`);
      }
      for (const s of warn.slice(0, 5)) {
        this.ctx.logger?.warn?.(`[auto-guard] 技能 ${s.name} 有警告：${s.warnings.join('；')}`);
      }
    } catch { /* 体检失败不影响启动 */ }
  }

  /**
   * 编辑前预检：在临时副本上试改一遍，语法不通就拦下。
   *
   * 为什么放在 pre-execute：钩子只能「拦」或「放」，不能替工具执行。
   * 所以这里把改动试算一遍（不落盘），通过才放行真正的工具去改。
   * 失败时返回错误字符串（钩子的拒绝语义），此时文件一个字都没动。
   *
   * 只处理「替换片段」类工具（edit / str_replace / apply_patch）。
   * `write` 整文件覆盖不适用：它没有 oldStr，也没法在写入前拿到最终内容。
   *
   * @returns {string|null} 拒绝理由；null 表示放行
   */
  /**
   * 这个文件的内容是不是被截断过？是就返回一句可行动的拦截理由。
   *
   * 为什么必须拦：截断保留的是首尾，中间那段模型根本没有。
   * 拿它去写 old_str，要么匹配不上（白跑一轮），要么匹配到同名的另一处
   * （**改错地方**，比失败糟糕得多）。拦一次让它先精确重读，代价是一轮。
   *
   * 只拦一次：拦完就把标记清掉，避免模型重读之后仍然被卡住。
   * 15 分钟后自动过期，防止一个很早的截断一直挡着。
   */
  staleTruncation(call) {
    try {
      const name = String(call?.name ?? call?.tool ?? '').split('__').pop();
      if (!/^(edit|str_replace|str_replace_editor|apply_patch)$/i.test(name)) return null;
      const args = call?.args ?? call?.input ?? call?.arguments;
      if (!args) return null;
      const file = args.file_path ?? args.path ?? args.filePath ?? args.file;
      if (typeof file !== 'string' || !file) return null;
      const at = this.truncatedFiles.get(file);
      if (!at) return null;
      if (Date.now() - at > 15 * 60_000) { this.truncatedFiles.delete(file); return null; }
      this.truncatedFiles.delete(file);      // 只拦一次
      return `你之前看到的 ${file} 是**截断版**（只保留首尾，中间省略了）。` +
             '直接按它编辑可能匹配到错误位置。先用 read 加上行范围（或用 grep 定位到具体几行）' +
             '精确读一次，确认要改的原文，再编辑。';
    } catch {
      return null;
    }
  }

  precheckEdit(call) {
    try {
      const name = String(call?.name ?? call?.tool ?? '').split('__').pop();
      if (!/^(edit|str_replace|str_replace_editor|apply_patch)$/i.test(name)) return null;

      const args = call?.args ?? call?.input ?? call?.arguments;
      if (!args) return null;
      const file = args.file_path ?? args.path ?? args.filePath;
      const oldStr = args.old_str ?? args.old_string ?? args.oldStr ?? args.search;
      const newStr = args.new_str ?? args.new_string ?? args.newStr ?? args.replace;
      if (typeof file !== 'string' || !file) return null;
      if (typeof oldStr !== 'string' || typeof newStr !== 'string') return null;

      const { safeEdit } = requireSafeEdit();
      const result = safeEdit(file, oldStr, newStr, { dryRun: true });
      if (result.ok) return null;

      if (result.stage === 'lint') {
        return `这次编辑会让文件语法出错（${result.message}）。已经拦下，文件没动。` +
               '改法：先确认改动位置和括号/引号是否配对，再试一次。';
      }
      if (result.stage === 'unique') {
        return `要替换的片段${result.message}。请把 old_str 写得更完整一点，确保只匹配那一处。`;
      }
      return null;      // precheck 失败（文件读不到等）不该替工具做决定
    } catch {
      return null;      // 预检本身出错时放行，不要因为检查器坏了就卡死编辑
    }
  }

  /**
   * 解析当前场景，结果缓存在插件里（每轮更新一次，不重复读盘）。
   *
   * 为什么必须接：scene-schema.mjs 早就写好了五种解析路径和「无场景就停下」的规则，
   * 但没有任何运行时代码调用它——场景从来没被真正解析过，
   * 所谓「按项目隔离」只是一句空话。
   *
   * 用 session.header.cwd 作工作区：meow-memory 也是拿它定位记忆库的，
   * 两个模块必须看同一个路径，否则场景和记忆会指向不同的项目。
   */
  resolveSceneFor(session) {
    try {
      const cwd = session?.header?.cwd;
      if (typeof cwd !== 'string' || !cwd) return;    // 没有 cwd 就没法解析，跳过
      const { resolveScene } = requireSceneSchema();
      const result = resolveScene({
        workspaceRoot: cwd,
        session: { sceneId: session?.header?.sceneId ?? null },
        defaultRoot: process.env.DSH_DEFAULT_SCENE || null,
      });
      this.scene = result;
      if (result.status === 'ambiguous') {
        // 只在第一次说，不要每轮都提醒
        if (!this.sceneWarned) {
          this.sceneWarned = true;
          this.notify(
            '还没有配置场景：先选一个项目再开始，否则规矩和记忆会混在一起。',
            { kind: 'scene_missing', session: sessionId(session) },
          );
        }
      } else if (result.status === 'mismatch') {
        this.notify(result.reason, { kind: 'scene_mismatch', session: sessionId(session) });
      }
    } catch { /* 场景解析失败不影响对话 */ }
  }


  /**
   * 每轮顺手看一眼该不该跑 Dream。
   *
   * 为什么挂在这里：iOS 上没有常驻定时器，App 一被挂起就停。轮次是唯一
   * 可靠的节拍——用户每说一句话就检查一次，攒够了就整理。
   *
   * 代价：只有用户在用时才会整理。对单机 App 这是物理限制，不是设计选择。
   * 真正的定时整理要 Phase 3 的常驻 Hub。
   */
  /**
   * 主动层：每 5 分钟最多看一次状态。
   *
   * 为什么单独限流：调度循环本身 15 秒一拍，但「有没有新问题」这种判断
   * 没必要那么频繁——文件读写 + 聚类都是成本，而问题不会 15 秒变一次。
   */
  async maybeProactive(router) {
    const now = Date.now();
    if (now - (this.lastProactiveCheck ?? 0) < 5 * 60_000) return;
    this.lastProactiveCheck = now;

    // 派给哪个会话：用最近一次真正在用的那个。
    // 没有活跃会话就只做「提醒」类动作，不派活——派给不存在的会话等于空转。
    const sessionId = this.lastSessionId ?? null;

    try {
      const { runProactive } = requireProactive();
      const control = requireTaskControl();
      const r = runProactive(this.dataDir(), {
        now,
        sessionId,
        enqueue: ({ sessionId: target, text, eventId }) => {
          const out = control.handle(router, { action: 'enqueue', sessionId: target, text, eventId });
          if (!out?.ok) throw new Error(out?.error ?? '投递被拒');
          return out;
        },
        notify: ({ kind, message }) => this.notify(message, { kind }),
      });
      if (r.acted.length > 0) {
        try {
          this.ctx.logger?.info?.(`[auto-guard] 主动: ${r.acted.map((a) => `${a.action}:${a.id}`).join(', ')}`);
        } catch { /* 无 logger */ }
      }
    } catch { /* 主动层是增值功能，坏了不能拖累调度 */ }
  }

  maybeDream() {
    const now = Date.now();
    if (now - (this.lastDreamCheck ?? 0) < 10 * 60_000) return;   // 10 分钟最多看一次
    this.lastDreamCheck = now;
    try {
      const { shouldRun, runDream } = requireDream();
      if (!shouldRun(this.dataDir()).shouldRun) return;

      const { createMemoryStore, workspaceFromEnv } = requireMemoryStore();
      const store = createMemoryStore(workspaceFromEnv());
      if (!store.available) return;    // 记忆库不可用就别跑，跑了也留不下东西

      const r = runDream(this.dataDir(), { store });
      store.close();
      if (r.ran && r.stored > 0) {
        this.ctx.logger?.info?.(`[auto-guard] Dream 整理完成：落库 ${r.stored} 条技能记忆`);
      }
    } catch { /* 整理失败不影响对话 */ }
  }

  /**
   * 把这一轮写进 cost-guard 的事件文件，格式与 turns.mjs 的 appendEvent 一致：
   * 每行一个 `{kind, at, ...}` 事件，只追加。
   *
   * 为什么不直接 import turns.mjs：那是给人跑的 CLI，带 process.exit 和
   * 一整套参数解析，在插件里调会污染进程。这里只复刻它的存储格式——
   * 格式是两边唯一的契约，保持最小耦合。
   *
   * 路径规则跟 turns.mjs 一致：DSH_TURNS_FILE 优先，否则数据目录下的
   * .turns.jsonl。不写到 cwd（iOS 上 cwd 是只读的包目录）。
   */
  recordTurn(session, turns) {
    try {
      const file = process.env.DSH_TURNS_FILE
        || path.join(process.env.DSH_IOS_DATA || process.cwd(), '.turns.jsonl');
      const line = JSON.stringify({
        kind: 'tick',
        at: Date.now(),
        turns,
        tokens: 0,
        session: sessionId(session),
      }) + '\n';
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch (error) {
      // 记账失败不该影响对话本身：坏一个计数文件，比让这一轮发不出去好。
      try { this.ctx.logger?.warn?.('[auto-guard] turns 记账失败: %s', error?.message ?? error); } catch { /* 无 logger */ }
    }
  }

  /**
   * 一轮结束时记一条 trace —— 进化闭环的入口。
   *
   * 为什么放在插件里而不是写进 AGENTS.md 让 agent 自己记：靠自觉的调用早晚会漏，
   * 而漏掉的正是「失败的那几轮」——恰恰是最该沉淀的经验。机器记则不会漏。
   *
   * 记什么：成功/失败、用了哪些工具、这轮大致在干什么。摘要从这一轮的
   * 用户消息和最后的助手回复里各取一点，够蒸馏时认出来就行，不做全文存档。
   *
   * 失败绝不打断流程：trace 是副产物，坏了就坏了。
   */
  /**
   * 从会话事件里读最后一条 assistant 文本，找 `ACCEPT: PASS|FAIL`。
   *
   * 为什么单独扫一遍而不是复用 trace 那段：trace 记账在 onTurnEnd 末尾，
   * 而自检结果要在这之前交给任务表。两处各扫一次的成本可以忽略
   * （一轮最多几百条事件，且只取最后 1200 字）。
   */
  readAcceptance(session) {
    const events = typeof session?.ownEvents === 'function' ? session.ownEvents() : session?.events;
    if (!Array.isArray(events)) return null;
    let text = '';
    for (let i = events.length - 1; i >= 0 && !text; i -= 1) {
      const e = events[i];
      if (e?.type !== 'assistant/message') continue;
      const content = e.data?.message?.content ?? e.data?.content ?? [];
      const parts = [];
      for (const b of content) if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      if (parts.length > 0) text = parts.join(' ').slice(-1200);
    }
    if (!text) return null;
    const m = text.match(/ACCEPT:\s*(PASS|FAIL)\b([^\n]*)/i);
    if (!m) return null;
    const result = m[1].toUpperCase() === 'PASS' ? 'pass' : 'fail';
    const reason = (m[2] ?? '').trim() || null;
    if (result === 'fail') {
      try {
        this.notify(`任务自检没过：${reason ?? '未说明原因'}`,
                    { kind: 'task_failed', session: sessionId(session) });
      } catch { /* 提醒失败不影响记账 */ }
    }
    return { result, reason };
  }

  onTurnEnd(session, event) {
    try {
      // 飞行记录：这一轮结束了，把它从在跑集合里摘掉。
      // 放在 try 最前面：即使后面 trace 写失败，也必须先销账。
      this.inFlight.delete(sessionId(session));
      this.persistInFlight();

      const s = this.runtime(session);
      const reason = event?.data?.reason?.kind;
      // 记忆插件自己发的内省轮次不算工作，记进来会污染统计。
      if (String(session?.header?.origin ?? '') === 'subagent') return;


      // 技能效果：本轮加载过的技能，配上这一轮的真实结果。
      //   completed → 成功（ok=true）
      //   其余（error / aborted / max-tokens …）→ 失败（ok=false）
      // 这是 skill-stats 从「只知加载过几次」变成「知道有没有用」的关键一步：
      // 没有它，失败率永远算不出来，`degrade` 那套自动降级等于没有输入。
      if (Array.isArray(s.skillsThisTurn) && s.skillsThisTurn.length > 0) {
        try {
          const { record } = requireSkillStats();
          const ok = reason === 'completed';
          for (const skillName of s.skillsThisTurn) {
            record(skillName, ok, { dataDir: this.dataDir() });
          }
        } catch { /* 记账失败不影响对话 */ }
        s.skillsThisTurn = [];
      }

      // 自检标记要在任务收尾**之前**解析：onTurnEnd 要把结果写进任务表。
      // 从会话事件里取最后一条 assistant 文本的尾部——正文里引用到
      // 「ACCEPT」这两个词的概率远低于它作为格式标记出现的概率，
      // 但只扫结尾 1200 字能再降低误判。
      try {
        this.lastAcceptance = this.readAcceptance(session);
      } catch { this.lastAcceptance = null; }

      // 任务收尾：按 turn/end 的真实原因转终态。
      // 必须在 writeStatus **之前**——快照统计的是任务表，
      // 先刷快照再改状态，面板永远显示上一轮的样子。
      if (Number.isInteger(event?.data?.turn)) {
        try {
          requireTaskTracking().onTurnEnd(this.dataDir(), {
            sessionId: sessionId(session),
            turn: event.data.turn,
            reasonKind: reason,
            error: event?.data?.reason?.error?.message ?? null,
            acceptance: this.lastAcceptance ?? null,
          });
          this.lastAcceptance = null;

          // 独立验证：跑任务声明的命令，用退出码说话。
          // 放在 acceptance 之后：模型自述先落，引擎判定再覆盖——
          // 冲突时以退出码为准（见 recordVerification 的注释）。
          try {
            const v = requireTaskTracking().recordVerification(this.dataDir(), {
              sessionId: sessionId(session),
              cwd: session?.header?.cwd ?? null,
            });
            if (v.ran && v.ok === false) {
              this.notify(
                `任务验证没过：${v.results.find((r) => r.ok === false)?.cmd ?? ''}`,
                { kind: 'task_failed', session: sessionId(session) },
              );
            }
          } catch { /* 验证跑不了不影响对话 */ }
        } catch { /* 记账是副产物 */ }
      }

      // 能力快照必须**每轮结束都刷一次**，而且要在所有「可能提前 return 的分支」之前：
      // 原来它写在 `if (!summary) return;` 之后，凡是取不到摘要的轮次
      // （工具密集、纯执行、模型没输出正文）就都不会刷新，
      // 面板于是长期停在旧状态甚至「还没开始干活」。
      // 快照是纯投影，写失败也不影响对话，所以放最前面最安全。
      try { requireCapabilityStatus().writeStatus(this.dataDir()); } catch { /* 面板读不到不影响对话 */ }

      const events = typeof session?.ownEvents === 'function' ? session.ownEvents() : session?.events;
      const list = Array.isArray(events) ? events : [];

      // ⚠ 只扫**本轮**：从最后一个 turn/start 往后。
      // 之前的实现对整个会话历史取「最后一条 user / assistant」，导致上一轮的
      // 内容被当成这一轮的摘要——交错两轮之后，trace 记的是旧任务，蒸馏出来
      // 的「经验」指向错误的事件。会话越长，错得越隐蔽。
      //
      // ⚠⚠ 但**不能假设 list 一定有内容**。真机上 session 对象未必有
      // ownEvents()/events（结构随版本变），那时 list 是空数组：
      //   - turn 取不到 → tasks.json 不写
      //   - summary 为空 → `if (!summary) return` → .trace.jsonl 不写
      // 而 capability.json / .turns.jsonl 在这之前，照样写。
      // 表现就是「部分文件有、部分没有」——正是真机上看到的样子。
      // 所以：事件列表只当**补充**，必需信息优先从 turn/end 事件自身取。
      let start = -1;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i]?.type === 'turn/start') { start = i; break; }
      }
      const current = start >= 0 ? list.slice(start) : list;

      // turn 号：事件自带的最可靠（`turn/end` 的 data.turn 就是本轮编号）。
      const eventTurn = Number.isInteger(event?.data?.turn) ? event.data.turn : null;
      const listTurn = Array.isArray(list)
        ? [...list].reverse().find((item) => item?.type === 'turn/start')?.data?.turn
        : undefined;
      const turn = eventTurn ?? (Number.isInteger(listTurn) ? listTurn : null);

      const tools = [];
      let userText = '';
      let assistantText = '';
      for (const e of current) {
        if (e?.type === 'tool/ptc-dispatch' && typeof e.data?.name === 'string') {
          if (!tools.includes(e.data.name)) tools.push(e.data.name);
        } else if (e?.type === 'user/message') {
          for (const b of e.data?.content ?? []) {
            if (b?.type === 'text' && typeof b.text === 'string' && !b.text.startsWith('[')) {
              // 本轮可能有多条用户消息（中途补充要求），用最后一条作摘要；
              // 但只在本轮范围内找，不会跳到上一轮去。
              userText = b.text;
            }
          }
        } else if (e?.type === 'assistant/message') {
          // 正文在 data.message.content 里，不是 data.content。
          // 早先写成 data.content 时，assistant 文本永远取不到，摘要静默退化成
          // 用户那句话——看起来「有记录」，实际记的不是模型的结论。
          const content = e.data?.message?.content ?? e.data?.content;
          for (const b of content ?? []) {
            if (b?.type === 'text' && typeof b.text === 'string') {
              assistantText = assistantText ? assistantText + ' ' + b.text : b.text;
            }
          }
        }
      }

      // 摘要兜底：拿不到会话事件时，至少把「这一轮是什么结局」记下来。
      // 记一条"只有结果、没有内容"的经验，比一条都不记强——后者会让进化闭环
      // 完全断掉（蒸馏永远没有原料），而前者至少能统计成功率、发现失败模式。
      const summary = assistantText || userText
        || (turn ? `第 ${turn} 轮（${reason ?? '未知结果'}，未取到会话内容）` : '');
      if (!summary) return;   // 连轮次都没有，才是真的空轮次

      appendJsonlBounded(this.traceFile(), {
        at: Date.now(),
        kind: 'task',
        // 成功判定用白名单：只有明确正常结束才算成功。
        // 原来的 `reason !== 'error'` 把 aborted / interrupted / max-tokens / quota
        // 全算成成功，蒸馏时会「学到」错误的做法。
        ok: outcomeOf(reason),
        reason: reason ?? 'unknown',
        summary: redact(summary.replace(/\s+/g, ' ').trim()).slice(0, 300),
        // 用话题标签而不是工具名：见 TOPIC_RULES 的注释。
        tags: topicsOf(summary + ' ' + userText),
        tools: tools.slice(0, 6),
        source: 'auto-guard',
      });

      s.traceWritten = true;

      // 再刷一次快照。
      //
      // 为什么刷两次：上面那次（this.onTurnEnd 开头）跑在 **trace 落盘之前**，
      // 所以快照里的「记录 N 轮」永远落后一轮——只有一轮对话的用户，
      // 面板会一直显示「还没开始干活」，看起来像功能没生效。
      // 快照是纯投影，多刷一次的代价是几毫秒的文件读。
      try { requireCapabilityStatus().writeStatus(this.dataDir()); } catch { /* 面板读不到不影响对话 */ }
    } catch (error) {
      try { this.ctx.logger?.warn?.('[auto-guard] trace 记账失败: %s', error?.message ?? error); } catch { /* 无 logger */ }
    }
  }

  /** trace 文件路径，与 skills/evolve/trace.mjs 保持同一口径。 */
  traceFile() {
    return process.env.DSH_TRACE_FILE
      || path.join(process.env.DSH_IOS_DATA || process.cwd(), '.trace.jsonl');
  }

  /**
   * 每个工具调用开始时把「最后一步」写进飞行记录。
   *
   * 为什么必须在这里更新：崩溃不会提前打招呼，等到出事再问「刚才在干什么」
   * 已经问不到了。每步都写一次（覆盖，不追加），崩溃时文件里就是最后一步。
   *
   * `summary` 由调用方从 tool-call 参数里提取：tool/result 只有工具名，
   * 参数在 assistant/message 的 tool-call 块里。
   */
  recordStep(session, toolName, summary) {
    const id = sessionId(session);
    const current = this.inFlight.get(id);
    // 只更新已经在飞的：没记录的会话（比如子智能体）不凭空造一条。
    if (!current) return;
    current.step = describeStep(toolName, summary);
    current.at = Date.now();
    this.persistInFlight();
  }

  /**
   * 一条助手消息里可能有多个工具调用。取最后一个带参数的，写成「最后一步」。
   *
   * 只在消息层面写一次盘（而不是每个调用写一次）：一条消息里常常并排三四个
   * 读取，逐个写是纯浪费；反正崩溃时能看到的只是最后那一个。
   */
  onAssistantMessage(session, event) {
    try {
      const content = event?.data?.message?.content ?? event?.data?.content;
      if (!Array.isArray(content)) return;
      let last = null;
      for (const part of content) {
        if (part?.type !== 'tool-call' || typeof part.name !== 'string') continue;
        last = part;
      }
      if (!last) return;
      this.recordStep(session, last.name, this.argumentHint(last));
    } catch { /* 摘要只是锦上添花，出错不影响主流程 */ }
  }

  /**
   * 用户是不是在重复同一个抱怨。
   *
   * 真机上发生过：连着三轮「文字超出框了」「框里面还是有文字超出了」，
   * 模型每次都改、每次都犯，而它自己写进记忆的教训当轮读不到
   * （meow 的自动注入排除本会话写入的条目）。
   *
   * 这里不猜语义，只做两件事：认出「短句 + 抱怨词」，和在重复第二次时
   * 提醒「上次没改对，先复述一遍你学到什么」。宁可少提醒，不要误伤
   * 正常的追加需求。
   */
  noteUserText(session, text) {
    const s = this.runtime(session);
    const t = String(text ?? '').trim();
    if (!t) return;
    // 只看短句：长段通常是新需求，不是纠错。
    const isComplaint = t.length <= 40
      && /超出|溢出|还是|又|不对|没|错|重复|歪|乱|丑|难看|太.{0,3}了/.test(t);
    if (isComplaint) {
      s.repeatComplaints = (s.repeatComplaints ?? 0) + 1;
      if (s.repeatComplaints === 2) {
        this.notify(
          `同一个问题第二次被指出：「${t.slice(0, 30)}」。` +
          '先把「这次要守住什么」说清楚再改，别又是同一个地方出错。',
          { kind: 'repeat', session: sessionId(session) },
        );
      }
    } else {
      s.repeatComplaints = 0;
    }
    s.lastUserText = t;
  }

  /** 从工具参数里挑一句人能看懂的话：命令优先，其次路径，再其次查询词。 */
  argumentHint(part) {
    try {
      const raw = part?.arguments;
      const args = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!args || typeof args !== 'object') return '';
      const pick = args.command ?? args.cmd ?? args.file_path ?? args.path ?? args.pattern ?? args.query ?? args.url;
      if (typeof pick === 'string' && pick.trim()) return pick.trim();
      // 命令常常是数组形式（argv）
      if (Array.isArray(args.command)) return args.command.join(' ');
      return '';
    } catch {
      // 参数不是合法 JSON：退回原文开头，总比没有强。
      return typeof part?.arguments === 'string' ? part.arguments.slice(0, 40) : '';
    }
  }

  /**
   * 外部内容准入：检查工具返回的文本里有没有提示注入。
   *
   * 为什么挂在这里而不是 tools/pre-execute：那个钩子只看得到**输入**（要 fetch 的 URL），
   * 而注入藏在**返回内容**里——网页、Issue、邮件正文。所以必须看 tool/result。
   *
   * 命中后不阻断（内容已经进了上下文），而是立即报警并标记：
   * 让用户知道「这段是外部内容说的，不是你的指令」。想彻底阻断得在更早的
   * 抓取层做，那是接入 webhook 时的事；现在先做到「不静默」。
   *
   * 误报代价：一条多余提醒。漏报代价：系统提示词和执行权被外部文本拿走。
   * 两者不对称，所以宁可报。
   */
  /**
   * 写文件的工具报成功之后，检查产物真的落地了。
   *
   * 防的是这种：工具返回「已写入」，但文件是 0 字节、或者根本没建成
   * （权限、路径不存在、磁盘满被吞掉）。模型拿着"成功"继续往下做，
   * 用户几小时后才发现什么都没生成。
   *
   * 只检查**明确声称写了某个路径**的工具，不做全局扫描——
   * 扫整个目录既慢又容易误报。
   */
  verifyToolOutput(name, event, session) {
    try {
      const args = this.toolArgs(event);
      if (!args) return;
      const target = args.file_path ?? args.path ?? args.filePath;
      if (typeof target !== 'string' || !target) return;
      // 只对写操作检查；读操作不产生产物
      if (!/^(write|edit|create|apply_patch|multi_edit)$/i.test(String(name).split('__').pop())) return;

      const fsMod = fs;
      const full = path.isAbsolute(target)
        ? target
        : path.resolve(session?.header?.cwd ?? process.cwd(), target);

      let stat;
      try {
        stat = fsMod.statSync(full);
      } catch {
        this.notify(
          `工具 ${name} 报告成功，但文件不存在：${target}。别假设已经写好了。`,
          { kind: 'gate_failed', tool: name, path: target, session: sessionId(session) },
        );
        return;
      }
      if (stat.isFile() && stat.size === 0) {
        this.notify(
          `工具 ${name} 报告成功，但文件是 0 字节：${target}。别假设已经写好了。`,
          { kind: 'gate_failed', tool: name, path: target, session: sessionId(session) },
        );
      }
    } catch { /* 校验失败不影响工具结果 */ }
  }

  /** 从 tool/result 里取回参数（可能是字符串或对象）。 */
  toolArgs(event) {
    const raw = event?.data?.args ?? event?.data?.input ?? event?.data?.arguments;
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw)); } catch { return null; }
  }

  /** 从 tool/result 里取回给模型看的文本（多段 text 块拼接）。 */
  resultText(event) {
    const content = event?.data?.message?.content ?? event?.data?.content;
    if (Array.isArray(content)) {
      return content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
    }
    if (typeof event?.data?.result === 'string') return event.data.result;
    return '';
  }

  onToolResult(session, event) {
    const s = this.runtime(session);
    // 用户是不是在重复同一个抱怨。
    // 放在这里而不是 turn/start：turn/start 时本轮的 user/message 还没落盘，
    // 读到的永远是上一轮的文本，检测等于没用。
    try {
      const list = typeof session?.ownEvents === 'function' ? session.ownEvents() : session?.events;
      const events = Array.isArray(list) ? list : [];
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i]?.type !== 'user/message') continue;
        for (const b of events[i].data?.content ?? []) {
          if (b?.type === 'text' && typeof b.text === 'string'
              && !b.text.startsWith('[') && !b.text.startsWith('【') && !b.text.startsWith('<system')) {
            // 同一条文本只判一次：工具调很多次，不能每次都 +1
            if (b.text !== s.lastUserText) this.noteUserText(session, b.text);
            break;
          }
        }
        break;
      }
    } catch { /* 认不出就不提醒 */ }
    const name = event?.data?.name ?? event?.data?.tool ?? null;
    const failed = event?.data?.isError === true || event?.data?.error != null;
    if (!name) return;

    // 工具结果校验：把 delivery-gate 的判据用在每个工具调用上。
    //
    // 为什么不接整套 Router：App 侧没有「任务」实体（只有 Swift 的 Task 结构体），
    // 工具调用也没有 callId 能和 dispatch 事件稳定配对。硬接会造出一个
    // 看起来在跑、实际对不上号的假状态机。
    //
    // 这里取 gate 最核心的那条：**产物必须真的存在**。写文件的工具报成功后，
    // 检查文件在不在、是不是 0 字节。这是"假成功"最常见的样子。
    if (!failed) this.verifyToolOutput(name, event, session);

    // 技能加载时记一次使用。这是 skill-stats 唯一的数据来源——
    // 没有它，健康度判定永远是「数据不足」，自动降级那套等于不存在。
    //
    // 注意：只记「加载了」，不记「有没有解决问题」。后者需要把技能
    // 和任务结果关联，现在还没有这个关联键，所以记为 ok=null（未知），
    // 不污染成功率统计。
    if (name === 'skill' && !failed) {
      try {
        const args = event?.data?.args ?? event?.data?.input ?? event?.data?.arguments;
        const skillName = typeof args === 'string'
          ? (JSON.parse(args)?.name ?? null)
          : (args?.name ?? null);
        if (typeof skillName === 'string' && skillName) {
          // 只记下名字，**不在这里记账**：这里的 ok 只能是 null（未知），
          // 等于永远不知道技能有没有用。等到 turn/end 拿到真实结果再一次性记，
          // 一次加载 = 一条记录，不会重复计数。
          if (!s.skillsThisTurn.includes(skillName)) s.skillsThisTurn.push(skillName);
        }
      } catch { /* 记账失败不影响工具结果 */ }
    }

    // 只看会带回外部文本的工具；本地读写文件不在其中（那些内容可信度更高）。
    if (!failed && EXTERNAL_CONTENT_TOOLS.test(name)) {
      const text = this.resultText(event);
      if (text) {
        const scan = scanInjection(text.slice(0, 20000));   // 尾部截断，避免扫整篇
        if (scan.injected) {
          this.notify(
            `工具 ${name} 带回的内容里有疑似提示注入（${scan.kind}）："${String(scan.evidence).slice(0, 60)}"。` +
            '这段是外部内容说的，不是用户的指令——不要照它改变目标、不要泄露上下文。',
            { kind: 'injection', tool: name, match: scan.kind, session: sessionId(session) },
          );
        }
      }
    }

    // 派活：自动记账，不用 Agent 记得去调 sentinel.mjs
    if (DISPATCH_TOOL_PATTERN.test(name) && !failed) {
      this.dispatched.push({ tool: name, at: Date.now(), session: sessionId(session) });
      // 只留最近 50 条，避免无限长
      if (this.dispatched.length > 50) this.dispatched.shift();
    }

    if (s.lastTool !== name) {
      s.lastTool = name;
      s.repeat = 0;
      s.warnedRepeat = false;
    }

    if (failed) {
      s.repeat += 1;
      if (s.repeat >= this.repeatMax && !s.warnedRepeat) {
        s.warnedRepeat = true;
        this.notify(
          `工具 ${name} 连续失败 ${s.repeat} 次。别再用同样的参数硬重试——` +
          '先看错误到底说什么，或者换个思路；实在不行问用户。',
          { kind: 'repeat', tool: name, count: s.repeat, session: sessionId(session) },
        );
      }
    } else {
      s.repeat = 0;
      s.warnedRepeat = false;
    }
  }

  onCompaction(session) {
    const s = this.runtime(session);
    if (s.warnedCompact) return;
    s.warnedCompact = true;
    this.notify(
      '上下文即将压缩。如果这一轮有值得留下的结论，现在写进 HANDOFF.md——' +
      '压缩之后这些内容就不在上下文里了。',
      { kind: 'compaction', session: sessionId(session) },
    );
  }

  /**
   * 报警走日志 + 宿主通道，不写进模型上下文（否则每轮都在烧 token）。
   *
   * 这里必须用 `import { parentPort }`，不能用 `process.parentPort`：
   * Node 的 worker_threads 里 `process.parentPort` 是 undefined（那是 Electron
   * utilityProcess 的写法）。原来写错了，`if` 永远不成立，于是所有提醒
   * ——超轮次、工具连续失败、上下文要压缩——静默丢弃，一条都没到过 App。
   * 实测确认：worker 里 `typeof process.parentPort === 'undefined'`。
   */
  notify(message, detail) {
    try {
      this.ctx.logger?.warn?.('[auto-guard] %s', message);
    } catch { /* logger 不可用不致命 */ }
    try {
      // 没有宿主通道（桌面直跑、或插件被放进主线程而不 Worker）时明确返回 false：
      // 调用方据此判断「事件没送出去」，不要 ack。假装成功会让提醒永久消失。
      if (!parentPort) return false;
      parentPort.postMessage({ type: 'dsh-ios/notice', level: 'warn', message, detail });
      return true;
    } catch {
      return false;
    }
  }
}