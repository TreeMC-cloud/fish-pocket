// capability-status.mjs —— 把治理层的运行状态汇总成 App 能读的一份快照
//
// 为什么需要：治理层（任务表、Dream、技能记账、中断记录、注入告警）全在引擎里跑，
// 用户一个都看不见。跑得好不好、有没有在跑、最近学到了什么，都是黑箱。
//
// 这个模块只做一件事：把散在各处的状态文件读出来，生成 `capability.json`。
// App 每 3 秒轮询一次（和 notices.jsonl 同一节奏），渲染成「能力面板」。
//
// 设计取舍：
//   1. 只读不写业务数据——它不改任何状态，纯粹是投影。
//   2. 单文件覆盖写（tmp+rename），App 永远读到完整快照。
//   3. 每项都带 `ok` 与 `reason`：拿不到数据时显示「未知」，不显示「正常」。
//      静默失败比失败本身更糟——用户会以为一切正常。

import fs from 'node:fs';
import path from 'node:path';

/** 快照文件名，App 侧按同一名字读。 */
export const STATUS_FILE = 'capability.json';

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const readJsonl = (file) => {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
};

const countLines = (file) => {
  try { return readJsonl(file).length; } catch { return 0; }
};

/**
 * 生成状态快照。
 *
 * @param {string} dataDir  DSH_IOS_DATA
 * @param {object} [opts]   now / traceLimit
 */
export function buildStatus(dataDir, { now = Date.now(), traceLimit = 200 } = {}) {
  const at = (name) => path.join(dataDir, name);

  // ── 任务表 ──
  // 文件名必须和 task-registry.registryPath() 一致：那里是 `tasks.json`（没有前导点），
  // 而这里原来读 `.tasks.json`。两个名字差一个点，结果任务记了但快照永远读不到，
  // 面板一直显示「还没开始干活」——这种「两边各写一份约定」的错已经犯过好几次。
  const tasks = readJson(at('tasks.json'), null);
  const taskStats = (() => {
    if (!tasks || typeof tasks.tasks !== 'object') {
      return { ok: false, reason: '还没有任务记录', total: 0, byStatus: {}, needsAttention: [] };
    }
    const byStatus = {};
    for (const t of Object.values(tasks.tasks)) {
      // 投递型任务（只把消息塞进会话）的 status 恒为 succeeded——
      // 那只说明「投进去了」，真正的成败在那一轮的 turnOutcome 里。
      // 直接按 status 统计会把「投递成功但那一轮失败」算成成功，
      // 面板上的成功率于是虚高，改道规则也失去意义。
      // 按 turnOutcome 归类，还没回来的保持「已投递」。
      let s = t?.status ?? 'unknown';
      if (t?.deliveredOnly === true) {
        s = t.turnOutcome == null ? 'in_flight'
          : (t.turnOutcome === 'completed' ? 'delivered_ok' : 'delivered_failed');
      }
      byStatus[s] = (byStatus[s] ?? 0) + 1;
    }
    // 待人工确认的任务要露出来。
    // 状态机故意不让失败任务自动重跑（有副作用的操作重来可能更糟），
    // 但只统计个数字等于把问题藏起来——用户看不到是哪些、为什么卡住。
    const needsAttention = Object.values(tasks.tasks)
      .filter((t) => t?.status === 'needs_reconciliation')
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 10)
      .map((t) => ({
        taskId: t.taskId ?? null,
        title: String(t.title ?? '').slice(0, 120),
        error: String(t.lastError ?? '').slice(0, 200),
        deferCount: t.deferCount ?? 0,
        updatedAt: t.updatedAt ?? 0,
      }));
    return { ok: true, total: Object.keys(tasks.tasks).length, byStatus, needsAttention };
  })();

  // ── Dream 整理 ──
  const dreamState = readJson(at('.dream-state.json'), null);
  const dreamAudit = readJsonl(at('.dream-audit.jsonl')).slice(-5).reverse();
  const dream = dreamState
    ? {
      ok: true,
      runs: dreamState.runs ?? 0,
      lastRunAt: dreamState.lastRunAt ?? 0,
      produced: dreamAudit.filter((a) => a.event === 'dream').reduce((n, a) => n + (a.produced ?? 0), 0),
      recent: dreamAudit.map((a) => ({ at: a.at, event: a.event, produced: a.produced ?? null })),
    }
    : { ok: false, reason: '还没整理过（攒够 20 条新记录才会触发）', runs: 0 };

  // ── 技能使用 ──
  const skillStats = readJson(at('.skill-stats.json'), null);
  const skills = (() => {
    if (!skillStats || typeof skillStats.skills !== 'object') {
      return { ok: false, reason: '还没有技能使用记录', tracked: 0, weak: [] };
    }
    const rows = Object.entries(skillStats.skills);
    const weak = rows
      .filter(([, s]) => (s.uses ?? 0) >= 5 && (s.failures ?? 0) / Math.max(1, (s.uses ?? 0)) >= 0.4)
      .map(([name]) => name);
    return {
      ok: true,
      tracked: rows.length,
      totalUses: rows.reduce((n, [, s]) => n + (s.uses ?? 0), 0),
      weak,
    };
  })();

  // ── 中断记录 ──
  const inFlight = readJson(at('in-flight.json'), null);
  const running = inFlight?.running && typeof inFlight.running === 'object'
    ? Object.entries(inFlight.running).map(([session, v]) => ({
      session,
      step: typeof v === 'object' ? (v.step ?? '') : '',
      turn: typeof v === 'object' ? (v.turn ?? null) : null,
    }))
    : [];
  const interrupts = { ok: true, running };

  // ── 经验记录 ──
  const traces = readJsonl(at('.trace.jsonl'));
  const okCount = traces.filter((t) => t.ok === true).length;
  const failCount = traces.filter((t) => t.ok === false).length;
  const trace = {
    ok: true,
    total: traces.length,
    successes: okCount,
    failures: failCount,
    unknown: traces.length - okCount - failCount,
    // 最近 200 条里最常出现的话题，给面板显示"最近在忙什么"
    topTags: (() => {
      const freq = new Map();
      for (const t of traces.slice(-traceLimit)) {
        for (const tag of t.tags ?? []) freq.set(tag, (freq.get(tag) ?? 0) + 1);
      }
      return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag, n]) => ({ tag, n }));
    })(),
  };

  // ── 轮次 ──
  const turnLines = readJsonl(at('.turns.jsonl'));
  const turns = {
    ok: true,
    total: turnLines.length,
    lastAt: turnLines.length ? (turnLines[turnLines.length - 1].at ?? 0) : 0,
  };

  // ── 定时任务（只读观察）──
  // 数据由 auto-guard 的调度循环写入 schedule-view.json。
  // 这里**只显示**，不参与任何投递决策——定时任务的执行权归 DSH 自己。
  const scheduleView = readJson(at('schedule-view.json'), null);
  const schedules = scheduleView && Array.isArray(scheduleView.rows)
    ? {
      ok: true,
      total: scheduleView.total ?? scheduleView.rows.length,
      due: scheduleView.rows.filter((r) => r.due === true).length,
      rows: scheduleView.rows.slice(0, 10).map((r) => ({
        title: r.title ?? '',
        status: r.status ?? '',
        scheduledAt: r.scheduledAt ?? null,
        due: r.due === true,
      })),
    }
    : { ok: false, reason: '定时任务还没被读取过', total: 0, due: 0, rows: [] };

  // ── 最近告警 ──
  // notices.jsonl 是引擎到 App 的通道，这里回读最近的经营类事件（注入/中断/交付失败）
  const notices = readJsonl(at('notices.jsonl'));
  const alerts = notices
    .filter((n) => ['injection', 'interrupted', 'gate_failed', 'task_needs_redesign', 'scene_missing']
      .includes(n.kind))
    .slice(-8)
    .reverse()
    .map((n) => ({ at: n.time ?? 0, kind: n.kind, message: String(n.message ?? '').slice(0, 120) }));

  return {
    version: 1,
    generatedAt: now,
    // 一句话总结：面板顶部直接显示，不用用户自己拼。
    // trace / turns 必须传进来：它们才是每轮真的在写的数据源。
    headline: headlineOf({ taskStats, dream, skills, interrupts, alerts, trace, turns, schedules }),
    taskStats,
    dream,
    skills,
    interrupts,
    trace,
    turns,
    schedules,
    alerts,
  };
}

/** 生成一句人话总结。空状态时说清楚"还没开始"，不说"一切正常"。 */
function headlineOf({ taskStats, dream, skills, interrupts, alerts, trace, turns, schedules }) {
  const parts = [];
  if (interrupts.running.length > 0) parts.push(`${interrupts.running.length} 个任务在跑`);
  if (taskStats.ok && taskStats.total > 0) parts.push(`${taskStats.total} 个任务记录`);
  // trace 是**唯一真正每轮都在写**的数据源（auto-guard 在 turn/end 记账）。
  // 原来的 headline 只看 tasks/dream/skills —— 那三张表分别依赖 Router、定时整理
  // 和技能记账，在当前版本都没有接进运行路径，所以无论跑了多少轮对话都显示
  // 「还没开始干活」。真实情况是「早就在干活了，只是没被算进来」。
  if (trace && trace.ok && trace.total > 0) {
    parts.push(`记录 ${trace.total} 轮`);
    if (trace.successes > 0) parts.push(`成功 ${trace.successes}`);
    if (trace.failures > 0) parts.push(`失败 ${trace.failures}`);
  } else if (turns && turns.ok && turns.total > 0) {
    // trace 还没攒起来时，至少有轮次计数可以说明"在干活"。
    parts.push(`跑了 ${turns.total} 轮`);
  }
  if (schedules && schedules.ok && schedules.total > 0) parts.push(`${schedules.total} 个定时任务`);
  if (dream.ok && dream.runs > 0) parts.push(`整理过 ${dream.runs} 次`);
  if (skills.ok && skills.tracked > 0) parts.push(`用过 ${skills.tracked} 个技能`);
  if (alerts.length > 0) parts.push(`${alerts.length} 条告警`);
  if (parts.length === 0) {
    // 空状态要说清「哪些源是空的」。
    // 只说「还没开始干活」的话，用户没法判断是「真的没聊过」还是
    // 「聊了但记账没生效」——而这两个的处理方式完全不同。
    const missing = [];
    if (!taskStats.ok || taskStats.total === 0) missing.push('任务表');
    if (!trace?.ok || trace.total === 0) missing.push('经验记录');
    if (!turns?.ok || turns.total === 0) missing.push('轮次账本');
    return `还没开始干活（${missing.join('、')}均无记录）`;
  }
  return parts.join(' · ');
}

/**
 * 写快照。失败不抛——面板读不到只是不显示，不该影响对话。
 */
export function writeStatus(dataDir, opts = {}) {
  try {
    const status = buildStatus(dataDir, opts);
    const target = path.join(dataDir, STATUS_FILE);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(status), { mode: 0o600 });
    fs.renameSync(tmp, target);
    return status;
  } catch {
    return null;
  }
}
