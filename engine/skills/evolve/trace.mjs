#!/usr/bin/env node
/**
 * trace.mjs —— 进化的另一半：把「这轮干了什么」记下来，再从里面提炼出技能。
 *
 * 为什么需要它：auto-guard 的轮次记账只回答「烧了多少」，不回答「学到了什么」。
 * 没有后者，这个 agent 干一年还是第一天那个 agent——踩过的坑不沉淀，
 * 下次遇到同样的坑照踩。这一层就是让它「越用越顺手」的地方。
 *
 * 三个子命令：
 *   record   记一条 trace（插件在 turn/end 自动调，也可手动补记）
 *   distill  扫描 trace，把重复出现的「坑 + 解法」提炼成候选技能
 *   list     看已有 trace / 候选技能
 *
 * 设计上有意保守：
 * - 只记「有结论」的轮次（ok 明确），模糊的轮次不进库，免得把噪声当经验。
 * - 提炼出的技能一律 verified=false，只在 list 里展示，不自动激活。
 *   理由见 memory-system-proposal.md：记错比记不住糟糕得多。
 *
 * 退出码：0 成功 / 1 发现问题 / 2 用法错误
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  deriveCandidates, appendCandidates, fingerprintOf,
  MIN_SAMPLES, MIN_FAIL_RATIO, WINDOW,
} from '../../runtime/candidates.mjs';

// 候选文件的路径、指纹算法、够格判据都在 runtime/candidates.mjs 里，
// 这边只做 CLI 外壳。此前这两份是各写一份，Dream 自动整理时
// 算的是一套、手动 distill 算的是另一套，一旦分叉就静默失效。
export { fingerprintOf };

const DATA = process.env.DSH_IOS_DATA || process.cwd();
const TRACE_FILE = process.env.DSH_TRACE_FILE || path.join(DATA, '.trace.jsonl');
const CAND_FILE = process.env.DSH_CANDIDATES_FILE || path.join(DATA, '.skill-candidates.jsonl');

/** 一条 trace 最多留多少字的问题摘要——太长就退化成日志，没人读得下。 */
const MAX_SUMMARY = 300;

function now() { return Date.now(); }

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 坏行跳过，不因一行烂掉整库 */ }
  }
  return out;
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', { mode: 0o600 });
}

function clip(s, n = MAX_SUMMARY) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
}

// ── record ────────────────────────────────────────────────────────────

function cmdRecord(argv) {
  const get = (k) => {
    const i = argv.indexOf('--' + k);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const summary = get('summary');
  if (!summary) {
    console.error('用法: trace.mjs record --summary "这轮做了什么" [--ok 1|0] [--kind 类型] [--tags a,b]');
    return 2;
  }

  const rawOk = get('ok');
  const ok = rawOk === undefined ? null : rawOk === '1' || rawOk === 'true';
  const tags = (get('tags') || '').split(',').map((s) => s.trim()).filter(Boolean);

  appendJsonl(TRACE_FILE, {
    at: now(),
    kind: get('kind') || 'task',
    ok,
    summary: clip(summary),
    tags,
    source: get('source') || 'manual',
  });

  console.log('✓ 已记一条 trace');
  return 0;
}

// ── distill ───────────────────────────────────────────────────────────

/**
 * 把 trace 聚成候选技能。
 *
 * 判据（宁少勿滥）：
 * - 同一 tag 至少出现 MIN_SAMPLES 次
 * - 其中失败占比 ≥ MIN_FAIL_RATIO 才有「坑」的味道（全成功的流水账不值得成技能）
 * - 只取最近 WINDOW 条，老经验可能已经过时
 *
 * 提炼出来的只是「候选」，verified 一律 false。要不要变成真技能，得有人（或
 * 之后一轮自审）看过、确认它对，再来改 flag。这是故意的减速带。
 */

function cmdDistill(argv) {
  const dryRun = argv.includes('--dry-run');
  const traces = readJsonl(TRACE_FILE).slice(-WINDOW);

  if (traces.length < MIN_SAMPLES) {
    console.log(`trace 只有 ${traces.length} 条，还不够提炼（至少 ${MIN_SAMPLES} 条）。`);
    console.log('继续干活，或者手动补记：trace.mjs record --summary "..." --ok 1 --tags xxx');
    return 0;
  }

  // 聚类与判据都在 candidates.mjs：Dream 自动整理调的是同一份，
  // 两处口径分叉正是这个项目反复踩的坑。
  const candidates = deriveCandidates(traces, { now: now() });

  if (candidates.length === 0) {
    console.log(`扫了 ${traces.length} 条 trace，没有够格提炼的话题。`);
    console.log(`判据：同一 tag ≥${MIN_SAMPLES} 次、失败占比 ≥${MIN_FAIL_RATIO * 100}%、且有成功样本。`);
    return 0;
  }

  if (dryRun) {
    console.log(`[dry-run] 会产出 ${candidates.length} 条候选，不写文件：`);
    for (const c of candidates) console.log(`  · ${c.tag} (${c.samples} 次 / 失败 ${c.fails})`);
    return 0;
  }

  const { added, skipped } = appendCandidates(DATA, candidates, { now: now() });
  console.log(`✓ 产出 ${added} 条候选技能（共 ${candidates.length} 条够格，${skipped} 条已存在）`);
  console.log('注意：候选的 verified 都是 false，看过确认后再手动置 true 才会被当成真技能。');
  return 0;
}


// ── list ──────────────────────────────────────────────────────────────

function cmdList(argv) {
  const what = argv.find((a) => !a.startsWith('-')) || 'trace';
  const rows = readJsonl(what === 'candidates' ? CAND_FILE : TRACE_FILE);

  if (rows.length === 0) {
    console.log(what === 'candidates' ? '还没有候选技能。先跑 trace.mjs distill。' : '还没有 trace。');
    return 0;
  }

  const recent = rows.slice(-20);
  console.log(`${what} 共 ${rows.length} 条，最近 ${recent.length} 条：`);
  for (const r of recent) {
    const when = new Date(r.at).toISOString().slice(5, 16).replace('T', ' ');
    if (what === 'candidates') {
      const mark = r.verified ? '✓' : '○';
      console.log(`  ${mark} [${when}] ${r.tag} — ${r.samples} 次/失败 ${r.fails}`);
    } else {
      const mark = r.ok === false ? '✗' : r.ok === true ? '✓' : '·';
      const tags = (r.tags ?? []).length ? ` #${(r.tags ?? []).join(' #')}` : '';
      console.log(`  ${mark} [${when}] ${clip(r.summary, 90)}${tags}`);
    }
  }
  const verified = rows.filter((r) => r.verified).length;
  if (what === 'candidates') console.log(`其中已确认可用：${verified} 条`);
  return 0;
}

// ── 入口 ──────────────────────────────────────────────────────────────
//
// 只有直接运行时才解析参数并退出。被 import 时（测试、插件）必须什么都不做——
// 否则 `process.exit(2)` 会让导入方整个进程退出，看起来像断言失败。
// load-gate.mjs 踩过同一个坑，这是第二处。
const invokedDirectly = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const [, , cmd, ...rest] = process.argv;
  const table = { record: cmdRecord, distill: cmdDistill, list: cmdList };
  if (!table[cmd]) {
    console.error('用法: trace.mjs <record|distill|list> [参数]');
    process.exit(2);
  }
  process.exit(table[cmd](rest));
}
