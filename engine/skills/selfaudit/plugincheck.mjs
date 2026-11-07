#!/usr/bin/env node
/**
 * 插件体检 —— 专治「我配了但没反应」。
 *
 * 为什么需要三层判据：这个 App 的插件挂在 engine/ios.patch.yml 的 - insert:
 * 下面。配置写了、依赖也装了，可引擎没重启、或者插件初始化时抛了异常，
 * 界面上不会有任何报错——用户只会觉得「我明明配了」。所以「配置里有一行」
 * 从来不等于「插件在跑」，中间每一层都得单独验，缺一层就会静默失败。
 *
 *   第一层 挂载：patch 里声明了没？声明指向的文件 / 包目录真的在吗？
 *                package.json 的 main / exports 指到的文件真的在吗？
 *   第二层 入口：入口文件自己的语法能不能被 Node 解析？再真 import() 一遍，
 *                把异常原样带出来——语法检查查不到「依赖解析失败」这一层，
 *                而这一层恰恰是最常见的「看起来有、实际没起来」。
 *   第三层 生效：CLI 里没有跑着的引擎，探不了活。这里只做代理判据——
 *                import() 成功且导出里有 apply / default / inject 之一，
 *                就记「入口可用」。**不等于已在 App 里生效**，输出里会写明。
 *
 * 为什么不用 yaml 库：ios.patch.yml 里有 `!!js process.env.XXX` 这种自定义
 * 标签，通用解析器会直接抛错；而这个文件结构固定（缩进 + `- insert:` 列表），
 * 按行读反而不会被引擎自己加的方言绊倒，也不引入任何依赖（本机没 npm）。
 *
 * 用法：
 *   node plugincheck.mjs [引擎目录]
 *   node plugincheck.mjs --patch 文件.yml [--engine 引擎目录]
 *   node plugincheck.mjs --json
 *   node plugincheck.mjs --help
 *
 * 退出码：0 全部就绪；1 有失败或有可疑；2 用法错误（参数 / 路径不对）。
 * 可疑为什么也算 1：只要有一个插件没能被确认，就不是「全部就绪」；
 * 把可疑算成 0 等于替它签字，正是这个工具要防的那件事。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// 工具住在 engine/skills/selfaudit/ 下，往上两级就是随包分发的 engine/。
// 默认指向它，等于「不带参数就能查这台设备真正要跑的那份配置」。
const DEFAULT_ENGINE = path.resolve(here, '..', '..');

const results = [];

/** 和 selfaudit.mjs 一个规矩：检查项先记下来，最后统一渲染 + 汇总。 */
// 空跑开关：体检本身只读不写，这个开关是为了和其他工具保持一致的调用方式。
const GO = process.argv.includes('--go');

function report(id, kind, level, detail, fix) {
  results.push({ id, kind, level, detail, fix });
}

// ---------- 第一层：解析挂载清单 ----------

/**
 * 只切掉 YAML 的行尾注释。引号里的 # 必须留着，否则 name 里带 # 的包名会被
 * 拦腰截断；`!!js` 那一行没有引号也没有 #，会原样保留（但它在 insert 之外，
 * 解析器根本不看，这正是按行解析的好处）。
 */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === quote && line[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/** 去掉 YAML 标量的包裹引号；name 只可能是普通字符串，不需要处理转义序列。 */
function scalar(raw) {
  const v = raw.trim();
  if (v.length >= 2 &&
      ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * 只认 - insert: 块里的 `- id:` / `name:` 对。文件上半部分那一堆
 * `- id: xxx / disabled: true` 是「关掉官方插件」的指令，不是要加载的插件；
 * 把它们也算进来会凭空多出十几条假失败。
 */
function parsePatch(patchFile) {
  const text = fs.readFileSync(patchFile, 'utf8');
  const entries = [];
  let inInsert = false;
  let insertIndent = -1;
  let cur = null;
  let pendingName = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line.trim()) continue; // 注释行 / 空行不结束块，否则中文注释会把块切断
    const indent = (line.match(/^ */) || [''])[0].length;
    const body = line.trimStart();

    if (/^-\s*insert\s*:\s*$/.test(body) || /^insert\s*:\s*$/.test(body)) {
      inInsert = true;
      insertIndent = indent;
      cur = null;
      pendingName = null;
      continue;
    }
    // 回到与 - insert: 同级（或更外层）的非注释行，说明这个块结束了。
    if (inInsert && indent <= insertIndent) {
      inInsert = false;
      cur = null;
      pendingName = null;
    }
    if (!inInsert) continue;

    const idMatch = /^-\s*id\s*:\s*(.*)$/.exec(body);
    if (idMatch) {
      cur = { id: scalar(idMatch[1]), name: pendingName };
      pendingName = null;
      entries.push(cur);
      continue;
    }
    const nameMatch = /^name\s*:\s*(.*)$/.exec(body);
    if (nameMatch) {
      const v = scalar(nameMatch[1]);
      if (cur) cur.name = v;
      else pendingName = v; // 容忍 name 写在 id 前面的写法
    }
  }
  return entries;
}

/** 显示宽度：中文占两列，直接 padEnd 会让表格歪掉。 */
function dw(s) {
  return String(s).replace(/[^\x00-\xff]/g, 'xx').length;
}
function pad(s, n) {
  const d = dw(s);
  return d >= n ? s : s + ' '.repeat(n - d);
}

// ---------- 定位入口文件 ----------

/**
 * exports 允许字符串 / 条件对象 / 数组层层嵌套。按 Node 的偏好顺序挑一个：
 * 根导出 "." 优先，其次 import > module > default > node > require。
 * 只挑目标字符串，不做条件求值——体检要回答的是「指到的文件在不在」。
 */
function pickExportTarget(exp) {
  if (typeof exp === 'string') return exp;
  if (Array.isArray(exp)) {
    for (const x of exp) { const t = pickExportTarget(x); if (t) return t; }
    return null;
  }
  if (exp && typeof exp === 'object') {
    if ('.' in exp) return pickExportTarget(exp['.']);
    for (const k of ['import', 'module', 'default', 'node', 'require']) {
      if (k in exp) { const t = pickExportTarget(exp[k]); if (t) return t; }
    }
    for (const v of Object.values(exp)) { const t = pickExportTarget(v); if (t) return t; }
  }
  return null;
}

/** 把一个包内相对路径变成真实绝对路径；顺手挡掉 ../ 越出包目录的写法。 */
function insidePkg(pkgDir, rel) {
  const clean = String(rel).replace(/^\.\//, '');
  const abs = path.resolve(pkgDir, clean);
  return abs === pkgDir || abs.startsWith(pkgDir + path.sep) ? abs : null;
}

/**
 * 解析 npm 包的入口。exports 一旦存在就是权威（Node 会因此屏蔽 main），
 * 所以有 exports 时不再退回 main——退回会给出一个引擎根本不会去加载的文件。
 */
function resolvePackage(pkgName, engineDir) {
  const pkgDir = path.join(engineDir, 'node_modules', pkgName);
  const show = (rel) => `node_modules/${pkgName}/${rel}`;
  if (!fs.existsSync(pkgDir) || !fs.statSync(pkgDir).isDirectory()) {
    return { fail: `✗ 目录不存在：${show('').replace(/\/$/, '')}`, fix: `先装 ${pkgName}，或把 name 改成 ./ 开头的本地路径。` };
  }
  const pjFile = path.join(pkgDir, 'package.json');
  let pj;
  try {
    pj = JSON.parse(fs.readFileSync(pjFile, 'utf8'));
  } catch (e) {
    return { fail: `✗ package.json 读不了：${show('package.json')}（${e.message}）`, fix: '包不完整，重装一次。' };
  }

  const candidates = [];
  if (pj.exports !== undefined) {
    const t = pickExportTarget(pj.exports);
    if (t) candidates.push(t);
  } else {
    if (pj.main) candidates.push(pj.main);
    candidates.push('index.js', 'index.mjs', 'index.cjs');
  }
  if (!candidates.length) {
    return { fail: `✗ package.json 没给 exports / main：${show('package.json')}`, fix: '补全入口字段。' };
  }

  for (const rel of candidates) {
    const abs = insidePkg(pkgDir, rel);
    if (!abs) continue;
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return { entry: abs, rel, pkgDir };
    // main / exports 指向目录时 Node 会找目录里的 index，跟着做一遍。
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      for (const idx of ['index.js', 'index.mjs', 'index.cjs']) {
        const f = path.join(abs, idx);
        if (fs.existsSync(f)) return { entry: f, rel: path.join(rel, idx), pkgDir };
      }
    }
  }
  return {
    fail: `✗ 入口文件缺失：${show(candidates[0])}`,
    fix: 'package.json 指向的文件不在包里；包被裁剪过或版本不对，重装 / 换版本。',
  };
}

// ---------- 第二层：语法 + 真 import() ----------

/**
 * 语法检查用 Node 自己判，不自己写正则猜括号。
 * 先按文件真实位置判（.mjs / 最近 package.json 的 type 都会被 Node 认出来）；
 * 万一文件位置判定失败但按 ESM 读又是对的，说明是「模块类型」而不是「语法」问题，
 * 这两种错误的修法完全不同，不能混成一句「语法错误」。
 */
function checkSyntax(abs) {
  let src;
  try { src = fs.readFileSync(abs, 'utf8'); }
  catch (e) { return { level: 'fail', detail: `✗ 入口读不了：${e.message}` }; }

  const atFile = spawnSync(process.execPath, ['--no-warnings', '--check', abs], { encoding: 'utf8', timeout: 15000 });
  if (atFile.status === 0) return { ok: true };

  const asEsm = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '--check'],
    { input: src, encoding: 'utf8', timeout: 15000 });
  const msg = (s) => String(s || '').split('\n').filter((l) => /\b(SyntaxError|Error):/.test(l))[0]?.trim() || '';
  if (asEsm.status === 0) {
    return { level: 'warn', detail: `⚠ 按 ESM 语法合格，但按文件位置 --check 不通过：${msg(atFile.stderr) || '模块类型判定不一致'}` };
  }
  return { level: 'fail', detail: `✗ 语法错误：${msg(asEsm.stderr) || msg(atFile.stderr) || 'Node 无法解析'}` };
}

/**
 * 真加载放进子进程，理由有三个，都是会咬人的：
 *   1. 插件顶层可能 await 一个永不到来的东西 / 起定时器，主进程会被拖死；
 *   2. 插件可能 process.exit()，体检自己就没了，汇总都打不出来；
 *   3. 五个插件互相污染模块缓存，前一个的 import 失败会被后一个掩盖。
 * 探针把结果打成一行 JSON，父进程只认这一行，stderr 留作错误现场。
 */
const PROBE = `
const out = (o) => { process.stdout.write('PLUGINCHECK_JSON:' + JSON.stringify(o) + '\\n'); };
try {
  const ns = await import(process.env.PLUGINCHECK_ENTRY);
  const keys = Object.keys(ns);
  const has = ['apply', 'default', 'inject'].filter((k) => k in ns);
  // parts 只写模块命名空间上真实导出的那几个，和第一层的判据一一对应；
  // shape 额外记下 default（class）上的 static inject / apply，供 --verbose 参考。
  // 两者分开，是为了让「为什么判它可用」能在输出里一眼复核，不掺推断。
  const parts = [];
  const shape = [];
  for (const k of has) {
    if (k === 'inject') {
      const v = ns.inject;
      parts.push(Array.isArray(v) && v.length ? 'inject: ' + v.join(',') : 'inject');
    } else parts.push(k);
  }
  const d = ns.default;
  // 必须用「自有属性」而不是 in 操作符：class 也是函数，Function.prototype
  // 上本来就有 apply/bind/call，用 in 会把它们当成插件钩子，凭空判成可用。
  const ownHook = (k) => {
    if (d == null) return undefined;
    try {
      if (typeof d === 'function' || typeof d === 'object') {
        if (Object.hasOwn(d, k)) return d[k];
        if (d.prototype && Object.hasOwn(d.prototype, k)) return d.prototype[k];
      }
    } catch { /* Proxy 之类的 exotic 对象，取不到就算没有 */ }
    return undefined;
  };
  const inj = ownHook('inject');
  if (inj !== undefined && !has.includes('inject')) {
    shape.push(Array.isArray(inj) && inj.length ? 'inject: ' + inj.join(',') : 'inject');
  }
  const ap = ownHook('apply');
  if (typeof ap === 'function' && !has.includes('apply')) shape.push('apply');
  out({ ok: true, has, parts, shape, exportCount: keys.length, keys: keys.slice(0, 40) });
} catch (e) {
  out({ ok: false, error: { name: e?.name || 'Error', code: e?.code || '',
        message: String(e?.message || e || '').split('\\n')[0] } });
}
`;

/**
 * 从 ERR_MODULE_NOT_FOUND 里抠出缺哪个包。这条信息决定了「改配置」还是
 * 「补依赖」——不给出来的话，用户只会看到一句「加载失败」然后继续瞎猜。
 */
function missingSpecifier(message) {
  const m = /Cannot find package '([^']+)'/.exec(message) ||
            /Cannot find module '([^']+)'/.exec(message) ||
            /Failed to resolve "([^"]+)"/.exec(message);
  return m ? m[1] : null;
}

/** 依赖在 package.json / package-lock.json 里声明过没？用来区分「没配」和「本机没装全」。 */
function declaredElsewhere(engineDir, spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/')) return false;
  for (const f of ['package.json', 'package-lock.json']) {
    const p = path.join(engineDir, f);
    if (!fs.existsSync(p)) continue;
    try {
      const text = fs.readFileSync(p, 'utf8');
      if (text.includes(`"${spec}"`) || text.includes(`"node_modules/${spec}"`)) return true;
    } catch { /* 读不了就当没声明，别替用户乐观 */ }
  }
  return false;
}

function probeImport(abs, engineDir) {
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', PROBE], {
    cwd: engineDir,
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PLUGINCHECK_ENTRY: pathToFileURL(abs).href },
  });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('PLUGINCHECK_JSON:'));
  if (r.error?.code === 'ETIMEDOUT' || r.signal) {
    return { level: 'fail', detail: '✗ import() 超时 / 被杀：入口顶层可能 await 了永不返回的东西',
      fix: '别在模块顶层做网络请求或等事件；把初始化挪到 apply() 里。' };
  }
  if (!line) {
    const tail = String(r.stderr || '').trim().split('\n').slice(-2).join(' ').trim();
    return { level: 'fail', detail: `✗ import() 没返回结果：${tail || '探针进程异常退出'}`, fix: '单独跑一遍 node 入口看报错。' };
  }
  let data;
  try { data = JSON.parse(line.slice('PLUGINCHECK_JSON:'.length)); }
  catch { return { level: 'fail', detail: '✗ 探针输出不是合法 JSON' }; }
  if (!data.ok) {
    const e = data.error;
    const spec = missingSpecifier(e.message);
    const declared = declaredElsewhere(engineDir, spec);
    const head = `✗ import() 失败：${e.code || e.name}`;
    const why = spec ? `缺 ${spec}${declared ? '（package.json/package-lock.json 里有声明，本机 node_modules 被裁剪；App 包里带上才能加载）' : '（未在任何依赖声明里找到）'}` : e.message;
    // 依赖声明过、只是这份精简 node_modules 没装全时，归为「可疑」而不是「失败」：
    // 引擎打包时会把 peer 依赖装进去，判死会让真实配置平白多两条红叉，
    // 但完全放过又会把「缺依赖」这个坑重新盖住。可疑 = 明确说清「本机验不了」。
    const level = declared && e.code === 'ERR_MODULE_NOT_FOUND' ? 'warn' : 'fail';
    return {
      level,
      detail: `${level === 'warn' ? '○ 本机缺依赖' : head} — ${why}`,
      fix: declared
        ? '确认 App 打包时把这个 peer 依赖装进了最终 node_modules；本机这份精简目录跑不起来，不代表配置写错了。'
        : '补依赖，或检查 name 是否指错了包。',
      error: e, spec, declared,
    };
  }
  return { loaded: true, ...data };
}

// ---------- 单个插件的三层判据 ----------

function auditOne(entry, engineDir) {
  const { id, name } = entry;
  const label = id || '（缺 id）';

  if (!name) {
    report(label, '未知', 'fail', '✗ 没写 name', 'insert 里每条都要有 name：本地路径或包名。');
    return;
  }

  const local = /^\.{1,2}\//.test(name) || path.isAbsolute(name);
  const kind = local ? '本地插件' : 'npm 包';

  let target;
  if (local) {
    // 相对路径按引擎目录算，不按调用时的 cwd —— 引擎启动时 cwd 是 iOS 的数据目录，
    // 跟着调用者走会查到完全不同的树上，得出「明明有文件却说没有」的假失败。
    const abs = path.isAbsolute(name) ? name : path.resolve(engineDir, name);
    if (!fs.existsSync(abs)) {
      report(label, kind, 'fail', `✗ 文件不存在：${name}`, '确认路径拼写，或把插件文件放回声明的位置。');
      return;
    }
    if (!fs.statSync(abs).isFile()) {
      // 目录存在但没有入口，也是「看起来有、实际没起来」的一类，不能放过。
      const idx = ['index.mjs', 'index.js', 'index.cjs']
        .map((n) => path.join(abs, n)).find((f) => fs.existsSync(f));
      if (!idx) {
        report(label, kind, 'fail', `✗ 入口文件缺失：${name} 是目录，里面没有 index.mjs/js/cjs`,
          '把 name 指到具体文件，或在目录里补一个 index.mjs。');
        return;
      }
      target = { entry: idx, rel: name + '/' + path.basename(idx) };
    } else {
      target = { entry: abs, rel: name };
    }
  } else {
    const pkg = resolvePackage(name, engineDir);
    if (pkg.fail) { report(label, kind, 'fail', pkg.fail, pkg.fix, { pkgName: name }); return; }
    target = { entry: pkg.entry, rel: pkg.rel, pkgDir: pkg.pkgDir, pkgName: name };
  }

  const meta = {
    entry: target.entry,
    declared: name,
    pkgDir: target.pkgDir || null,
    rel: target.rel,
  };

  const syn = checkSyntax(target.entry);
  if (!syn.ok) {
    report(label, kind, syn.level, syn.detail,
      syn.level === 'fail' ? '先修语法：node --check 入口文件，按报错改到通过。' : '给包补 "type": "module"，或把入口改成 .mjs。', meta);
    return;
  }

  const loaded = probeImport(target.entry, engineDir);
  if (!loaded.loaded) {
    report(label, kind, loaded.level, loaded.detail, loaded.fix, { ...meta, error: loaded.error });
    return;
  }
  // 第三层只做代理判据：能不能加载 + 有没有引擎认得的导出形状。
  // 真生效要引擎在跑、且已经重启过，CLI 连不上那个进程，所以绝不写「已生效」。
  if (!loaded.has.length) {
    report(label, kind, 'warn', '⚠ 入口可加载但没导出 apply/default/inject',
      'DSH 靠这三个之一把插件接进管线；补一个导出，否则加载了也不会被调用。', { ...meta, exports: loaded.keys });
    return;
  }
  report(label, kind, 'ok', `入口可用（${loaded.parts.join(' + ')}）`, null,
    { ...meta, exports: loaded.keys, has: loaded.has, shape: loaded.shape });
}

// ---------- 入口 / 参数 ----------

const HELP = `插件体检 —— 检查 ios.patch.yml 里挂的插件是不是真的能起来

用法：
  node plugincheck.mjs [选项]

选项：
  --patch <文件>    要检查的 patch 文件（默认 <引擎目录>/ios.patch.yml）
  --engine <目录>   引擎根目录，决定 ./plugins/... 和 node_modules/ 在哪
                    （默认脚本所在 engine/，即 skills/selfaudit/ 往上两级）
  --json            输出机器可读结果（含每个插件解析出的入口绝对路径）
  --verbose         每条下面多打一行入口路径和导出的符号
  --help            显示本说明

三层判据：挂载（声明 + 文件/包/入口在不在）→ 入口（--check + 真 import()）
         → 生效（CLI 里只能判「入口可用」，真生效必须在 App 里跑起来确认）

退出码：0 全部就绪；1 有失败或有可疑；2 用法错误。
`;

function usageError(msg) {
  console.error(`用法错误：${msg}`);
  console.error('跑 node plugincheck.mjs --help 看用法。');
  process.exit(2);
}

function parseArgs(argv) {
  const o = { patch: null, engine: null, json: false, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    if (a === '--json') { o.json = true; continue; }
    if (a === '--verbose' || a === '-v') { o.verbose = true; continue; }
    if (a === '--patch' || a === '--engine') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) usageError(`${a} 后面要跟一个路径`);
      if (a === '--patch') o.patch = path.resolve(v); else o.engine = path.resolve(v);
      i += 1;
      continue;
    }
    usageError(`不认识的参数：${a}`);
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { console.log(HELP); process.exit(0); }

const engineDir = opts.engine || DEFAULT_ENGINE;
const patchFile = opts.patch || path.join(engineDir, 'ios.patch.yml');

// 参数、路径不对是用法错误，不是「插件坏了」——分开报，
// 否则用户看到一堆 ✗ 却不知道其实只是自己把路径写错了。
if (!fs.existsSync(engineDir) || !fs.statSync(engineDir).isDirectory()) usageError(`引擎目录不存在或不是目录：${engineDir}`);
if (!fs.existsSync(patchFile) || !fs.statSync(patchFile).isFile()) usageError(`patch 文件不存在：${patchFile}`);

let entries;
try { entries = parsePatch(patchFile); }
catch (e) { usageError(`读不了 patch 文件：${e.message}`); }

for (const e of entries) auditOne(e, engineDir);

// ---------- 输出 ----------

const okCount = results.filter((r) => r.level === 'ok').length;
const failCount = results.filter((r) => r.level === 'fail').length;
const warnCount = results.filter((r) => r.level === 'warn').length;
// 退出码只看 fail，不看 warn。
// 「本机缺依赖」不是失败：package-lock 里声明了、App 打包时会装，
// 只是这份精简的 node_modules 里没有。把它算成失败会让这个检查天天误报，
// 而天天误报的检查最后一定被忽略——那就等于没有检查。
const exitCode = failCount ? 1 : 0;

// patch 路径尽量显示成相对路径，绝对路径一长就把表格挤出屏幕了。
const shownPatch = path.relative(process.cwd(), patchFile);
const patchLabel = !shownPatch.startsWith('..') && !path.isAbsolute(shownPatch) ? shownPatch : patchFile;

if (opts.json) {
  console.log(JSON.stringify({
    patch: patchFile, engine: engineDir, total: results.length,
    ready: okCount, failed: failCount, suspicious: warnCount,
    exitCode,
    note: '「入口可用」只代表 Node 能加载且导出了 apply/default/inject；实际生效需要在 App 里跑起来确认。',
    results: results.map((r) => ({
      id: r.id, kind: r.kind, level: r.level, detail: r.detail, fix: r.fix,
      entry: r.meta?.entry || null, declared: r.meta?.declared || null,
      pkgDir: r.meta?.pkgDir || null, exports: r.meta?.exports || null,
      shape: r.meta?.shape || null, error: r.meta?.error || null,
    })),
  }, null, 2));
} else {
  console.log(`插件体检（${patchLabel}）`);
  console.log('');
  for (const r of results) {
    const mark = r.level === 'ok' ? '✓' : r.level === 'warn' ? '⚠' : '✗';
    console.log(`${mark} ${pad(r.id, 18)}${pad(r.kind, 12)}${r.detail}`);
    if (opts.verbose && r.meta?.entry) {
      console.log(`   入口：${r.meta.entry}${r.meta.exports ? `　导出：${r.meta.exports.slice(0, 8).join(', ')}${r.meta.exports.length > 8 ? ' …' : ''}` : ''}`);
    }
    if (r.level !== 'ok' && r.fix) console.log(`   → ${r.fix}`);
  }
  console.log('');
  console.log(`${results.length} 个插件：${okCount} 个就绪，${failCount} 个失败，${warnCount} 个本机缺依赖`);
  if (!results.length) console.log('没解析到任何插件：检查是不是指错了 patch 文件，或 - insert: 的缩进被改坏了。');
  // 这句必须留着。少了它，「入口可用」就会被读成「插件已生效」——
  // 而这正是最初要解决的那个错觉。
  console.log('说明：「入口可用」只代表 Node 能加载且导出了 apply/default/inject；');
  console.log('      实际生效需要引擎重启后在 App 里确认（本工具跑在 CLI，连不上运行中的引擎）。');
  if (failCount || warnCount) {
    console.log('失败项已给出处理办法，别当作已通过。');
    console.log('○ 标记的是「本机缺依赖」：package-lock 里声明了，但本机 node_modules 被裁剪。');
    console.log('  它不是失败——App 打包时 npm install 会装上。真要确认得在 App 里跑起来看。');
  }
}

process.exit(exitCode);
