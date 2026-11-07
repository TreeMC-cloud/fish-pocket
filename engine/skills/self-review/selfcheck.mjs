#!/usr/bin/env node
/**
 * 交付自查工具 —— 在手机上对产物做机械检查，替代"我觉得对了"。
 *
 * 对应 self-review 技能的七条不变量里能自动化的部分：
 *   I1 引用闭合（本地 import/require/src/href 指向真实文件）
 *   I2 声明一致（JS: 调用的本地符号是否在导出/声明里）
 *   I4 结构平衡（括号/引号/块闭合）
 *   I5 路径合法
 *
 * 用法：
 *   node selfcheck.mjs <file> [file...]      检查指定文件
 *   node selfcheck.mjs --dir <path>          递归检查目录里的源码与产物
 *   node selfcheck.mjs --json <file>         机器可读输出
 *
 * 退出码：0 全部通过；1 有问题；2 用法错误。
 *
 * 只做机械检查，不做语义判断——它抓不到"逻辑写错了"，但能抓到
 * 括号不闭合、引用了不存在的文件、调用了没导出的符号、
 * 写完是空文件这类交付前最常见的翻车。
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.swift', '.py', '.html', '.htm', '.css']);
const SKIP_DIR = new Set(['node_modules', '.git', 'build', 'DerivedData', '.dsh', 'vendor']);

/** 一条问题。severity: error 必须修，warn 值得看一眼。 */
const problems = [];
function add(severity, file, line, invariant, message) {
  problems.push({ severity, file, line, invariant, message });
}

// ---------- I4 结构平衡 ----------
// 逐字符扫描，跳过字符串和注释里的括号。返回不闭合的位置。
function checkBalance(file, text) {
  const ext = path.extname(file);
  const codeLike = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.swift', '.css'].includes(ext);
  const pyLike = ext === '.py';
  if (!codeLike && !pyLike) return;

  const stack = [];
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const closers = { ')': '(', ']': '[', '}': '{' };
  let line = 1;
  let i = 0;
  const n = text.length;
  const isSwift = ext === '.swift';

  // 语言各自的注释与字符串规则
  const lineComment = pyLike ? '#' : '//';
  const blockComment = pyLike ? null : ['/*', '*/'];

  // Swift 原始字符串 #"…"# / #"""…"""#，以及原始正则 #/…/#：井号个数必须配对。
  // 不认它就会把 #/…/# 里的 [ ] 当成真实括号，整份文件误报。

  while (i < n) {
    const ch = text[i];
    if (ch === '\n') { line += 1; i += 1; continue; }

    // Swift 原始字符串：#"…"# / #"""…"""# / #/…/#
    if (isSwift && ch === '#') {
      const m = /^(#+)(\/|"""|")/.exec(text.slice(i, i + 8));
      if (m) {
        const hashes = m[1];
        const opener = m[2];
        const closer = opener === '"""' ? `"""${hashes}` : `${opener}${hashes}`;
        const bodyStart = i + hashes.length + opener.length;
        const end = text.indexOf(closer, bodyStart);
        const stop = end === -1 ? n : end + closer.length;
        for (let k = i; k < stop; k += 1) if (text[k] === '\n') line += 1;
        if (end === -1) add('error', file, line, 'I4', 'Swift 原始字符串未闭合');
        i = stop;
        continue;
      }
    }

    // Swift 多行字符串 """…"""
    if (isSwift && text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      const stop = end === -1 ? n : end + 3;
      for (let k = i; k < stop; k += 1) if (text[k] === '\n') line += 1;
      if (end === -1) add('error', file, line, 'I4', 'Swift 多行字符串未闭合');
      i = stop;
      continue;
    }

    // 行注释
    if (text.startsWith(lineComment, i)) {
      const end = text.indexOf('\n', i);
      i = end === -1 ? n : end;
      continue;
    }
    // 块注释
    if (blockComment && text.startsWith(blockComment[0], i)) {
      const end = text.indexOf(blockComment[1], i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k += 1) if (text[k] === '\n') line += 1;
      i = stop;
      continue;
    }
    // Python 三引号
    if (pyLike && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const q = text.slice(i, i + 3);
      const end = text.indexOf(q, i + 3);
      const stop = end === -1 ? n : end + 3;
      for (let k = i; k < stop; k += 1) if (text[k] === '\n') line += 1;
      if (end === -1) add('error', file, line, 'I4', '三引号字符串未闭合');
      i = stop;
      continue;
    }
    // 普通字符串
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let k = i + 1;
      let closed = false;
      while (k < n) {
        if (text[k] === '\\') { k += 2; continue; }
        if (text[k] === '\n') {
          line += 1;
          if (quote !== '`') break; // 普通字符串不能跨行
        }
        if (text[k] === quote) { closed = true; k += 1; break; }
        k += 1;
      }
      if (!closed && quote !== '`') {
        add('error', file, line, 'I4', `字符串未闭合（起始 ${quote}）`);
      }
      i = k;
      continue;
    }
    // 模板字符串里的 ${}
    if (pairs[ch]) {
      stack.push({ ch, line });
      i += 1;
      continue;
    }
    if (closers[ch]) {
      const top = stack.pop();
      if (!top) {
        add('error', file, line, 'I4', `多余的闭合符号 ${ch}`);
      } else if (top.ch !== closers[ch]) {
        add('error', file, line, 'I4', `括号不匹配：第 ${top.line} 行的 ${top.ch} 被 ${ch} 闭合`);
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  for (const opened of stack) {
    add('error', file, opened.line, 'I4', `${opened.ch} 未闭合（文件结束时仍开着）`);
  }
}

// ---------- I1 引用闭合 ----------
// 只查本地相对路径引用；外链和裸模块名不查（离线环境查不了）。
function checkImports(file, text) {
  const ext = path.extname(file);
  const dir = path.dirname(file);
  const isJs = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].includes(ext);
  const isHtml = ['.html', '.htm'].includes(ext);
  const isPy = ext === '.py';

  const specs = [];
  if (isJs) {
    // import x from './a' / import './a' / require('./a') / import('./a')
    const re = /(?:from\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(text)) !== null) specs.push(m[1]);
    // 静态 import 'x'
    const re2 = /^\s*import\s+['"]([^'"]+)['"]/gm;
    while ((m = re2.exec(text)) !== null) specs.push(m[1]);
  } else if (isHtml) {
    const re = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(text)) !== null) specs.push(m[1]);
  } else if (isPy) {
    const re = /^\s*from\s+(\.[^\s]+)\s+import/gm;
    let m;
    while ((m = re.exec(text)) !== null) specs.push(m[1]);
  }

  for (const spec of specs) {
    // 只关心相对路径和根路径
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
    if (spec.startsWith('//') || spec.startsWith('http')) continue;
    if (spec.startsWith('data:') || spec.startsWith('#')) continue;
    if (spec.startsWith('/')) continue; // 站点绝对路径，运行时才知道根

    const target = path.resolve(dir, spec);
    const candidates = [
      target,
      target + '.js', target + '.mjs', target + '.cjs', target + '.ts', target + '.tsx',
      target + '.json', target + '.swift', target + '.py',
      path.join(target, 'index.js'), path.join(target, 'index.mjs'),
    ];
    const found = candidates.some((c) => {
      try { return fs.statSync(c).isFile(); } catch { return false; }
    });
    if (!found) {
      add('error', file, 0, 'I1', `引用不存在的本地资源：${spec}`);
    }
  }
}

// ---------- 空文件与明显占位 ----------
function checkContent(file, text) {
  const ext = path.extname(file);
  if (!SRC_EXT.has(ext)) return;
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    add('error', file, 0, 'I6', '文件是空的');
    return;
  }
  // 只有 TODO / 占位符
  if (/^(?:\/\/|#|\/\*)?\s*(TODO|FIXME|占位|placeholder)\s*$/i.test(trimmed)) {
    add('warn', file, 0, 'I6', '文件只有占位内容，没有实际实现');
  }
  // HTML 缺闭合
  if (['.html', '.htm'].includes(ext)) {
    if (/<html/i.test(text) && !/<\/html>/i.test(text)) {
      add('error', file, 0, 'I4', 'HTML 有 <html> 但没有 </html>');
    }
    if (/<body/i.test(text) && !/<\/body>/i.test(text)) {
      add('warn', file, 0, 'I4', 'HTML 有 <body> 但没有 </body>');
    }
  }
}

// ---------- I2 声明一致（JS 粗查） ----------
// 只查"从本地模块具名导入的符号，是否真的被对面导出"。
function checkExports(file, text) {
  const ext = path.extname(file);
  if (!['.js', '.mjs', '.cjs'].includes(ext)) return;

  const dir = path.dirname(file);
  const re = /import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const spec = m[2];
    const target = path.resolve(dir, spec);
    const candidates = [target, target + '.js', target + '.mjs', target + '.cjs',
      path.join(target, 'index.js'), path.join(target, 'index.mjs')];
    let targetFile = null;
    for (const c of candidates) {
      try { if (fs.statSync(c).isFile()) { targetFile = c; break; } } catch { /* 下一个 */ }
    }
    if (!targetFile) continue; // I1 已经报过

    let targetText = '';
    try { targetText = fs.readFileSync(targetFile, 'utf8'); } catch { continue; }

    for (const name of names) {
      if (name === 'default') continue;
      const exported =
        new RegExp(`export\\s+(?:async\\s+)?(?:function|class|const|let|var)\\s+${name}\\b`).test(targetText) ||
        new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(targetText) ||
        new RegExp(`export\\s+default\\s+${name}\\b`).test(targetText);
      if (!exported) {
        add('error', file, 0, 'I2', `导入了 ${name}，但 ${path.basename(targetFile)} 没有导出它`);
      }
    }
  }
}

// ---------- 遍历 ----------
function checkFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    add('error', file, 0, 'I6', `读不了：${e.message}`);
    return;
  }
  const ext = path.extname(file);
  if (!SRC_EXT.has(ext)) return;
  checkContent(file, text);
  checkBalance(file, text);
  checkImports(file, text);
  checkExports(file, text);
}

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      walk(full);
    } else if (entry.isFile()) {
      if (SRC_EXT.has(path.extname(entry.name))) checkFile(full);
    }
  }
}

// ---------- 入口 ----------
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('用法: node selfcheck.mjs <file|--dir path>... [--json]');
  process.exit(2);
}
const asJson = args.includes('--json');
const targets = args.filter((a) => a !== '--json');

for (let i = 0; i < targets.length; i += 1) {
  const arg = targets[i];
  if (arg === '--dir') {
    const dir = targets[i + 1];
    if (!dir) { console.error('--dir 需要参数'); process.exit(2); }
    if (!fs.existsSync(dir)) { console.error(`目录不存在: ${dir}`); process.exit(2); }
    walk(dir);
    i += 1;
  } else {
    if (!fs.existsSync(arg)) { console.error(`文件不存在: ${arg}`); process.exit(2); }
    if (fs.statSync(arg).isDirectory()) walk(arg);
    else checkFile(arg);
  }
}

const errors = problems.filter((p) => p.severity === 'error');
const warns = problems.filter((p) => p.severity === 'warn');

if (asJson) {
  console.log(JSON.stringify({ ok: errors.length === 0, errors, warns }, null, 2));
} else {
  if (problems.length === 0) {
    console.log('自查通过：没有发现问题。');
    console.log('注意这只覆盖结构、引用和导出，逻辑正确性仍需实际运行验证。');
  } else {
    for (const p of problems) {
      const loc = p.line ? `:${p.line}` : '';
      console.log(`${p.severity === 'error' ? '✗' : '!'} [${p.invariant}] ${p.file}${loc}  ${p.message}`);
    }
    console.log(`\n共 ${problems.length} 条：${errors.length} 个必须修，${warns.length} 个建议检查。`);
  }
}
process.exit(errors.length === 0 ? 0 : 1);
