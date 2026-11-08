// skill-stats.mjs —— 技能使用记账与健康度
//
// Phase 4 要求：「active 技能失败率升高时自动降级/撤销并通知」。
// 要做这件事，前提是**知道每个技能被用了多少次、失败多少次**。
// 现在完全没有这个数据——技能加载了没有、用了之后有没有解决问题，都是空白。
//
// 设计取舍：
//   1. 只记计数，不记内容。记录"cost-guard 被用了 12 次、失败 3 次"，
//      不记"在什么任务里用的"。后者体积大、含敏感信息，价值却低。
//   2. 追加写，带体积上限。和 trace 一样，不能无限增长。
//   3. 判定与动作分离。这里只给 verdict，降级/撤销由人决定——
//      自动撤销一个技能，比留着一个不太准的技能更危险。

import fs from 'node:fs';
import path from 'node:path';

const FILE = () => path.join(process.env.DSH_IOS_DATA || process.cwd(), '.skill-stats.json');
const MAX_SKILLS = 200;      // 超过就丢最久没用的
const MAX_BYTES = 256 * 1024;

function empty() {
  return { schemaVersion: 1, skills: {} };
}

export function load(dataDir) {
  const file = dataDir ? path.join(dataDir, '.skill-stats.json') : FILE();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed.skills !== 'object') return empty();
    return { schemaVersion: parsed.schemaVersion ?? 1, skills: parsed.skills };
  } catch {
    return empty();   // 文件坏了就当没用过，不要因此崩
  }
}

function save(state, dataDir) {
  const file = dataDir ? path.join(dataDir, '.skill-stats.json') : FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 记一次使用。
 *
 * @param {string} name      技能名
 * @param {boolean} ok       这次用下来有没有解决问题
 * @param {object} [opts]    dataDir / now
 *
 * 注意 ok 必须是**可验证的结果**，不是"技能加载成功了"。
 * 加载成功永远为真，那样的统计毫无意义。调用方要用任务/交付的实际结果。
 */
export function record(name, ok, { dataDir, now = Date.now() } = {}) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const state = load(dataDir);
  const entry = state.skills[name] ?? { uses: 0, failures: 0, firstUsedAt: now, lastUsedAt: now };
  entry.uses += 1;
  if (ok === false) entry.failures += 1;
  entry.lastUsedAt = now;
  state.skills[name] = entry;
  trim(state);
  save(state, dataDir);
  return entry;
}

/** 控制规模：技能数上限 + 丢弃最久未用的。 */
function trim(state) {
  const names = Object.keys(state.skills);
  if (names.length <= MAX_SKILLS) return;
  const sorted = names.sort((a, b) => (state.skills[a].lastUsedAt ?? 0) - (state.skills[b].lastUsedAt ?? 0));
  for (const name of sorted.slice(0, names.length - MAX_SKILLS)) delete state.skills[name];
}

/**
 * 技能健康度判定。沿用 skill-registry 的口径，但这里直接读统计数据。
 *
 * 返回每个技能的 verdict：ok / degrade / insufficient-data
 */
export function report({ dataDir, minUses = 5, failRatio = 0.4 } = {}) {
  const state = load(dataDir);
  const rows = [];
  for (const [name, s] of Object.entries(state.skills)) {
    const uses = s.uses || 0;
    const failures = s.failures || 0;
    let verdict = 'ok';
    let reason = '';
    if (uses < minUses) {
      verdict = 'insufficient-data';
      reason = `只有 ${uses} 次使用（需 ≥${minUses}）`;
    } else {
      const ratio = failures / uses;
      if (ratio >= failRatio) {
        verdict = 'degrade';
        reason = `失败率 ${(ratio * 100).toFixed(0)}%（${failures}/${uses}）≥ ${failRatio * 100}%`;
      } else {
        reason = `失败率 ${(ratio * 100).toFixed(0)}%（${failures}/${uses}）`;
      }
    }
    rows.push({ name, uses, failures, verdict, reason, lastUsedAt: s.lastUsedAt });
  }
  rows.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
  return {
    rows,
    needsAttention: rows.filter((r) => r.verdict === 'degrade'),
  };
}
