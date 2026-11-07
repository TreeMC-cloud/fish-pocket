#!/usr/bin/env node
/**
 * 交接文件工具 —— 把「记忆在文件里，不在会话里」变成可执行的检查。
 *
 * 灵感来自 luanyujia-workbench 的 §〇 交接机制。手机上的会话随时会没，
 * 所以进度必须落盘；但落盘的东西会越写越肥，最后没人读。这个工具负责：
 *
 *   check   检查交接文件是否合格（体量、五小节、下一步是否具体）
 *   init    生成一份空模板
 *   show    打印当前交接
 *
 * 用法：
 *   node handoff.mjs check [目录]     默认当前目录，找 HANDOFF.md
 *   node handoff.mjs init  [目录]     不存在才创建，不覆盖
 *   node handoff.mjs show  [目录]
 *
 * 退出码：0 合格；1 不合格；2 用法错误。
 */
import fs from 'node:fs';
import path from 'node:path';

const SECTIONS = [
  { key: '1) 上次交接', re: /^#{2,3}\s*1[)）.、]\s*上次交接/m },
  { key: '2) 当前项目', re: /^#{2,3}\s*2[)）.、]\s*当前项目/m },
  { key: '3) 变更记录', re: /^#{2,3}\s*3[)）.、]\s*变更记录/m },
  { key: '4) 下一步 / 卡点', re: /^#{2,3}\s*4[)）.、]\s*下一步/m },
  { key: '5) 关键文件位置', re: /^#{2,3}\s*5[)）.、]\s*关键文件/m },
];

/** 交接的体量红线：4 KB。超了说明在写周报，不是在写交接。 */
const MAX_BYTES = 4 * 1024;

/** 「下一步」里这些词等于没写。 */
const VAGUE = [
  '继续开发', '继续做', '继续完善', '继续优化', '接着做', '看情况',
  '待定', '再说', '后面再说', 'TODO', 'todo', '...', '……', '暂无',
];

const TEMPLATE = `# 交接

> 覆盖写，不追加。只回答四个问题：我是谁 / 干到哪 / 下一步 / 卡在哪。
> 体量上限 4 KB。超过就应该把历史搬进归档目录，而不是继续往下写。

## 1) 上次交接
- 做了什么 / 结果 / 证据（证据要写路径、命令输出，不要写"已完成"）

## 2) 当前项目
| 项目 | 状态 | 下一步 |
|---|---|---|
| <项目名> | 进行中 | <具体到可直接动手的动作> |

## 3) 变更记录
- <YYYY-MM-DD>：<改了什么 + 为什么>

## 4) 下一步 / 卡点
- 下一步：<谁先动，按什么顺序>
- 卡点：无

## 5) 关键文件位置
- <路径> — <这是什么>
`;

function findFile(dir) {
  const candidate = path.join(dir, 'HANDOFF.md');
  if (fs.existsSync(candidate)) return candidate;
  // 也接受小写
  const lower = path.join(dir, 'handoff.md');
  if (fs.existsSync(lower)) return lower;
  return null;
}

function check(dir) {
  const file = findFile(dir);
  const problems = [];
  const notes = [];

  if (!file) {
    return {
      ok: false,
      reason: '没有找到 HANDOFF.md',
      detail: '多步骤任务需要一份交接文件来跨会话续上。用 `node handoff.mjs init` 生成模板。',
      problems: [],
      notes: [],
    };
  }

  const text = fs.readFileSync(file, 'utf8');
  const bytes = Buffer.byteLength(text, 'utf8');

  // 1. 体量
  if (bytes > MAX_BYTES) {
    problems.push(`体量 ${(bytes / 1024).toFixed(1)} KB 超过 4 KB 红线 —— 这是在写周报，不是在写交接。把旧轮次搬进归档，只留最新一份。`);
  } else {
    notes.push(`体量 ${(bytes / 1024).toFixed(1)} KB，在红线内`);
  }

  // 2. 五小节
  for (const s of SECTIONS) {
    if (!s.re.test(text)) problems.push(`缺少小节「${s.key}」`);
  }

  // 3. 下一步是否具体
  const nextMatch = text.match(/下一步[：:]\s*(.+)/);
  if (nextMatch) {
    const next = nextMatch[1].trim();
    if (next.length < 4) {
      problems.push('「下一步」是空的或太短 —— 写不出下一步，说明这轮白干了');
    } else {
      const hit = VAGUE.find((v) => next.includes(v));
      if (hit && next.length < 20) {
        problems.push(`「下一步」写了「${hit}」，太虚 —— 要具体到可直接动手的动作，例如"补 src/a.mjs 的第 3 个引用错误"`);
      }
    }
  }

  // 4. 卡点必须表态
  const blockMatch = text.match(/卡点[：:]\s*(.+)/);
  if (blockMatch) {
    const block = blockMatch[1].trim();
    if (block.length === 0) problems.push('「卡点」没写 —— 没有就写"无"，不许留空');
  }

  // 5. 当前项目表是否填了真东西
  const tableRows = text.split('\n').filter((l) => /^\|/.test(l.trim()) && !/^\|[\s\-:|]+\|$/.test(l.trim()));
  const dataRows = tableRows.filter((l) => !/项目\s*\|/.test(l) && !/<项目名>/.test(l));
  if (dataRows.length === 0 && /##\s*2[)）.、]/.test(text)) {
    problems.push('「当前项目」表是空的 —— 至少写一行现在在做什么');
  }

  // 6. 占位符没替换
  if (/<项目名>|<路径>|<具体到|<YYYY-MM-DD>|<改了什么/.test(text)) {
    problems.push('还有没替换的占位符 —— 模板没填完');
  }

  return {
    ok: problems.length === 0,
    file,
    bytes,
    problems,
    notes,
  };
}

// ---------- 入口 ----------
const args = process.argv.slice(2);
const cmd = args[0];
const dir = path.resolve(args[1] && !args[1].startsWith('-') ? args[1] : '.');

if (cmd === 'init') {
  const existing = findFile(dir);
  if (existing) {
    console.log(`已存在：${existing}（不覆盖）`);
    process.exit(0);
  }
  const target = path.join(dir, 'HANDOFF.md');
  fs.writeFileSync(target, TEMPLATE, 'utf8');
  console.log(`已创建：${target}`);
  console.log('填完第 4 节的「下一步」再开始干活。');
  process.exit(0);
}

if (cmd === 'show') {
  const file = findFile(dir);
  if (!file) {
    console.log('没有 HANDOFF.md');
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(file, 'utf8'));
  process.exit(0);
}

if (cmd === 'check' || cmd === undefined) {
  const r = check(dir);
  if (r.ok) {
    console.log(`交接合格（${(r.bytes / 1024).toFixed(1)} KB）`);
    for (const n of r.notes) console.log(`  · ${n}`);
    console.log('判据：一个全新的会话读完这份交接，30 秒内能说出下一步干什么。');
    process.exit(0);
  }
  console.log(`交接不合格${r.file ? `：${r.file}` : ''}`);
  if (r.detail) console.log(`  ${r.detail}`);
  for (const p of r.problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}

console.error('用法: node handoff.mjs [check|init|show] [目录]');
process.exit(2);
