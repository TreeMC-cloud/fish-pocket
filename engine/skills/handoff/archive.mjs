#!/usr/bin/env node
/**
 * 归档层 —— 只进不改。
 *
 * 一位实践者的第六层（他叫 L5 归档层）：所有旧东西都往这里搬，
 * 「指定不改」。想回溯就去翻，但归档本身永远不作为入口。
 *
 * 为什么要有这一层：换会话/更新交接时，旧内容不能直接删——那是证据。
 * 但也不能留在入口，否则没人读。所以「搬走，不删」。
 *
 * 三条硬要求（他踩过坑才总结的）：
 *   1. 先快照，再动手 —— 有一次没存快照就拆，核对脚本根本跑不了，
 *      你无法证明自己没丢东西
 *   2. 只搬不丢 —— 搬前搬后要能逐行比对
 *   3. 归档只进不改 —— 任何升级都能回滚
 *
 * 用法：
 *   archive.mjs put <文件> [--reason 原因]    把文件搬进归档
 *   archive.mjs list                         看归档里有什么
 *   archive.mjs restore <文件名>              从归档取回（不删归档）
 *   archive.mjs verify <快照id>               比对快照，确认没丢东西
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = (() => {
  const home = process.env.DSH_HOME;
  const base = home || (process.env.DSH_IOS_DATA ? path.join(process.env.DSH_IOS_DATA, 'dsh') : path.join(process.env.HOME || '/tmp', '.dsh'));
  return path.join(base, 'archive');
})();

const SNAP = path.join(DIR, '_snapshots');

function fail(msg) {
  console.error(`错误：${msg}`);
  process.exit(2);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sha(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (!cmd || cmd === 'help') {
  console.log(`归档层 —— 只进不改

  archive.mjs put <文件> [--reason 原因]   搬进归档（先快照再搬）
  archive.mjs list                         看归档内容
  archive.mjs restore <名字>               取回（归档里仍保留）
  archive.mjs verify <快照id>              比对快照

归档目录：${DIR}`);
  process.exit(0);
}

if (cmd === 'put') {
  const src = argv[1];
  if (!src) fail('要给文件路径');
  const file = path.resolve(src);
  if (!fs.existsSync(file)) fail(`文件不存在：${file}`);

  const reasonIdx = argv.indexOf('--reason');
  const reason = reasonIdx >= 0 ? argv[reasonIdx + 1] || '' : '';

  const content = fs.readFileSync(file, 'utf8');
  const digest = sha(content);
  const id = `${stamp()}-${path.basename(file, path.extname(file))}`;

  fs.mkdirSync(DIR, { recursive: true });
  fs.mkdirSync(SNAP, { recursive: true });

  // ① 先快照：把原文完整存一份。这一步必须先做——
  //    搬的过程中出任何问题，快照是唯一的还原依据。
  const snapFile = path.join(SNAP, `${id}.json`);
  fs.writeFileSync(snapFile, JSON.stringify({
    id, source: file, sha: digest, at: new Date().toISOString(),
    bytes: Buffer.byteLength(content, 'utf8'), lines: content.split('\n').length,
    reason,
  }, null, 2), 'utf8');

  // ② 搬（复制，不删源文件）
  const dst = path.join(DIR, `${id}${path.extname(file)}`);
  fs.writeFileSync(dst, content, 'utf8');

  // ③ 核对：搬过去的和原文逐字节一致
  const back = fs.readFileSync(dst, 'utf8');
  if (sha(back) !== digest) {
    fail('搬移校验失败：归档内容和原文不一致。源文件未动。');
  }

  console.log(`✓ 已归档`);
  console.log(`  快照：${snapFile}`);
  console.log(`  归档：${dst}`);
  console.log(`  ${content.split('\n').length} 行 / ${Buffer.byteLength(content, 'utf8')} 字节 / sha ${digest}`);
  if (reason) console.log(`  原因：${reason}`);
  console.log('');
  console.log('源文件还在。确认无误后再删它（或者用 restore 取回）。');
  process.exit(0);
}

if (cmd === 'list') {
  if (!fs.existsSync(DIR)) {
    console.log('归档是空的。');
    process.exit(0);
  }
  const items = fs.readdirSync(DIR)
    .filter((n) => n !== '_snapshots' && fs.statSync(path.join(DIR, n)).isFile())
    .map((n) => {
      const st = fs.statSync(path.join(DIR, n));
      return { name: n, size: st.size, at: st.mtime };
    })
    .sort((a, b) => b.at - a.at);

  if (!items.length) { console.log('归档是空的。'); process.exit(0); }

  console.log(`归档 ${items.length} 项（最新在上）：\n`);
  for (const it of items) {
    const d = it.at.toISOString().slice(0, 16).replace('T', ' ');
    console.log(`  ${d}  ${(it.size / 1024).toFixed(1).padStart(7)} KB  ${it.name}`);
  }
  console.log('');
  console.log('归档只进不改。要取回：archive.mjs restore <名字>');
  process.exit(0);
}

if (cmd === 'restore') {
  const name = argv[1];
  if (!name) fail('要给归档文件名');
  const src = path.join(DIR, name);
  if (!fs.existsSync(src)) {
    console.error(`归档里没有：${name}`);
    console.error('先跑 archive.mjs list 看有什么');
    process.exit(1);
  }
  const target = path.resolve(argv[2] || path.basename(name));
  if (fs.existsSync(target)) {
    fail(`${target} 已存在。要覆盖请先删它，或者指定不同路径。`);
  }
  fs.copyFileSync(src, target);
  console.log(`✓ 已取回：${target}`);
  console.log('（归档里的原件还在，没动）');
  process.exit(0);
}

if (cmd === 'verify') {
  const id = argv[1];
  if (!id) fail('要给快照 id');
  const snapFile = path.join(SNAP, id.endsWith('.json') ? id : `${id}.json`);
  if (!fs.existsSync(snapFile)) {
    console.error(`没找到快照：${snapFile}`);
    process.exit(1);
  }
  const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  const archFile = path.join(DIR, `${snap.id}${path.extname(snap.source)}`);
  if (!fs.existsSync(archFile)) {
    console.error(`快照存在但归档文件没了：${archFile}`);
    process.exit(1);
  }
  const content = fs.readFileSync(archFile, 'utf8');
  const nowSha = sha(content);
  const lines = content.split('\n').length;
  if (nowSha !== snap.sha) {
    console.error(`✗ 归档内容和快照不一致`);
    console.error(`  快照：${snap.sha}（${snap.lines} 行）`);
    console.error(`  现在：${nowSha}（${lines} 行）`);
    console.error('  归档本该"只进不改"——这说明有人改动过它。');
    process.exit(1);
  }
  console.log(`✓ 归档完好`);
  console.log(`  ${snap.lines} 行 / ${snap.bytes} 字节，与快照一致`);
  process.exit(0);
}

fail(`不认识的命令「${cmd}」。跑 archive.mjs help`);
