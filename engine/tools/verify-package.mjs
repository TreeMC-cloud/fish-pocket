#!/usr/bin/env node
// verify-package.mjs —— 核对「打进包里的引擎」与「仓库里的引擎」是不是同一份代码。
//
// 为什么需要它（2026-11-09 的真实事故）：
//   scripts/build-engine.sh 原来是「只要有缓存 tar 就展开并 exit 0」，
//   于是 cp -R "$src/plugins" 那一整段被静默跳过。结果：
//     仓库 engine/plugins/auto-guard/index.mjs = 1238 行（有 onTurnEnd）
//     打进 App 的 nodejs-project/plugins/auto-guard/index.mjs = 186 行的旧版
//   构建成功、签名成功、装上能启动、能对话 —— 但跑的是旧代码。
//   这类失败在日志里没有任何特征，唯一靠得住的判据是：
//   把**包内实际的字节**和**仓库当前的字节**逐个对一遍。
//
//   缓存现在加了源码指纹，但指纹只说明「这次构建读了哪份源码」，
//   说明不了「手上这个 IPA 是哪次构建产出的」：IPA 可能是旧的、可能是别的机器
//   出的、可能有人手工替换过 nodejs-project。所以核对必须独立于构建链：
//   不解析构建日志、不相信构建脚本的自述，只认包里的内容。
//
// 判据：逐文件 sha256。不比「文件在不在」，也不比「大小」——
//   大小相同而内容不同（改了一行常量、一句注释）是真实会发生的，只比大小会漏。
//
// 用法：
//   node engine/tools/verify-package.mjs <ipa路径 | 已解包目录> [--json] [--engine <engine目录>]
//
// 退出码：0 = 一致 · 1 = 不一致（内容不同或有缺失）· 2 = 用法/读取错误

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENGINE = path.resolve(HERE, '..'); // engine/tools/ 的上一级就是 engine/

// ── 会被打进包的文件清单 ───────────────────────────────────────────────
// 必须与 scripts/build-engine.sh 的 cp 一一对应；那边改了这里就要改。
// 为什么硬编码而不去解析脚本：脚本里 cp 前后夹着 npm install、三处剪枝、
// 一段 python 注入、一次 smoke 冒烟，解析 shell 的失败方式比硬编码多得多，
// 而解析失败会伪装成"一致"——正是这个工具要防的那类静默错误。
const ROOT_FILES = ['package.json', 'main.mjs', 'boot.mjs', 'ios.patch.yml'];
// 脚本里带 [ -f ] 守卫的三个：仓库有才拷，没有也不算缺失。
const ROOT_FILES_IF_EXISTS = ['smoke.mjs', 'AGENTS.md', 'package-lock.json'];
const COPY_DIRS = ['plugins', 'shims', 'runtime', 'skills'];

// 这些不是"源码"：node_modules 是 npm install 的产物（天然和仓库不一致），
// .engine-cache 是构建缓存，.git/.DS_Store 是本地环境垃圾。
const SKIP_NAMES = new Set(['node_modules', '.git', '.engine-cache', '.DS_Store']);

const CHUNK = 1 << 20; // 1MB：IPC 里读压缩数据的最小单位，够大又不至于吃内存

class UsageError extends Error {}

// ── 小工具 ─────────────────────────────────────────────────────────────

/** 按绝对位置读一段字节。zip 是随机访问格式，只能这样读，不能顺序流。 */
function readAt(fd, pos, len) {
  const buf = Buffer.allocUnsafe(Math.max(0, len));
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got);
    if (n <= 0) break;
    got += n;
  }
  return got === len ? buf : buf.subarray(0, got);
}

/** 仓库侧文件哈希：流式读，避免把大文件整个吞进内存。 */
function sha256File(abs) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let n;
    while ((n = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: h.digest('hex'), size: fs.statSync(abs).size, mtime: fs.statSync(abs).mtime.toISOString() };
}

// ── IPA = zip：自带最小 zip 读取器 ─────────────────────────────────────
// 为什么不用 unzip 命令：一是 iSH/CI 上不保证有，二是一次解包 100MB+ 的 IPA
// 只为读 130 个文件太浪费；直接按中央目录定位、只解需要的那几个条目，
// 114MB 的包也是秒级。只用 node 内置模块（zlib 负责 deflate）。
class ZipArchive {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'r');
    this.size = fs.fstatSync(this.fd).size;
    this.entries = new Map();
    this.#readDirectory();
  }

  #readDirectory() {
    // EOCD 在文件末尾，后面可能跟着 zip 注释（最长 65535），所以往回找 64K+22。
    const tailLen = Math.min(this.size, 22 + 0xffff);
    const tail = readAt(this.fd, this.size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new UsageError(`不是 zip 文件（找不到 EOCD 记录）：${this.file}`);

    let total = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOff = tail.readUInt32LE(eocd + 16);

    // ZIP64：条目数 >65535 或偏移 >4GB 时这三项是哨兵值 0xFFFF/0xFFFFFFFF，
    // 真值在 EOCD 前面的 zip64 记录里。真实 IPA 会踩到（10 万+ 条目的包），
    // 不处理的话会读出一堆垃圾偏移，表现为"文件全部缺失"——比报错更误导人。
    if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      const loc = eocd >= 20 ? tail.subarray(eocd - 20, eocd) : Buffer.alloc(0);
      if (loc.length === 20 && loc.readUInt32LE(0) === 0x07064b50) {
        const z64Off = Number(loc.readBigUInt64LE(8));
        const z = readAt(this.fd, z64Off, 56);
        if (z.length >= 56 && z.readUInt32LE(0) === 0x06064b50) {
          total = Number(z.readBigUInt64LE(32));
          cdSize = Number(z.readBigUInt64LE(40));
          cdOff = Number(z.readBigUInt64LE(48));
        }
      }
    }

    const cd = readAt(this.fd, cdOff, cdSize);
    let p = 0;
    for (let i = 0; i < total; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) {
        throw new UsageError(`zip 中央目录损坏（第 ${i} 条记录）`);
      }
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');

      // ZIP64 扩展字段（id=0x0001）：只补那些是 0xFFFFFFFF 的，顺序固定 8/8/8。
      if (size === 0xffffffff || compSize === 0xffffffff || offset === 0xffffffff) {
        let ep = p + 46 + nameLen;
        const end = ep + extraLen;
        while (ep + 4 <= end) {
          const id = cd.readUInt16LE(ep);
          const len = cd.readUInt16LE(ep + 2);
          if (id === 0x0001) {
            let q = ep + 4;
            if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (offset === 0xffffffff) { offset = Number(cd.readBigUInt64LE(q)); q += 8; }
            break;
          }
          ep += 4 + len;
        }
      }

      this.entries.set(name, { name, method, compSize, size, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    this.cdCount = total;
  }

  get(name) { return this.entries.get(name); }

  /** 数据起点必须从**本地**文件头算：本地头的 name/extra 长度可以和中央目录不同。 */
  dataOffset(e) {
    const h = readAt(this.fd, e.offset, 30);
    if (h.length < 30 || h.readUInt32LE(0) !== 0x04034b50) {
      throw new UsageError(`zip 本地文件头损坏：${e.name}`);
    }
    return e.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  }

  close() { try { fs.closeSync(this.fd); } catch { /* 关不掉不影响结论 */ } }
}

// ── 读一个 zip 条目的内容 ───────────────────────────────────────────────
/**
 * 把条目解压后的字节一截截交给 onData。
 *
 * 为什么手写"读一块 → 喂给 inflate"的循环，而不用 inflateRawSync：
 * 一个条目在内存里解压后可能上百 MB（node_modules 里的东西），
 * 而这里只需要逐块算哈希 / 取前几 MB，流式处理不会把手机内存打爆。
 */
function pumpEntry(zip, e, onData) {
  return new Promise((resolve, reject) => {
    let pos = zip.dataOffset(e);
    let left = e.compSize;
    let out = 0;
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const feed = (buf) => { out += buf.length; onData(buf); };

    if (e.method === 0) { // 存储（未压缩）
      while (left > 0) {
        const buf = readAt(zip.fd, pos, Math.min(left, CHUNK));
        if (buf.length === 0) return done(reject, new Error(`zip 数据被截断：${e.name}`));
        feed(buf);
        pos += buf.length;
        left -= buf.length;
      }
      return done(resolve, out);
    }
    if (e.method !== 8) {
      // 打包工具理论上可以用 bzip2/lzma/zstd，但 iOS IPA 只会是 store/deflate。
      return done(reject, new Error(`不支持的压缩方式 ${e.method}：${e.name}`));
    }

    const inf = zlib.createInflateRaw();
    inf.on('data', feed);
    inf.on('error', (err) => done(reject, err));
    inf.on('end', () => done(resolve, out));
    const pump = () => {
      while (left > 0) {
        const buf = readAt(zip.fd, pos, Math.min(left, CHUNK));
        if (buf.length === 0) return inf.destroy(new Error(`zip 数据被截断：${e.name}`));
        pos += buf.length;
        left -= buf.length;
        if (!inf.write(buf)) { inf.once('drain', pump); return; } // 背压：inflate 还没消化完
      }
      inf.end();
    };
    pump();
  });
}

async function hashEntry(zip, e) {
  const h = crypto.createHash('sha256');
  const size = await pumpEntry(zip, e, (b) => h.update(b));
  return { sha256: h.digest('hex'), size };
}

/** 只取前 cap 字节，够判断"哪几行开始不一样"就行。 */
async function readEntry(zip, e, cap) {
  const chunks = [];
  let total = 0;
  let truncated = false;
  await pumpEntry(zip, e, (b) => {
    if (total >= cap) { truncated = true; return; }
    const keep = b.subarray(0, cap - total);
    chunks.push(Buffer.from(keep)); // 复制一份：readAt 的 buffer 会被下一轮覆盖
    total += keep.length;
    if (keep.length < b.length) truncated = true;
  });
  return { buf: Buffer.concat(chunks, total), truncated };
}

// ── 仓库侧：哪些文件会被 cp 进包 ────────────────────────────────────────
function collectRepoFiles(engineDir) {
  const out = new Map(); // rel(正斜杠) -> 绝对路径

  const add = (rel, abs, optional) => {
    let st = null;
    try { st = fs.statSync(abs); } catch { /* 不存在 */ }
    if (!st || !st.isFile()) {
      if (optional) return;
      throw new UsageError(`仓库里缺少构建必拷的文件：engine/${rel}（build-engine.sh 会无条件 cp 它）`);
    }
    out.set(rel, abs);
  };

  for (const f of ROOT_FILES) add(f, path.join(engineDir, f), false);
  for (const f of ROOT_FILES_IF_EXISTS) add(f, path.join(engineDir, f), true);

  for (const d of COPY_DIRS) {
    const root = path.join(engineDir, d);
    if (!fs.existsSync(root)) {
      throw new UsageError(`仓库里缺少目录：engine/${d}/（build-engine.sh 会 cp -R 它）`);
    }
    walk(root, d, out);
  }
  return out;
}

function walk(dir, relDir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) walk(abs, rel, out);
    else out.set(rel, abs); // 符号链接也按「文件」处理：cp -R 拷的是链接，读出来是目标内容
  }
}

// ── 定位包内引擎树 ─────────────────────────────────────────────────────
/**
 * 找到包里的 nodejs-project 树。
 * 支持四种输入：IPA 文件、含 Payload/ 的解包目录、.app 目录本身、nodejs-project 本身。
 */
function locatePackage(target) {
  const st = fs.statSync(target); // 不存在会抛 ENOENT，由 main 转成可读的错误
  if (st.isDirectory()) {
    const candidates = [];
    const pushApps = (base) => {
      let names = [];
      try { names = fs.readdirSync(base); } catch { return; }
      for (const n of names) {
        if (!n.endsWith('.app')) continue;
        candidates.push(path.join(base, n, 'nodejs-project'));
      }
    };
    candidates.push(path.join(target, 'nodejs-project'));
    candidates.push(path.join(target, 'Payload', 'DshIOS.app', 'nodejs-project'));
    pushApps(path.join(target, 'Payload'));
    pushApps(target);

    for (const c of candidates) {
      if (isNodejsProject(c)) return { kind: 'dir', root: c, label: c };
    }
    throw new UsageError(
      `在 ${target} 下找不到 nodejs-project（找过：./nodejs-project、Payload/*.app/nodejs-project）`,
    );
  }

  // 文件：按 zip 处理（IPA 就是 zip）
  const zip = new ZipArchive(target);
  // 兼容任意 app 名：Payload/<X>.app/nodejs-project/。取第一个命中的前缀。
  let prefix = null;
  for (const name of zip.entries.keys()) {
    const m = /^(Payload\/[^/]+\.app\/nodejs-project\/)/.exec(name);
    if (m) { prefix = m[1]; break; }
  }
  if (!prefix) {
    zip.close();
    throw new UsageError(`包里没有 Payload/*.app/nodejs-project/：${target}（确认这是个 iOS IPA，而不是别的 zip）`);
  }
  return { kind: 'zip', zip, root: prefix, label: prefix, prefix };
}

function isNodejsProject(dir) {
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return false;
  } catch { return false; }
  // 判据用 main.mjs + package.json 同时存在：单看目录名会把空壳目录当成命中。
  return fs.existsSync(path.join(dir, 'main.mjs')) && fs.existsSync(path.join(dir, 'package.json'));
}

// ── 取内容（只为解释差异，不参与判定）──────────────────────────────────
function readRepoFile(abs, cap) {
  const st = fs.statSync(abs);
  if (st.size <= cap) return { buf: fs.readFileSync(abs), truncated: false };
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(cap);
    const n = fs.readSync(fd, buf, 0, cap, 0);
    return { buf: buf.subarray(0, n), truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

async function readPkgFile(pkg, rel, cap) {
  if (pkg.kind === 'dir') {
    return readRepoFile(path.join(pkg.root, ...rel.split('/')), cap);
  }
  const e = pkg.zip.get(pkg.prefix + rel);
  if (!e) return null;
  return readEntry(pkg.zip, e, cap);
}

function splitLines(buf) {
  const arr = buf.toString('utf8').split('\n');
  if (arr.length && arr[arr.length - 1] === '') arr.pop(); // 结尾的换行不算单独一行
  return arr;
}

/**
 * 哈希只能回答"不一样"，回答不了"哪边是旧的"。
 * 行数和首个差异行才能：186 行 vs 1238 行，一眼就知道包里那份是旧的。
 */
function lineDiff(repoBuf, pkgBuf) {
  if (repoBuf.includes(0) || pkgBuf.includes(0)) return null; // 二进制没有"行"
  const a = splitLines(repoBuf);
  const b = splitLines(pkgBuf);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return { repoLines: a.length, pkgLines: b.length, firstDiffLine: i + 1 };
}

// ── 包内多出的文件 ─────────────────────────────────────────────────────
/**
 * 包里"多出来"的文件同样值得看：可能是仓库删了但包没重建（残留），
 * 也可能是仓库丢了文件（包里有、仓库没有，等于仓库重建不出这个包）。
 * 但它不参与"一致/不一致"判定——package-lock.json 这类 npm 产物天然存在。
 */
function extrasOf(pkg, expected) {
  const found = [];
  const consider = (rel) => {
    if (expected.has(rel)) return;
    const top = rel.includes('/') ? rel.split('/')[0] : '';
    // 只关心「被 cp 的那几棵子树」和根目录文件；node_modules 两万多个条目不是包的问题。
    if (top && !COPY_DIRS.includes(top)) return;
    found.push({ path: rel, note: noteFor(rel) });
  };

  if (pkg.kind === 'dir') {
    walkPkg(pkg.root, '', consider);
  } else {
    for (const name of pkg.zip.entries.keys()) {
      if (!name.startsWith(pkg.prefix)) continue;
      const rel = name.slice(pkg.prefix.length);
      if (!rel || rel.endsWith('/')) continue;
      if (rel === 'node_modules' || rel.startsWith('node_modules/') || rel.includes('/node_modules/')) continue;
      if (SKIP_NAMES.has(rel.split('/').pop())) continue;
      consider(rel);
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function walkPkg(dir, relDir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(e.name)) continue;
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkPkg(abs, rel, fn);
    else fn(rel);
  }
}

function noteFor(rel) {
  if (rel === 'package-lock.json') return 'npm install 产物（仓库里没有锁文件，构建时现生成），正常';
  if (/\.(mjs|js|cjs|json|yml)$/.test(rel)) return '仓库里没有这份代码：历史残留，或仓库把文件丢了';
  return '仓库里没有这个文件';
}

// ── 主流程：逐个文件对哈希 ─────────────────────────────────────────────
async function verify(target, engineDir) {
  const pkg = locatePackage(target);
  try {
    const expected = collectRepoFiles(engineDir);
    if (expected.size < 20) {
      // 防"假一致"：目录指错时 expected 会退化成两三个根文件，
      // 全部对上就给出"一致"的结论——比报错更危险，所以直接拒绝。
      throw new UsageError(`仓库侧只找到 ${expected.size} 个待比对文件，engine 目录大概率指错了：${engineDir}`);
    }

    const matches = [];
    const mismatches = [];
    const missing = [];
    const CAP = 8 << 20; // 差异明细最多读 8MB，够所有源码文件用
    let repoNewest = 0;   // 仓库侧最新改动时间：用来判断"包是不是在仓库改动之前打的"

    for (const rel of [...expected.keys()].sort()) {
      const repo = sha256File(expected.get(rel));
      const t = Date.parse(repo.mtime);
      if (t > repoNewest) repoNewest = t;
      const got = pkg.kind === 'dir'
        ? fileInfo(path.join(pkg.root, ...rel.split('/')))
        : await entryInfo(pkg.zip, pkg.prefix + rel);

      if (!got) { missing.push(rel); continue; }
      if (got.sha256 === repo.sha256) { matches.push(rel); continue; }

      const row = { path: rel, repo, package: got };
      try {
        const a = readRepoFile(expected.get(rel), CAP);
        const b = await readPkgFile(pkg, rel, CAP);
        if (b && !a.truncated && !b.truncated) {
          const d = lineDiff(a.buf, b.buf);
          if (d) row.lineDiff = d;
        }
      } catch { /* 拿不到差异明细不影响"不一致"这个结论 */ }
      mismatches.push(row);
    }

    const extras = extrasOf(pkg, expected);
    const ok = mismatches.length === 0 && missing.length === 0;

    return {
      ok,
      target,
      mode: pkg.kind === 'zip' ? 'zip' : 'dir',
      packageTree: pkg.kind === 'zip' ? pkg.prefix : path.relative(target, pkg.root) || '.',
      packageMtime: pkg.kind === 'zip' ? fs.statSync(target).mtime.toISOString() : null,
      engineDir,
      repoNewestMtime: repoNewest ? new Date(repoNewest).toISOString() : null,
      expectedCount: expected.size,
      counts: { match: matches.length, mismatch: mismatches.length, missing: missing.length, extra: extras.length },
      matches,
      mismatches,
      missing,
      extras,
    };
  } finally {
    if (pkg.kind === 'zip') pkg.zip.close();
  }
}

function fileInfo(abs) {
  let st = null;
  try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile()) return null;
  return { sha256: sha256File(abs).sha256, size: st.size };
}

async function entryInfo(zip, name) {
  const e = zip.get(name);
  if (!e || e.name.endsWith('/')) return null;
  return hashEntry(zip, e);
}

// ── 输出 ───────────────────────────────────────────────────────────────
function fmtTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function judge(d) {
  const delta = d.pkgLines - d.repoLines;
  if (delta < 0) return `包内少 ${-delta} 行 → 包内是旧版`;
  if (delta > 0) return `包内多 ${delta} 行 → 仓库里没有这部分代码（包内更新，或两边已分叉）`;
  return '行数相同但内容不同 → 只改了少量字';
}

function verdictOf(r) {
  if (r.ok) {
    return `包内引擎与仓库一致（${r.counts.match}/${r.expectedCount} 个文件 sha256 全同）`;
  }
  const parts = [];
  if (r.counts.mismatch) parts.push(`${r.counts.mismatch} 个文件内容不同`);
  if (r.counts.missing) parts.push(`${r.counts.missing} 个文件包内缺失`);
  return `包内引擎与仓库不一致（${parts.join('、')}）—— 装进 App 的不是当前仓库的代码`;
}

function printHuman(r) {
  const L = [];
  L.push(`包内引擎核对 · ${r.target}`);
  L.push(`  包内树  ${r.packageTree}${r.mode === 'zip' ? '（zip 直读，未解包）' : '（已解包目录）'}`);
  L.push(`  仓库    ${r.engineDir}${r.repoNewestMtime ? `（最近改动 ${fmtTime(new Date(r.repoNewestMtime))}）` : ''}`);
  L.push(`  清单    ${r.expectedCount} 个文件（= build-engine.sh 的 cp 范围；node_modules 不算）`);
  L.push('');
  L.push(`  一致 ${r.counts.match} · 不一致 ${r.counts.mismatch} · 缺失 ${r.counts.missing}`
    + (r.counts.extra ? ` · 包内多出 ${r.counts.extra}（不计入结论）` : ''));
  L.push('');

  if (r.mismatches.length) {
    L.push(`不一致（${r.mismatches.length}）`);
    for (const m of r.mismatches) {
      L.push(`  ✗ ${m.path}`);
      L.push(`      仓库 ${m.repo.sha256.slice(0, 8)} · ${m.repo.size}B`
        + (m.lineDiff ? ` · ${m.lineDiff.repoLines} 行` : '')
        + (m.repo.mtime ? ` · 改动于 ${fmtTime(new Date(m.repo.mtime))}` : ''));
      L.push(`      包内 ${m.package.sha256.slice(0, 8)} · ${m.package.size}B`
        + (m.lineDiff ? ` · ${m.lineDiff.pkgLines} 行` : ''));
      if (m.lineDiff) L.push(`      首个差异行 L${m.lineDiff.firstDiffLine}；${judge(m.lineDiff)}`);
    }
    L.push('');
  }

  if (r.missing.length) {
    L.push(`包内缺失（${r.missing.length}）—— 仓库里有、包里没有`);
    for (const p of r.missing) L.push(`  - ${p}`);
    L.push('');
  }

  if (r.extras.length) {
    L.push(`包内多出（${r.extras.length}，不计入结论）—— 包里有、仓库里没有`);
    for (const e of r.extras) L.push(`  + ${e.path}  —  ${e.note}`);
    L.push('');
  }

  L.push(`结论：${verdictOf(r)}`);
  if (!r.ok) {
    L.push('      重跑 scripts/build-engine.sh（日志里出现 "restored from cache" 就是又走了缓存），');
    L.push('      重新归档打包后再核一次；不要拿"构建成功"当"改动生效"。');
  }
  console.log(L.join('\n'));
}

function printUsage() {
  console.log(`用法：node engine/tools/verify-package.mjs <ipa路径 | 已解包目录> [--json] [--engine <engine目录>]

  <ipa路径>       直接读 .ipa：在 zip 里定位 Payload/*.app/nodejs-project/，不解包
  <已解包目录>    含 Payload/ 的解包目录、.app 目录本身，或 nodejs-project 本身
  --json          输出机器可读结果（退出码含义不变）
  --engine <dir>  指定仓库 engine 目录（默认：本文件的上一级）

比对范围 = scripts/build-engine.sh 实际 cp 进 nodejs-project 的文件：
  package.json / main.mjs / boot.mjs / ios.patch.yml（+ 存在才拷的 smoke.mjs、
  AGENTS.md、package-lock.json）与 plugins/ shims/ runtime/ skills/ 四棵子树。
判据 = 逐文件 sha256；不比大小、不比时间戳。

退出码：0 一致 · 1 不一致（内容不同或包内缺失）· 2 用法/读取错误`);
}

// ── CLI ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { json: false, engine: null, target: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--engine') {
      opts.engine = argv[++i];
      if (!opts.engine) throw new UsageError('--engine 后面要跟一个目录');
    } else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) throw new UsageError(`不认识的参数：${a}`);
    else if (!opts.target) opts.target = a;
    else throw new UsageError(`多余的参数：${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printUsage(); return 0; }
  if (!opts.target) { printUsage(); return 2; }

  const engineDir = opts.engine ? path.resolve(opts.engine) : DEFAULT_ENGINE;
  const r = await verify(path.resolve(opts.target), engineDir);

  if (opts.json) {
    const out = {
      tool: 'verify-package',
      ok: r.ok,
      verdict: verdictOf(r),
      target: r.target,
      mode: r.mode,
      packageTree: r.packageTree,
      packageMtime: r.packageMtime,
      engineDir: r.engineDir,
      repoNewestMtime: r.repoNewestMtime,
      expectedCount: r.expectedCount,
      counts: r.counts,
      matches: r.matches,
      mismatches: r.mismatches.map((m) => ({
        path: m.path,
        repo: { sha256: m.repo.sha256, size: m.repo.size, mtime: m.repo.mtime },
        package: { sha256: m.package.sha256, size: m.package.size },
        ...(m.lineDiff ? { lineDiff: m.lineDiff } : {}),
      })),
      missing: r.missing,
      extras: r.extras,
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    printHuman(r);
  }
  return r.ok ? 0 : 1; // 退出码就是结论：CI/脚本不用解析文本
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    if (err instanceof UsageError) {
      console.error(`错误：${err.message}`);
    } else if (err && err.code === 'ENOENT') {
      console.error(`错误：找不到路径 ${err.path || ''}`);
    } else {
      console.error(`失败：${(err && err.stack) || err}`);
    }
    process.exitCode = 2;
  });
