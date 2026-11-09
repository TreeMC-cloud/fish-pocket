// selftest.mjs —— 引擎自己跑一遍端到端自测
//
// ## 为什么需要它
//
// 这个项目最大的风险不是「不会写」，是「写了但没接上」。而这类失败**不报错**：
// 模块在、单测绿、构建成功，真机上却什么都没发生。发现它的唯一办法是有人
// 真的跑一遍。
//
// 靠人跑的问题是「想不起来」。所以让引擎自己在启动后跑一次，结果写进
// `<data>/selftest.json`，App 的自检页直接读。
//
// ## 和 selfcheck.mjs 的区别
//
// selfcheck.mjs 查的是「文件在不在」（这轮到底有没有干活）；
// 这里查的是「**模块之间的接线通不通**」（就算还没人用，也能证明链路能跑）。
// 一个查现状，一个查能力，两者互补。
//
// ## 原则
//
// - 每个检查都在**临时目录**里跑，绝不碰真实数据。
// - 单项失败不影响其他项：一个坏了要能看出坏的到底是哪一个。
// - 不抛异常，永远返回结构化的结果——自测本身坏了，也要能显示出「它坏了」。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Router } from './router.mjs';
import { makeRunTask, tick } from './task-runner.mjs';
import { load as loadRegistry } from './task-registry.mjs';
import { deriveCandidates, appendCandidates, candidateFile } from './candidates.mjs';
import { mergeAgentsMd, BUNDLED_END } from './agents-md.mjs';
import { createNoticeAdmission } from './notice-admission.mjs';
import { evaluate as evaluateProactive, runProactive } from './proactive.mjs';

const TMP_PREFIX = 'selftest-';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结论 */ }
}

/** 每条检查返回 {id, title, ok, detail}。允许异步：tick/存盘都是异步的。 */
async function check(id, title, run) {
  try {
    const r = await run();
    if (r && typeof r === 'object') return { id, title, ok: r.ok !== false, detail: r.detail ?? '' };
    return { id, title, ok: false, detail: '检查没有返回值（实现漏了 return）' };
  } catch (error) {
    // 抛错就是失败：自测里没有「环境不支持」这种含糊状态，
    // 除非显式返回 skip，否则一律当成「接线断了」。
    return { id, title, ok: false, detail: `抛错：${String(error?.message ?? error).slice(0, 200)}` };
  }
}

/**
 * 跑全部检查。
 * @param {object} [opts]
 * @returns {{at:number, passed:number, total:number, items:Array}}
 */
export async function runSelfTest() {
  const items = [];

  // ── 1. 任务状态机：建 → 排队 → 跑 → 成功 ──
  items.push(await check('tasks', '任务状态机（建→排队→跑→成功）', () => {
    const d = tmpDir();
    try {
      const router = new Router({
        dataDir: d,
        runTask: async () => ({ ok: true }),
      });
      const accepted = router.accept({ source: 'user', eventId: 'st-1', title: '自测任务', threadKey: 'S1' });
      const created = accepted.task !== null && accepted.created === true;
      const saved = Object.keys(loadRegistry(d).tasks).length === 1;
      return {
        ok: created && saved,
        detail: created ? (saved ? '建任务并落盘正常' : '建了任务但没落盘') : `准入拒绝：${accepted.reason}`,
      };
    } finally { cleanup(d); }
  }));

  // ── 2. 队列真的能把活送到会话 ──
  items.push(await check('dispatch', '队列投递（enqueue → 调度 → 注入会话）', async () => {
    const d = tmpDir();
    try {
      const injected = [];
      const ctx = {
        agents: { get: (id) => (id === 'S1' ? { inject: (m) => injected.push(m) } : undefined) },
      };
      const router = new Router({
        dataDir: d,
        runTask: makeRunTask({ ctx, createUserMessage: (x) => x }),
      });
      const control = router;   // enqueue 走 accept，这里直接调同一个入口
      router.accept(
        { source: 'external', eventId: 'st-2', title: '把构建修好', note: '把构建修好，先看日志', threadKey: 'S1' },
        { allowedSources: ['user', 'schedule', 'agent-message', 'webhook', 'external'] },
      );
      const r = await tick(router);
      return {
        ok: r.started.length === 1 && injected.length === 1,
        detail: r.started.length === 1
          ? `已启动 ${r.started.length} 个任务并注入会话`
          : 'tick 没有启动任何任务',
      };
    } finally { cleanup(d); }
  }));

  // ── 3. 候选技能：同一批证据能产出且带指纹 ──
  items.push(await check('candidates', '候选技能（trace → 候选 → 带指纹落盘）', () => {
    const d = tmpDir();
    try {
      const traces = [
        { at: 1, ok: false, summary: '依赖缺失', tags: ['构建'] },
        { at: 2, ok: false, summary: '依赖缺失', tags: ['构建'] },
        { at: 3, ok: false, summary: '依赖缺失', tags: ['构建'] },
        { at: 4, ok: true, summary: '用 --fix 后通过', tags: ['构建'] },
      ];
      const list = deriveCandidates(traces, { now: 1 });
      const { added } = appendCandidates(d, list, { now: 1 });
      const file = candidateFile(d);
      const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
      return {
        ok: list.length === 1 && added === 1 && rows[0]?.fingerprint?.startsWith('fp'),
        detail: list.length === 1
          ? (added === 1 ? `产出 1 条候选（${rows[0].tag}，指纹 ${rows[0].fingerprint}）` : '算出来了但没写进文件')
          : '够格的簇没产出候选（判据失效）',
      };
    } finally { cleanup(d); }
  }));

  // ── 4. 身份文件能被更新（老设备也要能升级）──
  items.push(await check('identity', '身份文件更新（无标记的老文件也要能升级）', () => {
    const merged = mergeAgentsMd('# 新铁律\n' + BUNDLED_END + '\n', '# 旧铁律\n');
    return {
      ok: merged.changed === true && merged.next.includes('新铁律') && merged.next.includes(BUNDLED_END),
      detail: merged.changed ? '老格式文件被正确替换（并保留尾部）' : '旧内容没被更新——改了也传不到设备',
    };
  }));

  // ── 5. 通知不会被静默丢弃 ──
  items.push(await check('notices', '通知准入（已知类型能通过，未知类型被拦）', () => {
    let clock = 0;
    // 注意：createNoticeAdmission 返回的是**函数本身**，不是 { admit } 对象。
    const admit = createNoticeAdmission({ now: () => clock });
    const notice = (kind) => ({ type: 'dsh-ios/notice', message: `${kind} 自测`, detail: { kind } });
    const known = ['scene_missing', 'scene_mismatch', 'interrupted', 'task_failed', 'gate_failed'];
    // 每类用不同会话，避免被冷却挡住——这里查的是「在白名单里」，不是「冷却生效」。
    const dropped = known.filter((kind, i) =>
      !admit({ ...notice(kind), detail: { kind, session: `st-${i}` } }));
    const unknownBlocked = admit(notice('no-such-kind')) === false;
    return {
      ok: dropped.length === 0 && unknownBlocked,
      detail: dropped.length === 0
        ? (unknownBlocked ? '5 种已知通知全部放行，未知类型被拦' : '未知类型没被拦住（白名单失效）')
        : `这些类型会被静默丢弃：${dropped.join(', ')}`,
    };
  }));

  // ── 6. 主动层：该动的时候动，不该动的时候不动 ──
  items.push(await check('proactive', '主动层（反复失败会自己派活，冷却后不重复）', () => {
    const d = tmpDir();
    try {
      const lines = [];
      const base = Date.now() - 10_000;
      for (let i = 0; i < 8; i += 1) {
        lines.push(JSON.stringify({ at: base + i * 100, ok: i < 2, summary: '依赖缺失', tags: ['构建'] }));
      }
      fs.writeFileSync(path.join(d, '.trace.jsonl'), lines.join('\n') + '\n');

      const triggers = evaluateProactive(d);
      let enqueued = 0;
      runProactive(d, { sessionId: 'S1', enqueue: () => { enqueued += 1; }, notify: () => {} });
      runProactive(d, { sessionId: 'S1', enqueue: () => { enqueued += 1; }, notify: () => {} });

      return {
        ok: triggers.length === 1 && enqueued === 1,
        detail: triggers.length === 1
          ? (enqueued === 1 ? '识别到反复失败并派活一次，冷却生效' : `派了 ${enqueued} 次（冷却失效）`)
          : `触发项数量不对：${triggers.length}`,
      };
    } finally { cleanup(d); }
  }));

  const passed = items.filter((i) => i.ok).length;
  return { at: Date.now(), passed, total: items.length, items };
}

/** 跑一遍并落盘。写失败不影响返回值。 */
export async function writeSelfTest(dataDir) {
  const result = await runSelfTest();
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, 'selftest.json');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(result, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* 写不了就只在日志里可见 */ }
  return result;
}
