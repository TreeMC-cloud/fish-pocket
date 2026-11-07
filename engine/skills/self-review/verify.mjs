#!/usr/bin/env node
/**
 * 产物真伪校验 —— 解决「退出码 0 但目录是空的」这类假成功。
 *
 * 真实事故：图片处理 4/4 步骤全绿、退出码全 0，产物目录却是空的
 * （shell 循环掩盖了 command not found）。只看退出码永远发现不了。
 *
 * 三条判据同时满足才算成功：
 *   ① 产物真的存在
 *   ② 产物是这次生成的（mtime 在指定时间之后）
 *   ③ 产物非空、且格式能解析
 *
 * 用法：
 *   node verify.mjs <路径> [--since <秒>] [--min-size <字节>] [--json]
 *
 *   --since 60      只认最近 60 秒内修改的文件（默认 300 秒）
 *   --min-size 100  最小字节数（默认 1，即非空）
 *
 * 退出码：0 通过；1 不通过；2 用法错误。
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('用法: node verify.mjs <路径> [--since 秒] [--min-size 字节] [--json]');
  process.exit(2);
}

let target = null;
let since = 300;
let minSize = 1;
let asJson = false;

for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--since') { since = Number(args[++i]) || 300; }
  else if (a === '--min-size') { minSize = Number(args[++i]) || 1; }
  else if (a === '--json') { asJson = true; }
  else if (!a.startsWith('--')) { target = a; }
}

if (!target) {
  console.error('缺少路径');
  process.exit(2);
}

const root = path.resolve(target);
if (!fs.existsSync(root)) {
  const out = { ok: false, reason: '路径不存在', target: root };
  console.log(asJson ? JSON.stringify(out, null, 2) : `✗ 路径不存在：${root}`);
  process.exit(1);
}

const cutoff = Date.now() - since * 1000;
const SKIP = new Set(['node_modules', '.git', 'build', 'DerivedData', '__pycache__']);

/** 递归收集文件，跳过常见的产物/依赖目录。 */
function collect(dir, out = [], depth = 0) {
  if (depth > 12) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      collect(full, out, depth + 1);
    } else if (e.isFile()) {
      try {
        const st = fs.statSync(full);
        out.push({ path: full, size: st.size, mtime: st.mtimeMs });
      } catch { /* 读不到就跳过 */ }
    }
  }
  return out;
}

const files = fs.statSync(root).isDirectory() ? collect(root) : (() => {
  const st = fs.statSync(root);
  return [{ path: root, size: st.size, mtime: st.mtimeMs }];
})();

const problems = [];
const warnings = [];

// ① 存在且非空
if (files.length === 0) {
  problems.push('目录里没有任何文件 —— 这正是"退出码 0 但产物为空"的典型症状');
}

// ② 是这次生成的
const fresh = files.filter((f) => f.mtime >= cutoff);
if (files.length > 0 && fresh.length === 0) {
  problems.push(`没有文件在最近 ${since} 秒内修改过 —— 这些产物可能是上一次留下的`);
} else if (files.length > 0 && fresh.length < files.length) {
  warnings.push(`${files.length - fresh.length} 个文件不是最近修改的（可能混入了旧产物）`);
}

// ③ 非空且格式可解析
const empty = files.filter((f) => f.size < minSize);
if (empty.length) {
  problems.push(`${empty.length} 个文件小于 ${minSize} 字节：${empty.slice(0, 5).map((f) => path.basename(f.path)).join(', ')}`);
}

// 格式抽查：JSON 能不能解析
for (const f of fresh.length ? fresh : files) {
  if (!f.path.endsWith('.json')) continue;
  try {
    const text = fs.readFileSync(f.path, 'utf8');
    if (text.trim()) JSON.parse(text);
  } catch (e) {
    problems.push(`JSON 解析失败：${path.basename(f.path)} — ${e.message}`);
  }
}

// HTML 是否闭合
for (const f of fresh.length ? fresh : files) {
  if (!/\.html?$/.test(f.path)) continue;
  try {
    const text = fs.readFileSync(f.path, 'utf8');
    if (/<html/i.test(text) && !/<\/html>/i.test(text)) {
      problems.push(`HTML 没有 </html>：${path.basename(f.path)}`);
    }
  } catch { /* ignore */ }
}

const totalSize = files.reduce((s, f) => s + f.size, 0);
const report = {
  ok: problems.length === 0,
  target: root,
  fileCount: files.length,
  freshCount: fresh.length,
  totalBytes: totalSize,
  problems,
  warnings,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  if (report.ok) {
    console.log(`✓ 产物校验通过`);
    console.log(`  ${files.length} 个文件，共 ${(totalSize / 1024).toFixed(1)} KB`);
    console.log(`  ${fresh.length} 个是最近 ${since} 秒内生成的`);
    for (const w of warnings) console.log(`  ! ${w}`);
  } else {
    console.log(`✗ 产物校验不通过：${root}`);
    for (const p of problems) console.log(`  ✗ ${p}`);
    for (const w of warnings) console.log(`  ! ${w}`);
    console.log(`\n别急着报完成 —— 先确认产物真的存在、真的是这次生成的。`);
  }
}
process.exit(report.ok ? 0 : 1);
