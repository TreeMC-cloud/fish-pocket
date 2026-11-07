#!/usr/bin/env node
/**
 * 零件库 —— Agent 自己检索、自己挑、自己拉。
 *
 * 来自一位实践者的做法：他把网上所有能帮 DSH 改造的东西收进一个库，
 * 「DSH 需要啥直接读库，按需拿成品零件」。他的原话：
 *   「我让 DSH 直接读库筛选出所有和记忆相关的插件，分析它们的逻辑，
 *     再对照我的记忆框架看哪些机制适合我，把适合的拿来。」
 *
 * 为什么不是「装个成品插件」：成品插件的机制是固定的，不满足自己的要求。
 * 所以正确用法是先搜、再看、最后只拆自己需要的部分。
 *
 * 命令：
 *   toolbox.mjs search <关键词> [--cat 分类] [--top N] [--json]
 *   toolbox.mjs show <id 或名字>
 *   toolbox.mjs cats
 *   toolbox.mjs stats
 *
 * 数据：$DSH_TOOLS/toolbox/index.json（随 App 打包）
 * 退出码：0 有结果 / 1 没找到 / 2 用法错误
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, 'index.json');

function fail(msg) {
  console.error(`错误：${msg}`);
  process.exit(2);
}

let entries;
try {
  const raw = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  entries = Array.isArray(raw) ? raw : (raw.plugins || []);
} catch (e) {
  console.error(`读不了零件库索引（${INDEX}）：${e.message}`);
  console.error('重新生成：node "$DSH_TOOLS/toolbox/fetch-index.mjs"');
  process.exit(2);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (!cmd || cmd === 'help') {
  console.log(`零件库 · ${entries.length} 个条目

用法：
  toolbox.mjs search <关键词...> [--cat 分类] [--top N] [--json]
  toolbox.mjs show <id|名字>
  toolbox.mjs cats                    看分类和数量
  toolbox.mjs stats                   看数据新鲜度

搜索会同时匹配名字、简介、作者。多个关键词用空格分隔，全部命中才算。`);
  process.exit(0);
}

if (cmd === 'cats') {
  const c = {};
  for (const x of entries) c[x.category || '其他'] = (c[x.category || '其他'] || 0) + 1;
  console.log(`共 ${entries.length} 个条目：`);
  for (const [k, v] of Object.entries(c).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(10)} ${v}`);
  }
  process.exit(0);
}

if (cmd === 'stats') {
  const verified = entries.filter((x) => (x.verify || 0) >= 4).length;
  const lowRisk = entries.filter((x) => x.risk === 'low').length;
  const audited = entries.filter((x) => x.audited === true).length;
  console.log(`零件库：${entries.length} 个条目`);
  console.log(`  dsh.so 沙盒验证过：${verified}`);
  console.log(`  静态扫描低风险：${lowRisk}`);
  console.log(`  本站看过真界面：${audited}`);
  console.log('');
  console.log('上架 ≠ 实测通过。装之前自己判断是否适合你的环境。');
  process.exit(0);
}

if (cmd === 'show') {
  const q = argv[1];
  if (!q) fail('show 要给 id 或名字');
  const hit = entries.find((x) => x.id === q) ||
              entries.find((x) => (x.name || '').toLowerCase() === q.toLowerCase());
  if (!hit) {
    console.error(`没找到「${q}」`);
    process.exit(1);
  }
  console.log(`名字：${hit.name}`);
  console.log(`分类：${hit.category}`);
  console.log(`星数：${hit.stars ?? 0}`);
  console.log(`作者：${hit.author ?? '未知'}`);
  console.log(`仓库：${hit.repo}`);
  console.log(`简介：${hit.summary ?? ''}`);
  console.log('');
  const v = hit.verify || 0;
  const verifyText = v >= 5 ? 'dsh.so 沙盒里真装过一次' : v >= 4 ? '沙盒验证过' : '未实测';
  console.log(`验证：${verifyText}（verify=${v}）`);
  console.log(`风险：${hit.risk || '未扫描'}`);
  console.log(`截图：${hit.audited ? '本站看过真界面' : '没见过真界面'}`);
  process.exit(0);
}

if (cmd === 'search') {
  const keywords = [];
  let cat = null;
  let top = 12;
  let asJson = false;

  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cat') { cat = argv[++i]; }
    else if (a === '--top') { top = Number(argv[++i]) || 12; }
    else if (a === '--json') { asJson = true; }
    else if (a.startsWith('--')) fail(`不认识的参数 ${a}`);
    else keywords.push(a.toLowerCase());
  }

  if (keywords.length === 0 && !cat) {
    fail('要给关键词，或者用 --cat 分类。例如：toolbox.mjs search 记忆');
  }

  let pool = entries;
  if (cat) pool = pool.filter((x) => (x.category || '').includes(cat));

  const scored = [];
  for (const x of pool) {
    const hay = `${x.name || ''} ${x.summary || ''} ${x.author || ''} ${x.category || ''}`.toLowerCase();
    if (!keywords.every((k) => hay.includes(k))) continue;
    // 打分：名字命中权重高，星数做次要排序
    let score = 0;
    for (const k of keywords) {
      if ((x.name || '').toLowerCase().includes(k)) score += 100;
      if ((x.summary || '').toLowerCase().includes(k)) score += 20;
    }
    score += Math.min(Math.log10((x.stars || 0) + 1) * 5, 30);
    // 验证过的、低风险的往前排
    if ((x.verify || 0) >= 4) score += 15;
    if (x.risk === 'low') score += 8;
    scored.push({ x, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, top).map((s) => s.x);

  if (hits.length === 0) {
    if (asJson) console.log(JSON.stringify({ ok: false, total: 0, results: [] }, null, 2));
    else {
      console.error(`没找到匹配「${keywords.join(' ')}」${cat ? `（分类 ${cat}）` : ''}的条目`);
      console.error('换个词试试，或者先跑 toolbox.mjs cats 看分类');
    }
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: true, total: scored.length, results: hits }, null, 2));
    process.exit(0);
  }

  console.log(`找到 ${scored.length} 个，显示前 ${hits.length}：\n`);
  hits.forEach((x, i) => {
    const v = x.verify >= 4 ? ' ✓已验证' : '';
    const r = x.risk === 'low' ? ' 低风险' : (x.risk ? ` ${x.risk}` : '');
    console.log(`${i + 1}. ${x.name}  ⭐${x.stars ?? 0}  [${x.category}]${v}${r}`);
    console.log(`   ${x.summary || ''}`);
    console.log(`   ${x.repo}`);
    if (i < hits.length - 1) console.log('');
  });
  console.log('');
  console.log('要装某个，先看细节：toolbox.mjs show <名字>');
  console.log('别整包装——挑你需要的那个功能，拆下来改成自己的。');
  process.exit(0);
}

fail(`不认识的命令「${cmd}」。跑 toolbox.mjs help`);
