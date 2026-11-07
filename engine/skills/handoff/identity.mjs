#!/usr/bin/env node
/**
 * 身份卡生成 —— 让 Agent 出场就知道自己是谁。
 *
 * 来自 UP 主「马上淋雨」的机制：把「我是谁」从需要开场读取的文档，
 * 变成由工具生成的核心事实。他的原话：
 *   「不是开场要读一堆乱七八糟的东西，是它出场就知道自己是个什么东西。」
 *
 * 区别：
 *   HANDOFF.md   —— 人写的，记录进度（下一步/卡点）
 *   IDENTITY.md  —— 工具生成，记录身份（职责/边界/能力），手改会被下次生成覆盖
 *
 * 用法：
 *   node identity.mjs           生成/刷新当前目录的 IDENTITY.md
 *   node identity.mjs --show    只打印不写
 *
 * 数据来源：项目里的 HANDOFF.md、AGENTS.md、skills/ 目录，
 * 以及 git 信息（如果在仓库里）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const dir = process.cwd();
const showOnly = process.argv.includes('--show');

function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

// ---------- 采集事实 ----------
const facts = {
  generated: new Date().toISOString().replace('T', ' ').slice(0, 19),
  directory: dir,
  project: null,
  handoffNext: null,
  handoffBlock: null,
  skills: [],
  isRepo: false,
  branch: null,
  lastCommit: null,
  languages: [],
};

// 项目名：优先找 package.json / project.yml，否则用目录名
facts.project = safe(() => {
  const pkg = path.join(dir, 'package.json');
  if (fs.existsSync(pkg)) {
    const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    if (j.name) return j.name;
  }
  return path.basename(dir);
}, path.basename(dir));

// 交接文件里的「下一步」和「卡点」
const handoff = ['HANDOFF.md', 'handoff.md']
  .map((n) => path.join(dir, n))
  .find((p) => safe(() => fs.statSync(p).isFile(), false));
if (handoff) {
  const text = safe(() => fs.readFileSync(handoff, 'utf8'), '');
  facts.handoffNext = safe(() => (text.match(/下一步[：:]\s*(.+)/) || [])[1]?.trim() || null);
  facts.handoffBlock = safe(() => (text.match(/卡点[：:]\s*(.+)/) || [])[1]?.trim() || null);
}

// 技能：只取名字和一句简介
const skillDir = path.join(dir, 'skills');
if (safe(() => fs.statSync(skillDir).isDirectory(), false)) {
  for (const name of safe(() => fs.readdirSync(skillDir), [])) {
    const f = path.join(skillDir, name, 'SKILL.md');
    if (!safe(() => fs.statSync(f).isFile(), false)) continue;
    const text = safe(() => fs.readFileSync(f, 'utf8'), '');
    const desc = safe(() => (text.match(/^description:\s*(.+)$/m) || [])[1]?.trim() || '', '');
    facts.skills.push({ name, desc: desc.slice(0, 80) });
  }
}

// git 状态
facts.isRepo = safe(() => {
  execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'ignore' });
  return true;
}, false);
if (facts.isRepo) {
  facts.branch = safe(() => execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir, encoding: 'utf8' }).trim());
  facts.lastCommit = safe(() => execSync('git log -1 --format=%s', { cwd: dir, encoding: 'utf8' }).trim());
}

// 语言构成（按扩展名统计）
const EXT_LANG = {
  '.swift': 'Swift', '.mjs': 'JavaScript', '.js': 'JavaScript', '.ts': 'TypeScript',
  '.py': 'Python', '.c': 'C', '.go': 'Go', '.rs': 'Rust', '.md': 'Markdown',
  '.yml': 'YAML', '.json': 'JSON', '.html': 'HTML', '.css': 'CSS',
};
const counts = {};
const SKIP = new Set(['node_modules', '.git', 'build', 'DerivedData', 'vendor', '.dsh', 'dist']);
(function walk(d, depth = 0) {
  if (depth > 4) return;
  for (const e of safe(() => fs.readdirSync(d, { withFileTypes: true }), [])) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walk(path.join(d, e.name), depth + 1);
    } else {
      const lang = EXT_LANG[path.extname(e.name).toLowerCase()];
      if (lang) counts[lang] = (counts[lang] || 0) + 1;
    }
  }
})(dir);
facts.languages = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4);

// ---------- 生成 ----------
const lines = [];
lines.push('# 身份');
lines.push('');
lines.push('> 本文件由 `identity.mjs` 生成，**不要手改**——下次生成会覆盖。');
lines.push('> 要改身份，改项目结构或 `HANDOFF.md`，然后重新生成。');
lines.push('');
lines.push(`**项目**：${facts.project}`);
lines.push(`**目录**：\`${facts.directory}\``);
lines.push(`**生成时间**：${facts.generated}`);
lines.push('');

if (facts.isRepo) {
  lines.push('## 位置');
  lines.push('');
  lines.push(`- 分支：\`${facts.branch}\``);
  lines.push(`- 最近提交：${facts.lastCommit}`);
  lines.push('');
}

if (facts.languages.length) {
  lines.push('## 这是什么');
  lines.push('');
  lines.push('按文件数：' + facts.languages.map(([l, n]) => `${l} ${n}`).join(' · '));
  lines.push('');
}

if (facts.handoffNext || facts.handoffBlock) {
  lines.push('## 现在在做什么');
  lines.push('');
  if (facts.handoffNext) lines.push(`- 下一步：${facts.handoffNext}`);
  if (facts.handoffBlock && facts.handoffBlock !== '无') lines.push(`- 卡点：${facts.handoffBlock}`);
  lines.push('');
}

if (facts.skills.length) {
  lines.push('## 能力（技能索引，正文按需加载）');
  lines.push('');
  for (const s of facts.skills) {
    lines.push(`- \`${s.name}\`${s.desc ? ' — ' + s.desc : ''}`);
  }
  lines.push('');
}

lines.push('## 边界');
lines.push('');
lines.push('- 不碰工作目录之外的文件（除非用户明确要求）');
lines.push('- 不改别人的记忆 / 配置；发现错了只提醒，不代改');
lines.push('- 机械动作直接做；解释、承诺、报价、改范围要问人');
lines.push('');

const output = lines.join('\n');

if (showOnly) {
  process.stdout.write(output);
  process.exit(0);
}

const target = path.join(dir, 'IDENTITY.md');
fs.writeFileSync(target, output, 'utf8');
console.log(`已生成 ${target}（${Buffer.byteLength(output, 'utf8')} 字节）`);
console.log(`  项目：${facts.project}`);
if (facts.handoffNext) console.log(`  下一步：${facts.handoffNext}`);
console.log(`  技能：${facts.skills.length} 个`);
