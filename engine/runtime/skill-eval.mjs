// skill-eval.mjs —— 技能检索评测
//
// Phase 4 要求「在离线测试集上做 skill retrieval、技能冲突和过期测试」。
//
// 为什么不能靠感觉：技能目录是给模型看的，模型会不会"想起来用"取决于
// description 写得好不好。这句描述到底管不管用，只能测：
//   给定一条任务描述，看它命中的技能对不对。
//
// 这里实现最简单可直接验证的判据——**关键词命中**，不做 embedding：
//   - 可解释：能说清为什么命中
//   - 可复现：同一个测试集每次结果一样
//   - 零依赖：iOS 上没有向量库
//
// 局限要说清：关键词命中 ≠ 模型真的会想起来用。它只能筛出
// "描述里压根没提这件事" 的明显问题，不能证明模型一定会调用。

import fs from 'node:fs';
import path from 'node:path';

/** 从 description 里取出可用于匹配的词。中文按 2-gram，英文按单词。 */
export function tokens(text) {
  const s = String(text ?? '').toLowerCase();
  const latin = s.match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
  const cjk = s.match(/[\u4e00-\u9fa5]+/g) ?? [];
  const grams = [];
  for (const run of cjk) {
    for (let i = 0; i + 1 < run.length; i += 1) grams.push(run.slice(i, i + 2));
  }
  return new Set([...latin, ...grams]);
}

/** 任务描述与技能描述的相似度：交集 / 任务词数。0~1 */
export function similarity(query, skillText) {
  const q = tokens(query);
  if (q.size === 0) return 0;
  const s = tokens(skillText);
  let hit = 0;
  for (const t of q) if (s.has(t)) hit += 1;
  return hit / q.size;
}

/**
 * 检索：给定任务描述，返回按相似度排序的技能。
 * @param {Array<{name, description}>} skills
 */
export function retrieve(query, skills, { limit = 3, threshold = 0.15 } = {}) {
  return skills
    .map((skill) => ({ name: skill.name, score: similarity(query, `${skill.name} ${skill.description}`) }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** 读技能目录，只要 name + description（评测不需要正文）。 */
export function loadSkillIndex(skillDir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(skillDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillDir, entry.name, 'SKILL.md');
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
    if (!m) continue;
    const desc = /^description:\s*(.+)$/m.exec(m[1])?.[1] ?? '';
    out.push({ name: entry.name, description: desc.trim() });
  }
  return out;
}

/**
 * 跑测试集。
 *
 * @param {Array<{query, expect}>} cases  expect 是期望命中的技能名
 * @returns {{total, passed, failed, details}}
 */
export function evaluate(cases, skills, options = {}) {
  const details = [];
  let passed = 0;
  for (const c of cases) {
    const got = retrieve(c.query, skills, options).map((r) => r.name);
    const ok = c.expect ? got.includes(c.expect) : got.length === 0;
    if (ok) passed += 1;
    details.push({
      query: c.query,
      expect: c.expect ?? '(不应命中)',
      got,
      ok,
      // 失败时说清楚：是完全没命中，还是命中了别的
      why: ok ? '' : (c.expect ? `期望 ${c.expect}，实际 ${got.join('/') || '无'}` : `不该命中却命中 ${got.join('/')}`),
    });
  }
  return { total: cases.length, passed, failed: cases.length - passed, details };
}

/**
 * 技能冲突检测：两个技能的描述高度相似，说明它们可能在做同一件事。
 * 不自动合并——只报出来让人判断。
 */
export function findConflicts(skills, { threshold = 0.6 } = {}) {
  const conflicts = [];
  for (let i = 0; i < skills.length; i += 1) {
    for (let j = i + 1; j < skills.length; j += 1) {
      const sim = similarity(skills[i].description, skills[j].description);
      if (sim >= threshold) {
        conflicts.push({ a: skills[i].name, b: skills[j].name, similarity: Number(sim.toFixed(2)) });
      }
    }
  }
  return conflicts.sort((x, y) => y.similarity - x.similarity);
}
