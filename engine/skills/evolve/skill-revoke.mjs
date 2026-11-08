#!/usr/bin/env node
/**
 * skill-revoke.mjs —— 撤销一条已验证的技能（Phase 1「回滚工具」）
 *
 * 为什么必须有：`evolve` 的候选被人工置 verified=true 后会长期生效。
 * 但「验证过一次」不等于「永远对」——上游改版、场景变化后，一条过期技能
 * 会持续把任务带偏。没有撤销，唯一办法是手编 JSONL，既容易错也没审计。
 *
 * 设计：
 *   - 软撤销：置 status=revoked + 记录谁、为什么、什么时候，不删行。
 *     历史必须可查——「这个技能为什么被停用」本身就是重要经验。
 *   - 幂等：已 revoked 的再撤销一次是无害操作。
 *   - 可恢复：revoked 的技能可以 --restore 回 active，同样留痕。
 *
 * 与 trace.mjs 的分工：那里负责「产出候选」，这里负责「事后治理」。
 * 两个工具改同一个文件（.skill-candidates.jsonl），status 字段是共同契约。
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA = process.env.DSH_IOS_DATA || process.cwd();
const CAND_FILE = process.env.DSH_CANDIDATES_FILE || path.join(DATA, '.skill-candidates.jsonl');

class UsageError extends Error {}

function readAll(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch { /* 坏行跳过 */ }
  }
  return rows;
}

/** 原子写回：撤销是治理动作，写一半崩了不能把整个候选库打烂。 */
function writeAll(file, rows) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 按条件找候选。tag 在产出时是唯一的（distill 有去重），
 * 所以 tag 是主要键；id 兜底。
 */
function findBy(rows, { tag, id }) {
  return rows.filter((r) => {
    if (id) return r.id === id;
    if (tag) return r.tag === tag;
    return false;
  });
}

function cmdRevoke(argv) {
  const opt = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tag = opt('tag');
  const id = opt('id');
  const reason = opt('reason');
  const by = opt('by') ?? 'unknown';

  if (!tag && !id) throw new UsageError('必须给 --tag 或 --id');
  if (!reason || !reason.trim()) {
    throw new UsageError('必须给 --reason：三个月后看撤销记录的人需要知道为什么');
  }

  const rows = readAll(CAND_FILE);
  const hits = findBy(rows, { tag, id });
  if (hits.length === 0) {
    console.error(`没找到${tag ? ` tag=${tag}` : ` id=${id}`} 的候选`);
    return 1;
  }

  const now = Date.now();
  let revoked = 0;
  for (const row of hits) {
    row.status = 'revoked';
    row.revokedAt = now;
    row.revokedBy = by;
    row.revokeReason = reason.trim().slice(0, 300);
    row.verified = false;   // 撤销的同时清掉 verified，防止两处状态打架
    revoked += 1;
  }
  writeAll(CAND_FILE, rows);
  console.log(`✓ 已撤销 ${revoked} 条（${tag ?? id}）：${reason.trim()}`);
  console.log('撤销不是删除：记录保留在候选文件里，可用 --restore 恢复。');
  return 0;
}

function cmdRestore(argv) {
  const opt = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tag = opt('tag');
  const id = opt('id');
  const by = opt('by') ?? 'unknown';

  if (!tag && !id) throw new UsageError('必须给 --tag 或 --id');

  const rows = readAll(CAND_FILE);
  const hits = findBy(rows, { tag, id });
  const revoked = hits.filter((r) => r.status === 'revoked');
  if (revoked.length === 0) {
    console.error(`没有处于 revoked 状态的${tag ? ` tag=${tag}` : ` id=${id}`}`);
    return 1;
  }

  const now = Date.now();
  for (const row of revoked) {
    row.status = 'active';
    row.restoredAt = now;
    row.restoredBy = by;
    // 恢复不自动回到 verified：重新验证是另一个动作，防止一键回到「生效」。
    row.verified = false;
    // 清掉旧撤销原因：留着会让列表显示「active 但有撤销原因」的矛盾状态。
    // 撤销历史如果重要，git / 备份里有，不需要候选文件自己当历史库。
    delete row.revokeReason;
    delete row.revokedAt;
    delete row.revokedBy;
  }
  writeAll(CAND_FILE, rows);
  console.log(`✓ 已恢复 ${revoked.length} 条到 active（未 verified，需重新确认）`);
  return 0;
}

function cmdList() {
  const rows = readAll(CAND_FILE);
  if (!rows.length) { console.log('没有候选。'); return 0; }
  for (const r of rows) {
    const state = r.status === 'revoked' ? `⛔已撤销(${new Date(r.revokedAt).toISOString().slice(0, 10)})`
      : r.verified ? '✓已验证' : '○候选';
    console.log(`${state}  ${r.tag ?? r.id}  ${r.samples ?? '?'}次/失败${r.fails ?? '?'}`);
    if (r.revokeReason) console.log(`         撤销原因: ${r.revokeReason}`);
  }
  return 0;
}

const [, , cmd, ...rest] = process.argv;
const table = { revoke: cmdRevoke, restore: cmdRestore, list: cmdList };
if (!table[cmd]) {
  console.error(`用法: skill-revoke.mjs <revoke|restore|list>
  revoke  --tag <话题> --reason "为什么" [--by <谁>]
  restore --tag <话题> [--by <谁>]
  list`);
  process.exit(2);
}
try {
  process.exit(table[cmd](rest));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}
