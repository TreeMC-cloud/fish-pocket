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

// ---------- R5 场景配置 ----------
function checkScene(dir) {
  const f = path.join(dir, '.scene.json');
  if (!fs.existsSync(f)) {
    // 没有场景配置不算错——大多数目录不需要。只在有 HANDOFF 却没场景时提示。
    const hasHandoff = fs.existsSync(path.join(dir, 'HANDOFF.md'));
    if (hasHandoff) {
      report('R5', '场景配置', false,
        '有交接文件但没有 .scene.json',
        '跑 scene.mjs init 建一个，写明这个场景负责什么、不碰什么。否则 Agent 不知道自己是谁。');
    } else {
      report('R5', '场景配置', true, '（无需场景配置）');
    }
    return;
  }
  let scene;
  try {
    scene = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    report('R5', '场景配置', false, `.scene.json 解析失败：${e.message}`,
      '修好 JSON 语法。');
    return;
  }
  const missing = [];
  if (!scene.name) missing.push('name');
  if (!Array.isArray(scene.duty) || !scene.duty.length) missing.push('duty');
  // avoid 是最重要的字段：说不清不碰什么，就说不清边界
  if (!Array.isArray(scene.avoid) || !scene.avoid.length) missing.push('avoid');
  if (missing.length) {
    report('R5', '场景配置', false, `缺字段：${missing.join(', ')}`,
      '尤其 avoid 不能空——说不清「不碰什么」就等于没有边界。');
  } else {
    report('R5', '场景配置', true, `${scene.name}（负责 ${scene.duty.length} 条，不碰 ${scene.avoid.length} 条）`);
  }
}

// ---------- R6 偏好冲突 ----------
function checkPrefs() {
  const home = process.env.DSH_HOME;
  const file = home ? path.join(home, 'preferences.json') : null;
  if (!file || !fs.existsSync(file)) {
    report('R6', '偏好', true, '（未设置偏好）');
    return;
  }
  let prefs;
  try {
    prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    report('R6', '偏好', false, 'preferences.json 解析失败', '修好 JSON。');
    return;
  }
  // 检查同类里有没有明显矛盾的（简单启发：同一类里出现"不"字的相反说法）
  const byKind = {};
  for (const p of prefs) (byKind[p.kind] ||= []).push(p.text);
  const conflicts = [];
  for (const [k, texts] of Object.entries(byKind)) {
    if (texts.length < 2) continue;
    // 粗糙但有效的检查：一条说"用X"，一条说"不用X"
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i], b = texts[j];
        if (b.startsWith('不') && a.includes(b.slice(1))) conflicts.push(`${k}: 「${a}」vs「${b}」`);
        if (a.startsWith('不') && b.includes(a.slice(1))) conflicts.push(`${k}: 「${a}」vs「${b}」`);
      }
    }
  }
  if (conflicts.length) {
    report('R6', '偏好', false, `${conflicts.length} 处可能冲突：${conflicts.slice(0,3).join('；')}`,
      '同一条偏好出现相反说法。跑 prefs.mjs list 看，删掉不要的那条。');
  } else {
    report('R6', '偏好', true, `${prefs.length} 条，无明显冲突`);
  }
}

// ---------- R7 共享层卫生 ----------
function checkShared() {
  const home = process.env.DSH_HOME;
  if (!home) { report('R7', '共享层', true, '（未启用）'); return; }
  const boardFile = path.join(home, 'shared', 'board.json');
  if (!fs.existsSync(boardFile)) {
    report('R7', '共享层', true, '（还没有待办）');
    return;
  }
  let board;
  try { board = JSON.parse(fs.readFileSync(boardFile, 'utf8')); }
  catch { report('R7', '共享层', false, '待办文件解析失败', '修好 JSON。'); return; }

  const open = board.filter((x) => !x.done);
  const now = Date.now();
  // 超过 14 天没动的待办：要么做，要么删。长期挂着等于没有待办板。
  const stale = open.filter((x) => {
    const t = Date.parse((x.at || '').replace(' ', 'T'));
    return Number.isFinite(t) && now - t > 14 * 86400_000;
  });
  if (stale.length) {
    report('R7', '共享层', false,
      `${stale.length} 条待办挂了超过 14 天：${stale.slice(0,3).map((x)=>x.text.slice(0,20)).join('、')}`,
      '要么做掉，要么删掉。长期挂着的待办会让人不再看这块板。');
  } else {
    report('R7', '共享层', true, `${open.length} 条待办，无长期积压`);
  }
}

// ---------- R8 交接新鲜度 ----------
function checkFreshness(dir) {
  for (const name of ['HANDOFF.md', 'handoff.md']) {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) continue;
    const st = fs.statSync(f);
    const days = (Date.now() - st.mtimeMs) / 86400_000;
    if (days > 30) {
      report('R8', '交接新鲜度', false,
        `${name} 已经 ${days.toFixed(0)} 天没更新`,
        '要么项目已经结束（删了或归档），要么交接没跟上实际进度——后者更危险。');
    } else if (days > 7) {
      report('R8', '交接新鲜度', false,
        `${name} ${days.toFixed(0)} 天没更新`,
        '如果还在做这个项目，交接该更新了。');
    } else {
      report('R8', '交接新鲜度', true, `${days < 1 ? '今天更新过' : days.toFixed(0) + ' 天前更新'}`);
    }
    return;
  }
  report('R8', '交接新鲜度', true, '（无交接文件）');
}

// ---------- 入口 ----------
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const dir = path.resolve(args.find((a) => !a.startsWith('--')) || '.');

// 路径本身不合法是用法错误，不是"规矩没守住"——两者要分开报，
// 否则用户看到一堆 ✗ 却不知道是自己路径写错了。
try {
  if (!fs.statSync(dir).isDirectory()) {
    console.error(`不是目录：${dir}`);
    process.exit(2);
  }
} catch {
  console.error(`路径不存在：${dir}`);
  process.exit(2);
}

checkHandoff(dir);
checkTempJunk(dir);
checkSkills(dir);
checkScene(dir);
checkPrefs();
checkShared();
checkFreshness(dir);

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
