// candidates.mjs —— 候选技能的单一来源
//
// ## 为什么要有这个模块
//
// 候选技能这条链原先散在两个地方：
//   · `skills/evolve/trace.mjs` 的 distill 子命令（手动跑）算候选、写文件
//   · `runtime/dream.mjs` 的自动整理只把经验写进记忆库，**不产出候选**
//
// 结果是夹了一刀：Dream 明明已经在聚类提炼了，产物却只能到记忆库；
// 用户想看候选还得记得手动跑 distill。而两个地方各写一份「怎么算够格」
// 正是这个项目反复踩的坑——两处口径一旦分叉就静默失效，谁也不报错。
//
// 所以这里把三件事收拢成一份：
//   1. 候选文件在哪（含 DSH_CANDIDATES_FILE 覆盖）
//   2. 指纹怎么算（同一批证据必须算出同一个指纹，否则会反复堆同一条）
//   3. 哪些簇够格变成候选
//
// `trace.mjs`（手动 CLI）和 `dream.mjs`（自动整理）都调这里，
// 想改判据只改一处。

import fs from 'node:fs';
import path from 'node:path';

/** 一条 trace 最多留多少字的问题摘要——太长就退化成日志，没人读得下。 */
const MAX_SUMMARY = 300;

/** 候选的默认门槛。与 trace.mjs 的手动 distill 完全一致。 */
export const MIN_SAMPLES = 3;
export const MIN_FAIL_RATIO = 0.3;
/** 只看最近多少条 trace：无上限会让老经验永远压着新经验。 */
export const WINDOW = 300;

export function candidateFile(dataDir) {
  return process.env.DSH_CANDIDATES_FILE || path.join(dataDir, '.skill-candidates.jsonl');
}

function clip(s, n = MAX_SUMMARY) {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 候选的稳定指纹：话题 + 归一化后的失败描述。
 *
 * 归一化只做「去标点、去空白、小写」——不能更聪明（比如取关键词），
 * 因为那会让不同的坑算出同一指纹，反而把新问题挡掉。
 * 目标是「同一次证据重跑得到同一个指纹」，不是「语义相似也算同一条」。
 */
export function fingerprintOf(candidate) {
  const normalize = (s) => String(s ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 120);
  const raw = `${candidate.tag ?? ''}|${normalize(candidate.problem)}`;
  // 短哈希足够：候选表是小文件，不需要抗碰撞；但要稳定（不依赖时间/随机）。
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fp${hash.toString(16).padStart(8, '0')}`;
}

/**
 * 从 trace 里算出够格的候选。
 *
 * 判据（三条缺一不可）：
 *   · 同一话题 ≥3 次           —— 一次性的偶发不算经验
 *   · 失败占比 ≥30%            —— 一路顺利的话题不需要额外技能
 *   · 至少有一条成功样本        —— 从没成功过 = 还没找到解法，别急着固化
 *
 * 第三条比第二条重要：失败多只说明难，有成功才说明有办法。
 */
export function deriveCandidates(traces, {
  minSamples = MIN_SAMPLES,
  minFailRatio = MIN_FAIL_RATIO,
  now = Date.now(),
} = {}) {
  const groups = new Map();
  for (const t of traces ?? []) {
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

  const out = [];
  for (const g of groups.values()) {
    if (g.total < minSamples) continue;
    const ratio = g.fails / g.total;
    if (ratio < minFailRatio) continue;
    if (g.okSamples.length === 0) continue;
    out.push({
      at: now,
      tag: g.tag,
      samples: g.total,
      fails: g.fails,
      failRatio: Number(ratio.toFixed(2)),
      problem: clip(g.failSamples[0] ?? '', 200),
      practice: clip(g.okSamples[0] ?? '', 200),
      verified: false,
      source: 'trace',
    });
  }
  return out;
}

/**
 * 追加候选，按「话题 + 指纹」双键去重。
 *
 * 只用 tag 去重不够：同一个话题在不同阶段会踩不同的坑，按 tag 挡掉会漏新问题；
 * 而不挡又会把同一件事反复堆进候选表。
 *
 * @returns {{added:number, skipped:number}}
 */
export function appendCandidates(dataDir, candidates, { now = Date.now() } = {}) {
  const file = candidateFile(dataDir);
  const existing = new Set(
    readJsonl(file).flatMap((c) => (c.fingerprint ? [c.tag, c.fingerprint] : [c.tag])),
  );
  let added = 0;
  let skipped = 0;
  const lines = [];
  for (const c of candidates ?? []) {
    const candidate = { at: c.at ?? now, ...c };
    candidate.fingerprint = fingerprintOf(candidate);
    if (existing.has(candidate.tag) || existing.has(candidate.fingerprint)) {
      skipped += 1;
      continue;
    }
    lines.push(JSON.stringify(candidate));
    existing.add(candidate.fingerprint);
    added += 1;
  }
  if (lines.length > 0) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
    } catch {
      // 写不了就当没产出：调用方看 added 决定要不要记一笔
      return { added: 0, skipped: skipped + lines.length };
    }
  }
  return { added, skipped };
}
