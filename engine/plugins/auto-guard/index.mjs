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
import { writeInFlight, describeStep } from '../../runtime/flight-recorder.mjs';

const DEFAULT_TURNS_MAX = 40;
const DEFAULT_REPEAT_MAX = 3;
/** 内存低于这个比例就不许再派子任务——iOS 上会被系统静默杀掉。 */
const MEMORY_STOP_RATIO = 0.10;
/** 低于这个比例只警告。 */
const MEMORY_WARN_RATIO = 0.20;
/** 这些工具名说明"在派活"，派之前要查负载、派之后要记账。 */
const DISPATCH_TOOL_PATTERN = /^(subagent|wb_submit_task|wb_task_status)$/;

function sessionId(session) {
  return String(session?.header?.id ?? session?.id ?? 'unknown');
}

/** 追加一行 JSON。写失败不抛 —— 记账是副产物，坏了不该影响对话。 */
function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
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

      // 工具调用前：拦截「内存吃紧还派子任务」这种会拖垮 App 的操作。
      // 用 ctx.on 注册管线事件，没有就静默跳过（不同版本可能没有这个事件）。
      if (typeof ctx.on === 'function') {
        try {
          ctx.on('tools/pre-execute', (call, next) => {
            const name = call?.name ?? call?.tool;
            if (!name || !DISPATCH_TOOL_PATTERN.test(name)) return next?.(call);
            const mem = this.memoryPressure();
            if (mem && mem.ratio < MEMORY_STOP_RATIO) {
              // 拒绝：给出可行动的理由，不是干巴巴的 "denied"
              return `内存只剩 ${(mem.ratio * 100).toFixed(0)}%（${mem.freeMB}MB/${mem.totalMB}MB），` +
                     `再派任务会被 iOS 静默杀掉（表现为 App 突然回到桌面）。` +
                     `先等现有任务结束，或者改用更小的任务。`;
            }
            return next?.(call);
          });
        } catch {
          // 管线事件不存在：只保留会话事件那一套，功能降级但不崩。
        }
      }

      return () => offs.forEach((off) => off?.());
    }, 'auto-guard: session event hooks');
  }

  runtime(session) {
    let s = this.state.get(session);
    if (!s) {
      s = { turns: 0, warnedTurn: false, warnedCompact: false,
            lastTool: null, repeat: 0, warnedRepeat: false, warnedMem: false };
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
      const avail = get('MemAvailable') ?? get('MemFree');
      if (!total || avail === null) return null;
      return {
        totalMB: Math.round(total / 1024),
        freeMB: Math.round(avail / 1024),
        ratio: avail / total,
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

  onTurnStart(session) {
    const s = this.runtime(session);
    s.turns += 1;

    // 飞行记录：这一轮开始跑了。崩溃时这个条目会留在 in-flight.json 里。
    this.inFlight.set(sessionId(session), { at: Date.now(), step: '' });
    this.persistInFlight();

    // 落盘记一笔 —— 这是 cost-guard 那条闭环的开关。
    //
    // 之前的窟窿：轮次只记在内存里（this.state 是 WeakMap），进程重启清零，
    // 而 skills/cost-guard/turns.mjs 读的是 .turns.jsonl —— 那个文件从来没人写。
    // 结果就是 `turns.mjs status` 永远显示 0 轮，40 轮红线永不触发，
    // 「该换会话了」这句提醒等于不存在。
    // 现在每轮往同一个文件追加一行，两边用同一份事实。
    this.recordTurn(session, s.turns);

    if (s.turns > this.turnsMax && !s.warnedTurn) {
      s.warnedTurn = true;
      this.notify(
        `会话已 ${s.turns} 轮，超过 ${this.turnsMax} 轮红线。` +
        '该考虑换会话了：先把进度写进 HANDOFF.md（下一步要具体），再开新会话。',
        { kind: 'turns', turns: s.turns, session: sessionId(session) },
      );
    }
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

      const events = typeof session?.ownEvents === 'function' ? session.ownEvents() : session?.events;
      const list = Array.isArray(events) ? events : [];

      // 从本轮起点往回找摘要材料。只取有内容的文本块，跳过工具参数之类。
      const tools = [];
      let userText = '';
      let assistantText = '';
      for (const e of list) {
        if (e?.type === 'tool/ptc-dispatch' && typeof e.data?.name === 'string') {
          if (!tools.includes(e.data.name)) tools.push(e.data.name);
        } else if (e?.type === 'user/message') {
          for (const b of e.data?.content ?? []) {
            if (b?.type === 'text' && typeof b.text === 'string' && !b.text.startsWith('[')) {
              userText = b.text;   // 取最后一条用户消息
            }
          }
        } else if (e?.type === 'assistant/message') {
          for (const b of e.data?.content ?? []) {
            if (b?.type === 'text' && typeof b.text === 'string') {
              assistantText = assistantText ? assistantText + ' ' + b.text : b.text;
            }
          }
        }
      }

      const summary = assistantText || userText;
      if (!summary) return;   // 空轮次没必要记

      appendJsonl(this.traceFile(), {
        at: Date.now(),
        kind: 'task',
        ok: reason === 'error' ? false : true,
        summary: summary.replace(/\s+/g, ' ').trim().slice(0, 300),
        // 用话题标签而不是工具名：见 TOPIC_RULES 的注释。
        tags: topicsOf(summary + ' ' + userText),
        tools: tools.slice(0, 6),
        source: 'auto-guard',
      });

      s.traceWritten = true;
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

  onToolResult(session, event) {
    const s = this.runtime(session);
    const name = event?.data?.name ?? event?.data?.tool ?? null;
    const failed = event?.data?.isError === true || event?.data?.error != null;
    if (!name) return;

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

  /** 报警走日志 + 宿主通道，不写进模型上下文（否则每轮都在烧 token）。 */
  notify(message, detail) {
    try {
      this.ctx.logger?.warn?.('[auto-guard] %s', message);
    } catch { /* logger 不可用不致命 */ }
    try {
      if (typeof process !== 'undefined' && process.parentPort) {
        process.parentPort.postMessage({ type: 'dsh-ios/notice', level: 'warn', message, detail });
      }
    } catch { /* 桌面跑时没有 parentPort */ }
  }
}