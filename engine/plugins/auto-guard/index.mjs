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
 * 设计原则：
 *   - 默认只提醒不阻断；只有「明显会搞坏东西」才拒绝（比如内存 <10% 还派子 agent）
 *   - 状态只留内存，不落盘。重启丢失可接受：这些是「这一轮要不要提醒」，
 *     长期记忆归 HANDOFF.md
 *   - 报警不进模型上下文（那等于每轮多付 token，正好违反 cost-guard 自己）
 */

import fs from 'node:fs';
import os from 'node:os';

const DEFAULT_TURNS_MAX = 40;
const DEFAULT_REPEAT_MAX = 3;
/** 内存低于这个比例就不许再派子任务——iOS 上会被系统静默杀掉。 */
const MEMORY_STOP_RATIO = 0.10;
/** 低于这个比例只警告。 */
const MEMORY_WARN_RATIO = 0.20;
/** 这些工具名说明"在派活"，派之前要查负载、派之后要记账。 */
const DISPATCH_TOOL_PATTERN = /^(subagent|wb_submit_task|wb_task_status)$/;

export default class AutoGuard {
  static inject = [];

  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.turnsMax = Number(config.turnsMax ?? process.env.DSH_TURNS_MAX ?? DEFAULT_TURNS_MAX) || DEFAULT_TURNS_MAX;
    this.repeatMax = Number(config.repeatMax ?? DEFAULT_REPEAT_MAX) || DEFAULT_REPEAT_MAX;
    this.state = new WeakMap();
    /** 派单台账：进程内记账，重启清空（持久台账归 sentinel.mjs）。 */
    this.dispatched = [];

    ctx.effect(() => {
      const offs = [
        ctx.on('session/event', (session, event) => {
          if (event?.type === 'turn/start') this.onTurnStart(session, event);
          else if (event?.type === 'tool/result') this.onToolResult(session, event);
          else if (event?.type === 'compaction/start') this.onCompaction(session, event);
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

  onTurnStart(session) {
    const s = this.runtime(session);
    s.turns += 1;

    if (s.turns > this.turnsMax && !s.warnedTurn) {
      s.warnedTurn = true;
      this.notify(
        `会话已 ${s.turns} 轮，超过 ${this.turnsMax} 轮红线。` +
        '该考虑换会话了：先把进度写进 HANDOFF.md（下一步要具体），再开新会话。',
        { kind: 'turns', turns: s.turns },
      );
    }
  }

  onToolResult(session, event) {
    const s = this.runtime(session);
    const name = event?.data?.name ?? event?.data?.tool ?? null;
    const failed = event?.data?.isError === true || event?.data?.error != null;
    if (!name) return;

    // 派活：自动记账，不用 Agent 记得去调 sentinel.mjs
    if (DISPATCH_TOOL_PATTERN.test(name) && !failed) {
      this.dispatched.push({ tool: name, at: Date.now(), session: String(session?.id ?? '') });
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
          { kind: 'repeat', tool: name, count: s.repeat },
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
      { kind: 'compaction' },
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
