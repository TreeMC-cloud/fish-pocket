#!/usr/bin/env node
/**
 * 规矩体检 —— 把「规矩」变成「机制」。
 *
 * 核心理念来自 luanyujia-workbench：「没有会失败的检查的规矩 = 一句口号。」
 * 规矩写在文档里靠自觉；机制跑在代码里靠机器。一份只有规矩的系统，
 * 三个月后一定退化成「看心情」。
 *
 * 这个工具检查 App 工作环境里几条最容易退化的规矩：
 *
 *   R1 交接文件存在且合格（会话随时会没，进度必须在文件里）
 *   R2 交接体量 ≤4KB（超了就是在写周报，没人会读）
 *   R3 技能索引体量可控（技能太多会撑爆上下文）
 *   R4 项目目录没有堆积的临时文件
 *
 * 用法：
 *   node selfaudit.mjs [工作目录]
 *   node selfaudit.mjs --json [工作目录]
 *
 * 退出码：0 全部通过；1 有问题；2 用法错误。
 *
 * 每条检查都遵守五步法：违规可判定 / 判据唯一 / 输出差异集合 /
 * 能证明会失败 / 有去向（失败项列出该做什么）。
 */
import fs from 'node:fs';
import path from 'node:path';

const KB = 1024;
const results = [];

function report(id, name, ok, detail, fix) {
  results.push({ id, name, ok, detail, fix });
}

// ---------- R1 / R2 交接文件 ----------
function checkHandoff(dir) {
  const candidates = ['HANDOFF.md', 'handoff.md'].map((n) => path.join(dir, n));
  const file = candidates.find((p) => fs.existsSync(p));

  if (!file) {
    report('R1', '交接文件存在', false,
      '没有找到 HANDOFF.md',
      '多步骤任务需要交接文件才能跨会话续上。写一份，五小节：上次交接/当前项目/变更记录/下一步卡点/关键文件。');
    return;
  }

  const text = fs.readFileSync(file, 'utf8');
  const bytes = Buffer.byteLength(text, 'utf8');

  // 五小节
  const sections = [
    [/^#{2,3}\s*1[)）.、]\s*上次交接/m, '1) 上次交接'],
    [/^#{2,3}\s*2[)）.、]\s*当前项目/m, '2) 当前项目'],
    [/^#{2,3}\s*3[)）.、]\s*变更记录/m, '3) 变更记录'],
    [/^#{2,3}\s*4[)）.、]\s*下一步/m, '4) 下一步 / 卡点'],
    [/^#{2,3}\s*5[)）.、]\s*关键文件/m, '5) 关键文件位置'],
  ];
  const missing = sections.filter(([re]) => !re.test(text)).map(([, n]) => n);

  if (missing.length) {
    report('R1', '交接文件合格', false,
      `缺小节：${missing.join('、')}`,
      '交接只回答四个问题：我是谁 / 干到哪 / 下一步 / 卡在哪。补齐缺的小节。');
    return;
  }

  // 下一步不能虚
  const next = (text.match(/下一步[：:]\s*(.+)/) || [])[1]?.trim() || '';
  const vague = ['继续开发', '继续做', '继续完善', '继续优化', '接着做', '待定', '再说', '暂无'];
  const isVague = !next || (vague.some((v) => next.includes(v)) && next.length < 20);

  if (isVague) {
    report('R1', '交接文件合格', false,
      `「下一步」太虚：${next || '（空）'}`,
      '写不出具体的下一步，说明这轮白干了。要具体到可直接动手，例如"补 src/a.mjs 第 3 个引用错误"。');
  } else {
    report('R1', '交接文件合格', true, `下一步：${next.slice(0, 60)}`);
  }

  // 体量
  if (bytes > 4 * KB) {
    report('R2', '交接体量 ≤4KB', false,
      `${(bytes / KB).toFixed(1)} KB 超红线`,
      '这是在写周报。把旧轮次搬进归档，只留最新一份 + 指针。历史上限 4KB 是有原因的：超了没人读。');
  } else {
    report('R2', '交接体量 ≤4KB', true, `${(bytes / KB).toFixed(1)} KB`);
  }
}

// ---------- R3 项目目录卫生 ----------
function checkTempJunk(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    report('R3', '目录卫生', false, '读不了目录', '确认路径存在且有读权限');
    return;
  }

  const junk = [];
  for (const e of entries) {
    const n = e.name;
    // 常见临时残留：*.bak / *.tmp / *.orig / *~ / .DS_Store / 复制粘贴的 .bak-xxx
    if (/\.(bak|tmp|orig|swp)$/i.test(n) ||
        /\.bak[-.]/i.test(n) ||
        /~$/.test(n) ||
        n === '.DS_Store' ||
        /^untitled/i.test(n) ||
        /^(copy|副本)/i.test(n)) {
      junk.push(n);
    }
  }

  if (junk.length) {
    report('R3', '目录卫生', false,
      `${junk.length} 个临时残留：${junk.slice(0, 8).join(', ')}${junk.length > 8 ? ' …' : ''}`,
      '临时文件和备份不该留在工作目录。要留证据就改名放 evidence/，不要留在入口。');
  } else {
    report('R3', '目录卫生', true, '没有临时残留');
  }
}

// ---------- R4 技能体量 ----------
function checkSkills(dir) {
  // 在 App 环境里是 ../skills，在工作目录里可能不存在——不存在就跳过
  const skillDir = path.join(dir, 'skills');
  if (!fs.existsSync(skillDir)) {
    report('R4', '技能体量', true, '（无 skills 目录，跳过）');
    return;
  }
  const oversized = [];
  for (const name of fs.readdirSync(skillDir)) {
    const f = path.join(skillDir, name, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    const bytes = fs.statSync(f).size;
    // 单篇技能红线 12KB：超了应该拆成主文件 + reference
    if (bytes > 12 * KB) oversized.push(`${name} ${(bytes / KB).toFixed(0)}KB`);
  }
  if (oversized.length) {
    report('R4', '技能体量', false,
      `超 12KB：${oversized.join(', ')}`,
      '拆成"主文件 + reference 子文件"，主文件只留索引与判据。');
  } else {
    report('R4', '技能体量', true, '全部在红线内');
  }
}

// ---------- 入口 ----------
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const dir = path.resolve(args.find((a) => !a.startsWith('--')) || '.');

checkHandoff(dir);
checkTempJunk(dir);
checkSkills(dir);

const failed = results.filter((r) => !r.ok);
const okCount = results.length - failed.length;

if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, total: results.length, passed: okCount, results }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} [${r.id}] ${r.name}  ${r.detail}`);
    if (!r.ok && r.fix) console.log(`     → ${r.fix}`);
  }
  console.log('');
  console.log(`${okCount}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项已列出处理办法。没修的不要假装通过。');
  } else {
    console.log('规矩都在跑，不是口号。');
  }
}
process.exit(failed.length === 0 ? 0 : 1);
