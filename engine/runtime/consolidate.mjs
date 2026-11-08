// consolidate.mjs —— 把散乱的 trace 聚成「带成功率的技能记忆」
//
// 这套判据移植自服务器项目 memory_core.mjs 的 consolidate()，因为它比原版更严：
//   1. 按标签相似度聚类（不是简单按 tag 分组）——"下载" 和 "ipa" 能合成一簇
//   2. 簇内 ≥3 条、成功率 ≥60%、且必须有成功样本，才允许提炼
//   3. 产出的不是"候选文本"，而是带 successRate 的 procedural 记忆，可直接检索
//
// 为什么成功率门槛关键：原来的判据只有「失败占比 ≥30%」，
// 一个成功率 0% 的簇（全失败）只要失败占比够高也会产出"技能"——
// 那是在把错误做法固化成经验。必须有成功样本才有"解法"可学。

/** 标签关联判据。与服务器项目同口径，便于横向比较。 */
export function tagsRelated(a, b, simTh = 0.34) {
  const A = new Set(a || []);
  const B = new Set(b || []);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  if (inter >= 2) return true;
  if (inter === 1) {
    const union = A.size + B.size - inter;
    if (union > 0 && inter / union > simTh) return true;
  }
  // 短语变体：中文滑窗标签常有措辞差异（"下载ipa" vs "ipa下载"）
  // 只对长度 ≥4 的标签做，短标签用 2-gram 会大量误命中。
  for (const x of A) {
    if (String(x).length < 4) continue;
    for (const y of B) {
      if (String(y).length < 4) continue;
      if (phraseVariant(String(x), String(y))) return true;
    }
  }
  return false;
}

/** 字符 2-gram Jaccard > 0.45 视为同一短语的变体。 */
export function phraseVariant(x, y) {
  const grams = (s) => {
    const g = new Set();
    for (let i = 0; i < s.length - 1; i += 1) g.add(s.slice(i, i + 2));
    return g;
  };
  const G1 = grams(x);
  const G2 = grams(y);
  let inter = 0;
  for (const g of G1) if (G2.has(g)) inter += 1;
  const union = G1.size + G2.size - inter;
  return union > 0 && inter / union > 0.45;
}

/**
 * 贪心聚类：按标签相关性把 trace 聚成簇。
 * 与簇内**任一**成员相关即并入（取第一个相关簇），这是服务器的原始策略——
 * 简单、可预测，比"取最相似簇"更不容易因为早期误聚而雪崩。
 */
export function clusterTraces(traces, { tagSimilarity = 0.34 } = {}) {
  const clusters = [];
  for (const item of traces) {
    const tags = (item.tags || []).filter(Boolean);
    if (tags.length === 0) continue;
    let best = -1;
    for (let i = 0; i < clusters.length; i += 1) {
      if (clusters[i].members.some((m) => tagsRelated(tags, m.tags, tagSimilarity))) {
        best = i;
        break;
      }
    }
    if (best >= 0) clusters[best].members.push({ tags, item });
    else clusters.push({ members: [{ tags, item }] });
  }
  return clusters;
}

/**
 * 从 trace 提炼技能记忆。
 *
 * @param {Array} traces  带 {ok, summary, tags, at} 的记录
 * @param {object} opts   minHits=3, minSuccessRate=0.6, maxText=600
 * @returns {Array<{tags, successRate, samples, text}>}
 */
export function distill(traces, { minHits = 3, minSuccessRate = 0.6, maxText = 600 } = {}) {
  const clusters = clusterTraces(traces);
  const out = [];

  for (const cluster of clusters) {
    const items = cluster.members.map((m) => m.item);
    if (items.length < minHits) continue;

    const okItems = items.filter((i) => i.ok === true);
    // 没有成功样本 = 还没找到解法，不能固化成技能。
    // 这条比"失败够多"重要：失败多只说明难，有成功才说明有办法。
    if (okItems.length === 0) continue;

    const rate = okItems.length / items.length;
    if (rate < minSuccessRate) continue;

    // 代表标签 = 簇内出现频次最高的（保持首次出现的顺序，便于稳定输出）
    const freq = new Map();
    for (const m of cluster.members) {
      for (const t of m.tags) freq.set(t, (freq.get(t) || 0) + 1);
    }
    const tags = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 12);
    const key = [...tags].sort().join('+');

    // 取最强的那条成功样本当"典型做法"（这里用最近的一条，简单且可解释）
    const best = okItems[okItems.length - 1];
    const text = `技能[${key}] 成功率${(rate * 100).toFixed(0)}%（${okItems.length}/${items.length}）\n`
      + `典型做法：${String(best.summary || '').slice(0, maxText)}`;

    out.push({
      tags,
      key,
      successRate: Number(rate.toFixed(3)),
      samples: items.length,
      successes: okItems.length,
      text,
      verified: false,          // 永不自动激活：记错比记不住糟糕得多
      source: 'trace',
    });
  }
  return out;
}
