#!/usr/bin/env node
/**
 * 共享层 —— 跨场景的「四块板」，各回答一个问题。
 *
 * 来自一位实践者的四层记忆架构。关键不是"分层"，是**每块板只回答一个问题**：
 *   通知看板  → 发生了什么
 *   待办板    → 该做什么（全机唯一落点）
 *   总索引    → 东西在哪
 *   体检结果  → 机器健康吗
 *
 * 为什么必须分开（他给的三条真实教训）：
 *   1. 淹没：看板一天几十条，一周就把索引和体检顶到看不见的地方，之后没人翻
 *   2. 责任糊掉：写在一块文件里，就没有"这块归谁写"这回事
 *   3. 结构被迫统一：流水、台账、快照硬塞进一种结构，三边都别扭
 *
 * 判据：**两块内容的更新频率差一个量级，或读者不是同一批人 ⇒ 必须分开。**
 *
 * 用法：
 *   shared.mjs board            看待办板
 *   shared.mjs board add <文字> 加一条待办
 *   shared.mjs board done <id>  划掉
 *   shared.mjs notice <文字>    记一条通知（只落盘，不唤醒任何人）
 *   shared.mjs notices [--limit N]
 *   shared.mjs index            看总索引
 *
 * 数据在 $DSH_HOME/shared/ 下，四个独立文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = (() => {
  const home = process.env.DSH_HOME;
  if (home) return path.join(home, 'shared');
  const data = process.env.DSH_IOS_DATA;
  if (data) return path.join(data, 'dsh', 'shared');
  return path.join(os.homedir(), '.dsh', 'shared');
})();

const FILES = {
  board: path.join(DIR, 'board.json'),
  notices: path.join(DIR, 'notices.jsonl'),
  index: path.join(DIR, 'index.md'),
};

// 空跑开关：默认只打印计划，加 --go 才真执行。
const GO = process.argv.includes('--go');

function ensure() {
  // 空跑时不建目录也不建文件：不然"只是看一眼"也会留下空台账。
  if (!GO) return;
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(FILES.board)) fs.writeFileSync(FILES.board, '[]', 'utf8');
}

function readBoard() {
  ensure();
  try { return JSON.parse(fs.readFileSync(FILES.board, 'utf8')); } catch { return []; }
}
function writeBoard(list) {
  // 空跑：待办/通知写错会误导下次开工，先看一眼再加 --go。
  if (!GO) { console.log('   [空跑] 将写入 ' + list.length + ' 条'); return; }
  ensure();
  fs.writeFileSync(FILES.board, JSON.stringify(list, null, 2), 'utf8');
}
function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const argv = process.argv.slice(2).filter(a => a !== '--go');
const cmd = argv[0];

if (!cmd || cmd === 'help') {
  console.log(`共享层 —— 跨场景的四块板

  shared.mjs board              看待办
  shared.mjs board add <文字>   加一条
  shared.mjs board done <id>    划掉
  shared.mjs notice <文字>      记一条通知
  shared.mjs notices            看最近通知
  shared.mjs index              看总索引

数据目录：${DIR}`);
  process.exit(2);
}

if (cmd === 'board') {
  const sub = argv[1];

  if (sub === 'add') {
    const text = argv.slice(2).join(' ').trim();
    if (!text) { console.error('错误：要写待办内容'); process.exit(2); }
    const list = readBoard();
    // 同一件事只许一行：文字完全相同就跳过
    if (list.some((x) => x.text === text && !x.done)) {
      console.log('这条已经在待办里了（同一件只留一行）');
      process.exit(0);
    }
    const item = { id: `t${Date.now().toString(36)}`, text, at: now(), done: false };
    list.push(item);
    writeBoard(list);
    console.log(GO ? `✓ 已加：${text}` : `（空跑）会加：${text}`);
    console.log(`  id: ${item.id}`);
    process.exit(0);
  }

  if (sub === 'done') {
    const id = argv[2];
    if (!id) { console.error('错误：要给 id'); process.exit(2); }
    const list = readBoard();
    const item = list.find((x) => x.id === id);
    if (!item) { console.error(`没找到 ${id}`); process.exit(1); }
    item.done = true;
    item.doneAt = now();
    writeBoard(list);
    console.log(GO ? `✓ 已划掉：${item.text}` : `（空跑）会划掉：${item.text}`);
    process.exit(0);
  }

  // 默认：列出未完成的
  const list = readBoard().filter((x) => !x.done);
  if (!list.length) {
    console.log('待办是空的。');
    console.log('（做完就划掉，保持空白——他特意强调过这点：待办板不是累积的大文件）');
    process.exit(0);
  }
  console.log(`待办 ${list.length} 条：\n`);
  for (const x of list) {
    console.log(`  [${x.id}] ${x.text}`);
    console.log(`        加于 ${x.at}`);
  }
  process.exit(0);
}

if (cmd === 'notice') {
  const text = argv.slice(1).join(' ').trim();
  if (!text) { console.error('错误：要写通知内容'); process.exit(2); }
  // 空跑时 ensure() 自己会 return，但后面的 appendFileSync 还是会写 ──
  // 所以这里必须显式挡住，不能只靠 ensure()。
  if (!GO) {
    console.log(`（空跑）会记：${text}`);
    console.log('   [空跑] 没有写入任何文件。加 --go 才会真执行。');
    console.log('（通知只落盘，不唤醒任何人。要对方动手，用 dispatch-protocol 派单）');
    process.exit(0);
  }
  ensure();
  const line = JSON.stringify({ at: now(), text }) + '\n';
  fs.appendFileSync(FILES.notices, line, 'utf8');
  console.log(`✓ 已记：${text}`);
  console.log('（通知只落盘，不唤醒任何人。要对方动手，用 dispatch-protocol 派单）');
  process.exit(0);
}

if (cmd === 'notices') {
  if (!fs.existsSync(FILES.notices)) { console.log('还没有通知。'); process.exit(0); }
  const limit = Number(argv[argv.indexOf('--limit') + 1]) || 20;
  const lines = fs.readFileSync(FILES.notices, 'utf8')
    .split('\n').filter(Boolean).slice(-limit).reverse();
  if (!lines.length) { console.log('还没有通知。'); process.exit(0); }
  console.log(`最近 ${lines.length} 条（最新在上）：\n`);
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      console.log(`  ${o.at}  ${o.text}`);
    } catch { /* 坏行跳过 */ }
  }
  process.exit(0);
}

if (cmd === 'index') {
  if (!fs.existsSync(FILES.index)) {
    console.log('总索引还没建。');
    console.log('（索引回答"东西在哪"——场景 ↔ 记忆 ↔ 技能。等有 3 个以上场景再建，别提前搞。）');
    process.exit(0);
  }
  process.stdout.write(fs.readFileSync(FILES.index, 'utf8'));
  process.exit(0);
}

console.error(`错误：不认识的命令「${cmd}」`);
console.error('跑 shared.mjs help 看用法');
process.exit(2);
