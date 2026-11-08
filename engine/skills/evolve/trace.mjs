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
const MIN_SAMPLES = 3;
const MIN_FAIL_RATIO = 0.3;
const WINDOW = 300;

function cmdDistill(argv) {
  const dryRun = argv.includes('--dry-run');
  const traces = readJsonl(TRACE_FILE).slice(-WINDOW);

  if (traces.length < MIN_SAMPLES) {
    console.log(`trace 只有 ${traces.length} 条，还不够提炼（至少 ${MIN_SAMPLES} 条）。`);
    console.log('继续干活，或者手动补记：trace.mjs record --summary "..." --ok 1 --tags xxx');
    return 0;
  }

  // 按 tag 聚合：一个 tag 就是一个「话题」，成功的和失败的分开数。
  const groups = new Map();
  for (const t of traces) {
    for (const tag of t.tags ?? []) {
      const g = groups.get(tag) ?? { tag, total: 0, fails: 0, okSamples: [], failSamples: [] };
      g.total += 1;
      if (t.ok === false) {
        g.fails += 1;
        if (g.failSamples.length < 3) g.failSamples.push(t.summary);
      } else if (t.ok === true) {
        if (g.okSamples.length < 3) g.okSamples.push(t.summary);
      }
      groups.set(tag, g);
    }
  }

  const candidates = [];
  for (const g of groups.values()) {
    if (g.total < MIN_SAMPLES) continue;
    const ratio = g.fails / g.total;
    if (ratio < MIN_FAIL_RATIO) continue;      // 一路顺利的话题不需要技能
    if (g.okSamples.length === 0) continue;    // 从没成功过 = 还没解法，别急着固化成技能
    candidates.push({
      at: now(),
      tag: g.tag,
      samples: g.total,
      fails: g.fails,
      failRatio: Number(ratio.toFixed(2)),
      /** 坑 */
      problem: clip(g.failSamples[0] ?? '', 200),
      /** 现有解法 */
      practice: clip(g.okSamples[0] ?? '', 200),
      verified: false,
    });
  }

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

  const existing = new Set(readJsonl(CAND_FILE).map((c) => c.tag));
  let added = 0;
  for (const c of candidates) {
    if (existing.has(c.tag)) continue;   // 同一个 tag 不重复产出
    appendJsonl(CAND_FILE, c);
    added += 1;
  }
  console.log(`✓ 产出 ${added} 条候选技能（共 ${candidates.length} 条够格，其余已存在）`);
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

const [, , cmd, ...rest] = process.argv;
const table = { record: cmdRecord, distill: cmdDistill, list: cmdList };
if (!table[cmd]) {
  console.error('用法: trace.mjs <record|distill|list> [参数]');
  process.exit(2);
}
process.exit(table[cmd](rest));
