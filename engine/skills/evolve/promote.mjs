// promote.mjs —— 把「候选技能」变成真正的 SKILL.md
//
// ## 为什么需要它
//
// 进化闭环的前半段（trace 记账 → Dream 整理 → 提炼候选）都在跑，
// 候选也确实产出了，而且是 `verified: false`——这个设计是对的：
// 未经验证的经验不该自动改变行为。
//
// 但后半段断了：**没有任何入口把候选变成真技能**。候选永远躺在
// `.evolved-candidates.jsonl` 里，技能检索永远看不到它们。
// 结果是「学了但没学会」——有记录，没行为改变。
//
// ## 为什么生成的内容必须标 TODO
//
// 候选里只有两段截断的文本：`problem`（踩了什么坑）和 `practice`（当时怎么解决的），
// 各 200 字。这些是**证据片段**，不是可复用的操作步骤。
//
// 直接把片段塞进 SKILL.md 会造成两种伤害：
//   1. 模型读到一段针对某次具体任务的描述，误当成通用规则
//   2. description 写成任务原话，检索时会命中错误场景（比没有更糟）
//
// 所以这里生成一个**骨架**：frontmatter 可检索（name/description 从 tag 派生），
// 正文把证据原文放进引用块、并明确标出「以下需要你补全」。
// 人工补完再 `verified: true` 才算真技能。
//
// 用法：
//   node skills/evolve/promote.mjs list                  看有哪些候选
//   node skills/evolve/promote.mjs show <fingerprint>    看一条候选的全文
//   node skills/evolve/promote.mjs promote <fingerprint> 生成 SKILL.md 骨架
//   node skills/evolve/promote.mjs reject <fingerprint>  丢弃候选
//
// 退出码：0 正常 / 1 有问题 / 2 用法错

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DSH_IOS_DATA || process.cwd();
const SKILLS = process.env.DSH_BUNDLED_SKILL_DIR || path.resolve(HERE, '..');
const CAND_FILE = process.env.DSH_CANDIDATES_FILE
  || path.join(DATA, '.evolved-candidates.jsonl');

function readCandidates() {
  try {
    return fs.readFileSync(CAND_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 候选的稳定标识。
 *
 * 优先用 fingerprint（话题 + 失败模式），因为它才区分「同一个话题的不同坑」；
 * 老数据没有指纹时退回 tag。列表里同时显示两者，方便手打。
 */
function idOf(c) {
  return c.fingerprint || c.tag;
}

function find(rows, needle) {
  if (!needle) return null;
  // 允许只打前缀：指纹挺长，手打全串很烦
  const exact = rows.find((c) => idOf(c) === needle);
  if (exact) return exact;
  const matches = rows.filter((c) => String(idOf(c)).startsWith(needle));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * 由 tag 生成一个合法的技能名。
 *
 * 技能名会成为目录名，所以只留小写字母、数字和连字符。
 * 中文 tag 直接转写不可行（没有拼音库），退化成 `evolved-<短哈希>`，
 * 并在 description 里保留中文，保证检索仍然按语义命中。
 */
function skillNameFor(c) {
  const raw = String(c.tag ?? '').trim();
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (slug.length >= 3) {
    // 截断要在连字符边界上，不能从单词中间切——否则 `build-fail` 会变成
    // `build-fai`，技能名读起来像拼错的词，而且和目录名难以对照。
    let out = `evolved-${slug}`;
    if (out.length > 40) {
      const cut = out.slice(0, 40);
      const at = cut.lastIndexOf('-');
      out = at > 20 ? cut.slice(0, at) : cut;
    }
    return out;
  }
  const h = String(c.fingerprint ?? raw).replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
  return `evolved-${h || 'unnamed'}`;
}

function cmdList() {
  const rows = readCandidates();
  if (rows.length === 0) {
    console.log('还没有候选技能。');
    console.log(`（候选由 evolve 的 distill 产出，写在 ${CAND_FILE}）`);
    return 0;
  }
  const pending = rows.filter((c) => c.verified !== true);
  console.log(`共 ${rows.length} 条候选，其中 ${pending.length} 条待确认\n`);
  for (const c of rows) {
    const mark = c.verified === true ? '✓已验证' : '○候选';
    const id = String(idOf(c)).slice(0, 22);
    console.log(`${mark}  ${id}`);
    console.log(`        话题：${c.tag ?? '(无)'} ｜ ${c.samples ?? 0} 次 / 失败 ${c.fails ?? 0} 次（${Math.round((c.failRatio ?? 0) * 100)}%）`);
    if (c.promotedTo) console.log(`        已生成技能：${c.promotedTo}`);
  }
  console.log('\n下一步：');
  console.log('  promote <编号>  生成 SKILL.md 骨架（之后要人工补全正文）');
  console.log('  reject  <编号>  丢弃');
  return 0;
}

function cmdShow(argv) {
  const rows = readCandidates();
  const c = find(rows, argv[0]);
  if (!c) { console.error(`找不到候选：${argv[0] ?? '(没给编号)'}`); return 1; }
  console.log(`编号：${idOf(c)}`);
  console.log(`话题：${c.tag}`);
  console.log(`样本：${c.samples} 次，失败 ${c.fails} 次（${Math.round((c.failRatio ?? 0) * 100)}%）`);
  console.log(`验证：${c.verified === true ? '已确认' : '未确认'}`);
  console.log(`\n--- 踩过的坑 ---\n${c.problem ?? '(无)'}`);
  console.log(`\n--- 当时的解法 ---\n${c.practice ?? '(无)'}`);
  return 0;
}

function cmdPromote(argv) {
  const rows = readCandidates();
  const c = find(rows, argv[0]);
  if (!c) { console.error(`找不到候选：${argv[0] ?? '(没给编号)'}`); return 1; }

  const name = skillNameFor(c);
  const dir = path.join(SKILLS, name);
  const file = path.join(dir, 'SKILL.md');
  if (fs.existsSync(file)) {
    console.error(`技能已存在：${file}`);
    console.error('要覆盖请先手动删掉，或换个话题重新提炼——不自动覆盖已存在的技能。');
    return 1;
  }

  const ratio = Math.round((c.failRatio ?? 0) * 100);
  const body = `---
name: ${name}
description: ${c.tag ?? '经验'}相关任务，遇到问题时先看这里的记录。由 ${c.samples ?? 0} 次实际执行提炼（其中失败 ${c.fails ?? 0} 次）。
version: 1.0.0
source: evolved:${idOf(c)}
permissions: []

---

# ${c.tag ?? '(未命名话题)'}

> ⚠️ **这是自动生成的骨架，正文需要人工补全后才能当成真技能使用。**
>
> 下面的「坑」和「解法」是从 ${c.samples ?? 0} 次执行记录里截取的原文片段
> （失败率 ${ratio}%），它们说明发生过什么，**不是可直接复用的步骤**。
> 请把它们改写成「遇到 X 就做 Y」这样的判据，再删掉这段提示。

## 已知的坑

${(c.problem ?? '(无记录)').split('\n').map((l) => `> ${l}`).join('\n')}

## 当时的解法

${(c.practice ?? '(无记录)').split('\n').map((l) => `> ${l}`).join('\n')}

## 待补全

- [ ] 把上面的片段改写成判据（什么情况下该做什么）
- [ ] 补一个正例和一个反例
- [ ] 确认这个做法在这个项目里成立（不是别的项目带过来的习惯）
- [ ] 删掉文件顶部的「骨架」提示
`;

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body, 'utf8');

  // 标记候选已生成，避免同一条被 promote 两次（目录已存在的检查也能挡，
  // 但这里写下来，`list` 里能直接看出哪条已经处理过）
  try {
    const updated = rows.map((r) => (idOf(r) === idOf(c) ? { ...r, promotedTo: name } : r));
    fs.writeFileSync(CAND_FILE, updated.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  } catch { /* 标记失败不影响技能生成 */ }

  console.log(`✓ 已生成 ${file}`);
  console.log('');
  console.log('接下来：');
  console.log('  1. 编辑这个文件，把「坑 / 解法」两段原文改写成判据（什么情况做什么）');
  console.log('  2. 删掉文件顶部那段「这是自动生成的骨架」提示');
  console.log('  3. 跑 `node skills/evolve/promote.mjs check` 确认已补全');
  console.log('');
  console.log('做完之前它会一直算"骨架"——技能检索会看到名字，但正文里明写着');
  console.log('别当真理用。这是故意的：没补全的经验不该被当成经验。');
  return 0;
}

/**
 * 检查已生成的骨架有没有补全。
 *
 * 为什么要有这一步：光生成文件不算「学会」。一个还带着骨架提示的 SKILL.md
 * 被模型读到，比没有这个技能更糟——它会把半成品当规则。
 * 这里只做机械检查（提示是否还在、正文是否还全是引用块），
 * 不判断内容好不好——那只能人来判断。
 */
function cmdCheck() {
  let names;
  try {
    names = fs.readdirSync(SKILLS, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('evolved-'))
      .map((e) => e.name);
  } catch {
    console.log('技能目录读不到。');
    return 1;
  }
  if (names.length === 0) {
    console.log('还没有由候选生成的技能。');
    return 0;
  }

  let unfinished = 0;
  for (const name of names) {
    const file = path.join(SKILLS, name, 'SKILL.md');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }

    const problems = [];
    if (text.includes('这是自动生成的骨架')) problems.push('骨架提示还在');
    // 正文如果整段都是 `> ` 引用，说明还是原文摘录，没有改写
    const body = text.split('---').slice(2).join('---');
    const contentLines = body.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('- [ ]'));
    const quoteLines = contentLines.filter((l) => l.trim().startsWith('>'));
    if (contentLines.length > 0 && quoteLines.length === contentLines.length) {
      problems.push('正文还是原文引用，没有改写成判据');
    }

    if (problems.length === 0) {
      console.log(`✓ ${name}  已补全`);
    } else {
      unfinished += 1;
      console.log(`○ ${name}  待补全：${problems.join('、')}`);
    }
  }
  if (unfinished > 0) {
    console.log(`\n还有 ${unfinished} 个没补全。补完它们才算真的学到东西。`);
  }
  return 0;
}

function cmdReject(argv) {
  const rows = readCandidates();
  const c = find(rows, argv[0]);
  if (!c) { console.error(`找不到候选：${argv[0] ?? '(没给编号)'}`); return 1; }
  const updated = rows.filter((r) => idOf(r) !== idOf(c));
  // 备份再写：候选表是证据，误删就不该只有一次机会
  try {
    fs.writeFileSync(`${CAND_FILE}.bak`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(CAND_FILE, updated.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  } catch (error) {
    console.error(`写入失败：${error.message}`);
    return 1;
  }
  console.log(`✓ 已丢弃候选 ${idOf(c)}（原文件备份为 .bak）`);
  return 0;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const [, , cmd, ...rest] = process.argv;
  const table = { list: cmdList, show: cmdShow, promote: cmdPromote, reject: cmdReject, check: cmdCheck };
  if (!table[cmd]) {
    console.error('用法: promote.mjs <list|show|promote|reject|check> [编号]');
    process.exit(2);
  }
  process.exit(table[cmd](rest));
}

export { skillNameFor, idOf };
