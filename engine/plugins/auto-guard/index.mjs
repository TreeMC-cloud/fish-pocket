/**
 * 自动守卫 —— 把「靠自觉」的规矩变成「引擎每轮自动跑」。
 *
 * 背景：项目里已经有一批检查工具（load/turns/sentinel/handoff/selfaudit），
 * 但它们是 CLI，要 Agent 想起来才调。忘了调 = 等于不存在。
 * 一位实践者说过：「你把它变成一个命令之后，它就是一个程序了」——
 * 这个插件就是那一步：挂到 DSH 的会话事件上，引擎自己在合适的时刻跑检查。
 *
 * 挂的三个钩子：
 *   turn/start   → 记一轮（等价于 turns.mjs tick），超线时往日志和上下文里报警
 *   tool/call    → 如果连续调同一个工具失败多次，提示别硬重试
 *   compaction/start → 上下文要压缩了，提醒写交接（这是换会话前最后的窗口）
 *
 * 设计原则：
 *   1. 只报警不阻断。引擎是用户干活的地方，插件不该让 Agent 卡住——
 *      「挡住」由 preflight 这种显式闸门负责。
 *   2. 报警写进 logger 和宿主通道，不塞进模型上下文（否则每轮都在烧 token，
 *      正好违反 cost-guard 自己的规矩）。
 *   3. 状态只留内存，不落盘。重启丢失可接受：这些是「这一轮要不要提醒」，
 *      不是长期记忆；长期记忆归 handoff 的 HANDOFF.md。
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TURNS_MAX = 40;
const DEFAULT_REPEAT_MAX = 3;

export default class AutoGuard {
  // sessionProjections 用来读会话状态；agents 用来列活跃 agent。
  // 两个都拿不到也不致命——降级成只记轮次。
  static inject = [];

  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.turnsMax = Number(config.turnsMax ?? process.env.DSH_TURNS_MAX ?? DEFAULT_TURNS_MAX) || DEFAULT_TURNS_MAX;
    this.repeatMax = Number(config.repeatMax ?? DEFAULT_REPEAT_MAX) || DEFAULT_REPEAT_MAX;

    // 每个会话一份运行时状态。用 WeakMap 而不是 Map：
    // 会话结束对象被回收，状态自然消失，不用手动清理也不会泄漏。
    this.state = new WeakMap();

    ctx.effect(() => {
      const offTurnStart = ctx.on('session/event', (session, event) => {
        if (event?.type !== 'turn/start') return;
        this.onTurnStart(session, event);
      });

      const offToolResult = ctx.on('session/event', (session, event) => {
        if (event?.type !== 'tool/result') return;
        this.onToolResult(session, event);
      });

      const offCompact = ctx.on('session/event', (session, event) => {
        if (event?.type !== 'compaction/start') return;
        this.onCompaction(session, event);
      });

      return () => {
        // effect 的清理：插件卸载/重载时解绑，否则同一事件会被多次处理，
        // 表现为轮次翻倍、重复报警。
        offTurnStart?.();
        offToolResult?.();
        offCompact?.();
      };
    }, 'auto-guard: session event hooks');
  }

  /** 该会话的运行时状态，第一次访问时建。 */
  runtime(session) {
    let s = this.state.get(session);
    if (!s) {
      s = {
        turns: 0,
        warnedTurn: false,
        warnedCompact: false,
        lastTool: null,
        repeat: 0,
        warnedRepeat: false,
      };
      this.state.set(session, s);
    }
    return s;
  }

  onTurnStart(session, event) {
    const s = this.runtime(session);
    s.turns += 1;

    // 只在跨过红线的那一次报警，不是每次超线都喊——
    // 每轮都警告会变成噪音，人就开始无视它了。
    if (s.turns > this.turnsMax && !s.warnedTurn) {
      s.warnedTurn = true;
      this.notify(
        `会话已 ${s.turns} 轮，超过 ${this.turnsMax} 轮红线。` +
        '该考虑换会话了：先把进度写进 HANDOFF.md（下一步要具体），' +
        '再跑 preflight.sh 确认交接合格，然后开新会话。',
        { kind: 'turns', turns: s.turns, max: this.turnsMax },
      );
    }
  }

  onToolResult(session, event) {
    const s = this.runtime(session);
    const name = event?.data?.name ?? event?.data?.tool ?? null;
    const failed = event?.data?.isError === true || event?.data?.error != null;

    if (!name) return;

    // 第一次遇到某个工具时把 lastTool 设成它，repeat 记 0（这次失败本身算第 1 次）。
    // 不这么做的话，首次失败因为 lastTool 是 null 走不到计数分支，
    // 实际要等第 3 次失败才报警——与 repeatMax 的语义差一。
    if (s.lastTool !== name) {
      s.lastTool = name;
      s.repeat = failed ? 0 : 0;
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
      // 成功一次就清零。
      // warnedRepeat 也必须跟着清：否则同一工具第二轮失败时不再提醒，
      // 而"失败→修好→又坏"恰恰是最该提醒一次的情况。
      s.repeat = 0;
      s.warnedRepeat = false;
    }
  }

  onCompaction(session) {
    const s = this.runtime(session);
    if (s.warnedCompact) return;
    s.warnedCompact = true;

    // 压缩是要换会话前的最后窗口。压缩之后旧内容就没了，
    // 这时候如果交接还没写，进度就真丢了。
    this.notify(
      '上下文即将压缩。如果这一轮有值得留下的结论，现在写进 HANDOFF.md——' +
      '压缩之后这些内容就不在上下文里了。',
      { kind: 'compaction', turns: s.turns },
    );
  }

  /**
   * 报警走 logger 和宿主通道，不写进模型上下文。
   *
   * 为什么不塞进上下文：那等于每轮多付一段 token，而 cost-guard 自己的
   * 规矩就是"别让固定开销每轮都在烧"。人该看到警告，模型不需要。
   */
  notify(message, detail) {
    try {
      this.ctx.logger?.warn?.('[auto-guard] %s', message);
    } catch {
      // logger 不可用不致命，下面还有宿主通道。
    }
    try {
      // ios-host 插件用 parentPort 给 main.mjs 发消息，这里复用同一条通道。
      if (typeof process !== 'undefined' && process.parentPort) {
        process.parentPort.postMessage({ type: 'dsh-ios/notice', level: 'warn', message, detail });
      }
    } catch {
      // 不在 worker 里（桌面跑）时没有 parentPort，忽略。
    }

    // 写一个提醒文件，App 侧轮询到就弹出来。
    // 为什么不用 parentPort 一条通道走到底：main.mjs 跑在 Node 线程里，
    // 它没法直接调 SwiftUI 的 showToast。文件是两边都能碰的地方，
    // 而且引擎重启后残留的提醒也能被读到，不会丢。
    try {
      const dir = process.env.DSH_IOS_DATA;
      if (dir) {
        const file = path.join(dir, 'notices.jsonl');
        const line = JSON.stringify({ at: new Date().toISOString(), level: 'warn', message, detail }) + '\n';
        fs.appendFileSync(file, line, 'utf8');
      }
    } catch {
      // 写不进去不影响主流程：日志里已经有这条了。
    }
  }
}
