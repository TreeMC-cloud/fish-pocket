// evolve-cli.mjs —— Dream 与评测的命令行入口
//
// 为什么单独开一个：trace.mjs 只做 record/distill/list，Dream 需要
// 「该不该跑、跑一次、看审计、跑评测」这些带状态的判断，混进去会让
// trace.mjs 变得难懂。这里只做编排，逻辑都在 runtime/*.mjs 里。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { shouldRun, runDream, recentAudit } from './dream.mjs';
import { evaluate, findConflicts, loadSkillIndex } from './skill-eval.mjs';
import { report as statsReport } from './skill-stats.mjs';
import { createMemoryStore, workspaceFromEnv } from './memory-store.mjs';

const DATA = process.env.DSH_IOS_DATA || process.cwd();
const SKILLS = process.env.DSH_BUNDLED_SKILL_DIR || path.join(DATA, '..', 'skills');

/**
 * 内置评测集：每条是「一句话任务 → 应该命中的技能」。
 *
 * 这些句子来自真实使用场景，不是编的。改动技能描述后跑一遍，
 * 就知道有没有把原来的触发条件写坏。
 */
const CASES = [
  { query: '把活派给子 agent 去做', expect: 'dispatch-protocol' },
  { query: '会话轮次太多了，该换一个了', expect: 'rotate' },
  { query: '不知道 iOS 上有没有这个命令', expect: 'ios-environment' },
  { query: '开始一项要做很多步的任务，先看看进度', expect: 'handoff' },
  { query: '现在在哪个项目里，该用哪套规矩', expect: 'scene' },
  { query: '用户的称呼和风格偏好是什么', expect: 'preferences' },
  { query: '做完之后检查一下有没有搞砸', expect: 'self-review' },
  { query: '今天中午吃什么好呢', expect: null },
  { query: '讲个笑话', expect: null },
];

function cmdStatus() {
  const gate = shouldRun(DATA);
  console.log(`Dream 状态：${gate.shouldRun ? '✓ 可以跑' : '· 还不到时候'}`);
  console.log(`  原因：${gate.reason}`);
  const audit = recentAudit(DATA, 3);
  if (audit.length) {
    console.log('  最近几次：');
    for (const a of audit) {
      console.log(`    ${new Date(a.at).toISOString().slice(0, 16)} ${a.event} 处理 ${a.processed ?? '-'} 条，产出 ${a.produced ?? '-'} 条`);
    }
  } else {
    console.log('  还没有跑过');
  }
  return 0;
}

function cmdRun(argv) {
  const force = argv.includes('--force');
  const noStore = argv.includes('--no-store');

  // 接上真实记忆库。--no-store 用于只想看产出的场合（不写库）。
  let store = null;
  if (!noStore) {
    const workspace = workspaceFromEnv();
    store = createMemoryStore(workspace, { project: path.basename(workspace) });
    if (!store.available) {
      console.log(`⚠ 记忆库不可用（${store.error ?? '未知原因'}），本次只产出不落库`);
      store = null;
    }
  }

  const result = force
    ? runDream(DATA, { minNew: 1, store })
    : runDream(DATA, { store });
  store?.close();

  if (!result.ran) {
    console.log(`没跑：${result.reason}`);
    return 0;
  }
  console.log(`✓ 整理完成：处理 ${result.processed} 条 trace，产出 ${result.produced.length} 条`);
  console.log(store
    ? `  已写入记忆库 ${result.stored} 条（procedural 层，带「未验证」前缀）`
    : '  未落库（预览模式）');
  console.log('候选一律 verified=false，看过确认后才生效。');
  return 0;
}

function cmdEval() {
  const skills = loadSkillIndex(SKILLS);
  if (!skills.length) {
    console.error(`读不到技能目录：${SKILLS}`);
    return 2;
  }
  console.log(`技能数：${skills.length}`);
  const r = evaluate(CASES, skills);
  console.log(`检索评测：${r.passed}/${r.total} 通过`);
  for (const d of r.details) {
    if (!d.ok) console.log(`  ✗ ${d.query} → ${d.why}`);
  }
  const conflicts = findConflicts(skills);
  if (conflicts.length) {
    console.log(`描述冲突 ${conflicts.length} 组：`);
    for (const c of conflicts.slice(0, 5)) console.log(`  ${c.a} ↔ ${c.b} 相似度 ${c.similarity}`);
  }
  return r.failed === 0 ? 0 : 1;
}

function cmdHealth() {
  const r = statsReport({ dataDir: DATA });
  if (!r.rows.length) {
    console.log('还没有使用记录。等 App 跑一段时间后自然会积累。');
    return 0;
  }
  for (const row of r.rows) {
    console.log(`${row.name.padEnd(22)} ${String(row.uses).padStart(4)} 次  失败 ${row.failures}  ${row.verdict}  ${row.reason}`);
  }
  if (r.needsAttention.length) {
    console.log(`\n⚠ ${r.needsAttention.length} 个技能该看：${r.needsAttention.map((x) => x.name).join(', ')}`);
    console.log('（不会自动撤销——自动撤一个技能比留个不太准的更危险）');
  }
  return 0;
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const [, , cmd, ...rest] = process.argv;
  const table = { status: cmdStatus, run: cmdRun, eval: cmdEval, health: cmdHealth };
  if (!table[cmd]) {
    console.error('用法: evolve-cli.mjs <status|run|eval|health> [--force]');
    console.error('  status  Dream 该不该跑');
    console.error('  run     跑一次整理');
    console.error('  eval    技能检索评测');
    console.error('  health  技能健康度');
    process.exit(2);
  }
  process.exit(table[cmd](rest));
}

export { CASES };
