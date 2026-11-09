#!/usr/bin/env node
// scan-orphans.mjs —— 找出「写了但从来没人调用」的模块。
//
// 为什么需要它：这个项目最大的 bug 类不是写错代码，而是**机制在、接线无**。
// 已经发生过的例子：
//   - task-registry 状态机写完整了，但只有测试在调，运行时从不触发
//   - capability-status 读 `.tasks.json`，registry 写 `tasks.json`（差一个点）
//   - meow-memory 的 prompts/*.md 被剪枝当文档删掉，整层静默未激活
//   - auto-guard 的 writeStatus 写在 `if (!summary) return;` 之后，多数轮次根本不执行
// 这些都不会报错、不会崩溃，只是功能没用。人工 review 找不到它们，
// 因为每一处单看都是对的——错的是「谁也没叫它」这件事本身。
//
// 判据：一个模块如果没被任何 .mjs 引用，且它自己没有 CLI 守卫，
// 那它就是孤儿——要么忘了接线，要么该删。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '..');

/** 不参与扫描的目录：第三方代码、测试、本工具自身。 */
const SKIP_DIRS = new Set(['node_modules', 'test', 'tools', '.git', 'p1', 'proj1']);

/** 只认这几种引用写法，其余（比如注释里提到文件名）不算。 */
const REF_PATTERNS = [
  // import x from '...' / import '...' / import { a } from '...'
  /\bimport\s+(?:[^'"()]*?\bfrom\s+)?['"]([^'"]+)['"]/g,
  // export ... from '...'
  /\bexport\s+[^'"]*?\bfrom\s+['"]([^'"]+)['"]/g,
  // 动态 import('...')
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * `createRequire(import.meta.url)` 之后的调用可能是任意变量名。
 *
 * 这是最容易漏的一类：本项目大量用
 *   const req = createRequire(import.meta.url);
 *   req('../../runtime/capability-status.mjs');
 * 做「按需加载」（避免顶层 import 拖慢插件启动）。
 * 只匹配 `require(` 会把它们全部误判成孤儿——第一次跑这个扫描器时
 * 71 个"真孤儿"里绝大多数都是这么来的。
 *
 * 做法：先找出文件里所有 `const <name> = createRequire(...)` 的变量名，
 * 再把 `<name>('...')` 的调用当作引用。同时保留裸 require(...)。
 */
function requireAliases(text) {
  const names = new Set(['require']);
  for (const m of text.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*createRequire\s*\(/g)) {
    names.add(m[1]);
  }
  return [...names];
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile() && (e.name.endsWith('.mjs') || e.name.endsWith('.js'))) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** 从某个文件里抽出所有它引用的模块（解析成绝对路径）。 */
function refsOf(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const dir = path.dirname(file);
  const out = new Set();

  for (const re of REF_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) addSpec(m[1]);
  }

  // createRequire 的别名调用：`const req = createRequire(...); req('./x.mjs')`
  for (const name of requireAliases(text)) {
    const re = new RegExp(`\\b${name}\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) addSpec(m[1]);
  }

  function addSpec(spec) {
    // 只处理相对路径；裸模块名是 npm 包，不在本项目的孤儿判定范围内
    if (!spec.startsWith('.') && !spec.startsWith('/')) return;
    out.add(path.resolve(dir, spec));
  }
  return [...out];
}

/** 是不是「只在直接运行时才执行」的 CLI（有守卫就不算孤儿）。 */
function isCli(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  return /import\.meta\.url\s*===\s*pathToFileURL\s*\(\s*process\.argv\[1\]/.test(text)
    || /process\.argv\[1\]\s*&&.*import\.meta\.url/.test(text)
    || /invokedDirectly/.test(text);
}

/** 摘要：这个模块导出了什么（只取名字，不解析语义）。 */
function exportsOf(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const names = new Set();
  for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s+(?:const|let|var|class)\s+(\w+)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^\w+$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

/**
 * 入口文件：本来就不会被别人 import，不该算孤儿。
 *
 * 三类：
 *   - main.mjs / boot.mjs：进程入口，由宿主或构建脚本拉起
 *   - plugins/<name>/index.mjs：cordis 插件，由插件加载器按目录发现
 *   - skills/<name>/*.mjs 里带 CLI 守卫的：由用户命令触发（已在 isCli 里判）
 */
function isEntryPoint(file, engineDir) {
  const rel = path.relative(engineDir, file).split(path.sep).join('/');
  if (rel === 'main.mjs' || rel === 'boot.mjs') return true;
  if (/^plugins\/[^/]+\/index\.mjs$/.test(rel)) return true;
  // skills/<name>/*.mjs：技能自带的可执行脚本，由 agent 用 shell 调用
  // （`node skills/cost-guard/turns.mjs status`），本来就不该被 import。
  // 把它们算孤儿会淹没真正的问题——34 个"孤儿"里有 22 个是这一类。
  if (/^skills\/[^/]+\/[^/]+\.mjs$/.test(rel)) return true;
  // shims/：给原生模块打补丁，由构建脚本按路径注入，不经 import。
  if (/^shims\//.test(rel)) return true;
  return false;
}

export function scan(engineDir = ENGINE) {
  const files = walk(engineDir);

  // 引用收集必须覆盖**所有**文件，包括入口和插件。
  // 曾经的 bug：先把入口文件 continue 掉，于是 plugins/*/index.mjs 里的
  // 那 12 个 createRequire 引用一条都没被收集，它们加载的模块全被误报成孤儿。
  //
  // 每个文件只解析一次，结果放进 refs 表复用：
  //   1) 收集 refd 时用一遍，2) 判「自己只引用自己」时又用一遍。
  // 之前是各算一次，两处口径一旦分叉就会互相矛盾，所以合并成单一来源。
  const refs = new Map();
  const refd = new Set();
  for (const f of files) {
    const rs = refsOf(f);
    refs.set(f, rs);
    for (const r of rs) refd.add(r);
  }

  // 第二类「引用」：路径以**字符串**出现，不经过模块系统。
  //   - new Worker('./sync-helper.mjs')  /  new URL('./worker-main.mjs', import.meta.url)
  //   - 构建脚本里的 `node smoke.mjs`
  // 这些模块确实在用，只是没被 import。只认 import 会把它们误报成孤儿
  // （worker-main / sync-helper 就是这么被误判的：它们由 Worker 按路径拉起）。
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const dir = path.dirname(f);
    for (const m of text.matchAll(/['"]([^'"\n]*\.mjs)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
      refd.add(path.resolve(dir, spec));
    }
  }

  const orphans = [];
  const clis = [];
  const entries = [];
  const used = [];
  for (const f of files) {
    if (isEntryPoint(f, engineDir)) { entries.push(f); continue; }

    // 「自己引用自己不算被引用」——但**必须要求确实有引用**。
    //
    // 这里原来写的是 refsOf(f).every((r) => r === f)，漏了「非空」这个前提：
    // 空数组的 every() 恒为 true（vacuous truth），于是**所有零 import 的文件**
    // 都被判成 selfRefOnly，哪怕别人明明 import 了它。
    // capability-status / task-runner / schedule-bridge 这三个恰好只依赖 node:*
    // 内置模块、没有任何本地 import，于是被 auto-guard 的 createRequire 引用着
    // 却仍被报成「真孤儿」——正是最典型的「机制在、接线无」误报。
    //
    // 判据改成：有引用，且每一条都指向自己，才叫自引用。
    const own = refs.get(f) ?? [];
    const selfRefOnly = own.length > 0 && own.every((r) => r === f);

    if (!refd.has(f) || selfRefOnly) {
      (isCli(f) ? clis : orphans).push(f);
    } else {
      used.push(f);
    }
  }
  return {
    engineDir,
    orphans: orphans.sort(),
    clis: clis.sort(),
    entries: entries.sort(),
    used: used.sort(),
    counts: {
      total: files.length,
      orphans: orphans.length,
      clis: clis.length,
      entries: entries.length,
      used: used.length,
    },
  };
}

function rel(f, base) { return path.relative(base, f); }

function printHuman(r) {
  const base = r.engineDir;
  console.log(`引擎模块扫描 · ${base}`);
  console.log(`共 ${r.counts.total} 个 .mjs：被引用 ${r.counts.used} · 入口/技能/补丁 ${r.counts.entries} · 合法 CLI ${r.counts.clis} · 真孤儿 ${r.counts.orphans}`);
  console.log('');

  if (r.orphans.length > 0) {
    console.log(`真孤儿（${r.orphans.length} 个）—— 没人调用，也没打算被单独运行：`);
    for (const f of r.orphans) {
      const ex = exportsOf(f);
      console.log(`  ${rel(f, base)}`);
      if (ex.length) console.log(`      导出：${ex.join(', ')}`);
    }
    console.log('');
    console.log('这些要么忘了接线，要么该删。留着它们会让下一个人以为「这功能已经有了」。');
  } else {
    console.log('没有真孤儿。');
  }

  if (r.clis.length > 0) {
    console.log('');
    console.log(`合法 CLI（${r.clis.length} 个）—— 自己带运行守卫，不需要别人引用：`);
    for (const f of r.clis) console.log(`  ${rel(f, base)}`);
  }
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const json = process.argv.includes('--json');
  const r = scan();
  if (json) {
    console.log(JSON.stringify({
      engineDir: r.engineDir,
      counts: r.counts,
      orphans: r.orphans.map((f) => ({ file: rel(f, r.engineDir), exports: exportsOf(f) })),
      clis: r.clis.map((f) => rel(f, r.engineDir)),
    }, null, 2));
  } else {
    printHuman(r);
  }
}
