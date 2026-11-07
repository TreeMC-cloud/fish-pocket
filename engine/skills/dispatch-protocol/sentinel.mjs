#!/usr/bin/env node
/**
 * 回执哨兵 —— 给异步派单留一个「未回执」状态，让「双方都在等对方」会报错。
 *
 * 治的是什么病：多 AI 协作里最贵的浪费不是做错，是没人做、而且不报错。
 * 真实数据：一天发 36 条「通知」，只有 8 条真的被执行，另外 28 条卡住了
 * 却没有一条错误 —— 发的人以为交出去了，收的人以为只是知悉一下。
 *
 * 病根在异步：subagent / wb_submit_task 都是立刻返回一个 id，活还在后台跑。
 * 拿到 id 就说「做好了」，等于把派单扔进黑洞。所以除了「已发出」「已回执」，
 * 台账必须显式存第三种状态：已发出、还没人回。这个工具只回答两件事：
 *   open    我发出、还没人回的（我欠不欠催）
 *   awaited 别人在等我回的（我是不是让别人空等）
 *
 * 为什么检查必须会失败：永远返回 0 的检查是装饰，不是检查。所以 open / awaited
 * 只要还有未销账的条目就退出 1，并列出具体哪些 id、等了多久、交给谁，
 * 让人看完就能接着动手；2 专门留给用法错误，不和「发现问题」混在一起。
 *
 * 用法：
 *   node sentinel.mjs dispatch --to <对方> --what <做什么> [--expect <预期回执>] [--id <自定义id>]
 *   node sentinel.mjs ack      --id <id> [--evidence <证据>]
 *   node sentinel.mjs open     [--stale <分钟>]
 *   node sentinel.mjs awaited
 *   node sentinel.mjs inbound  --from <对方> --what <做什么>
 *   node sentinel.mjs list     [--limit N]
 *   node sentinel.mjs gc       [--days N]
 *
 * 台账：DSH_SENTINEL_LEDGER 指定路径，否则用当前目录的 .sentinel.jsonl（一行一条 JSON）。
 * 退出码：0 成功且没有要处理的事；1 成功但发现要处理的事；2 用法错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 检查命令靠这个把「台账有坏行」升级成退出码 1：哨兵自己读不懂的数据，
// 不能因为没匹配到任何派单就报「一切正常」，那是最像装饰的假通过。
let brokenRows = [];

const DEFAULT_STALE_MIN = 30;
const DEFAULT_GC_DAYS = 7;
const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;

const USAGE = `用法：
  node sentinel.mjs dispatch --to <对方> --what <做什么> [--expect <预期回执>] [--id <自定义id>]
  node sentinel.mjs ack      --id <id> [--evidence <证据>]
  node sentinel.mjs open     [--stale <分钟>]       默认 30 分钟算超时
  node sentinel.mjs awaited
  node sentinel.mjs inbound  --from <对方> --what <做什么>
  node sentinel.mjs list     [--limit N]            显示最近 N 条
  node sentinel.mjs gc       [--days N]            默认清 7 天前已销账的
  node sentinel.mjs help
台账文件：DSH_SENTINEL_LEDGER 环境变量，未设置时用当前目录的 .sentinel.jsonl
退出码：0 成功且没有要处理的事；1 成功但发现要处理的事；2 用法错误`;

/** 用法错误单独一个类型：它和「检查发现问题」是两码事，退出码不能共用。 */
class UsageError extends Error {}

/** 台账读写失败是运行故障，不是参数写错；报错仍要给可执行的下一步。 */
class LedgerError extends Error {}

function fail(msg) {
  throw new UsageError(msg);
}

function ledgerFail(msg) {
  throw new LedgerError(msg);
}

function ledgerPath() {
  // env 覆盖优先：测试、多个工作台并存时各用各的账本，才不会互相销掉对方的单。
  return path.resolve(process.env.DSH_SENTINEL_LEDGER || path.join(process.cwd(), '.sentinel.jsonl'));
}

/**
 * 读成「行」而不是「记录」：坏行必须留在原位置，
 * 否则一次 ack 的整文件重写会把看不懂的数据悄悄抹掉。
 */
function readRows() {
  const file = ledgerPath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    ledgerFail(`读不了台账 ${file}：${e.message}；确认有读权限，或换一个 DSH_SENTINEL_LEDGER 路径`);
  }
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const rows = lines.map((raw, i) => {
    if (raw.trim() === '') return { raw, rec: null, line: i + 1, blank: true };
    try {
      const rec = JSON.parse(raw);
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new Error('不是 JSON 对象');
      return { raw, rec, line: i + 1, blank: false };
    } catch (e) {
      return { raw, rec: null, line: i + 1, blank: false, broken: e.message };
    }
  });
  // 只提醒不自动修：猜不出语义的数据交给人工判，删了就等于替别人做了决定。
  brokenRows = rows.filter((x) => x.broken);
  for (const r of brokenRows) {
    console.error(`⚠ 台账 ${file} 第 ${r.line} 行不是合法 JSON（${r.broken}），已跳过：确认后手工修这行，别直接删`);
  }
  return rows;
}

function writeRows(rows) {
  const file = ledgerPath();
  const body = rows.length ? `${rows.map((r) => r.raw).join('\n')}\n` : '';
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // ack / gc 是读改写，直接覆盖时中途崩掉会留下半截 JSONL，整本台账就废了；
    // 先落临时文件再 rename，要么全旧要么全新，没有中间态。
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 清不掉就算了，不掩盖原始错误 */ }
    ledgerFail(`写不进台账 ${file}：${e.message}；确认目录可写，或换一个 DSH_SENTINEL_LEDGER 路径`);
  }
}

function appendRecord(rec) {
  const file = ledgerPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let prefix = '';
    try {
      const fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const tail = Buffer.alloc(1);
        fs.readSync(fd, tail, 0, 1, size - 1);
        // 手工改过的账本可能没留尾换行，不补就会把两条记录粘成一行。
        if (tail[0] !== 0x0a) prefix = '\n';
      }
      fs.closeSync(fd);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    // 追加而不是重写：多个 agent 可能同时派单，O_APPEND 至少不会互相覆盖掉整本账。
    fs.appendFileSync(file, `${prefix}${JSON.stringify(rec)}\n`, 'utf8');
  } catch (e) {
    ledgerFail(`追加不进台账 ${file}：${e.message}；确认目录可写，或换一个 DSH_SENTINEL_LEDGER 路径`);
  }
}

function parseFlags(args, allowed) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      fail(`不认识的参数「${arg}」：参数要写成 --名字 值；本命令只接受 ${allowed.map((k) => `--${k}`).join(' ')}`);
    }
    const key = arg.slice(2);
    if (!allowed.includes(key)) {
      fail(`不认识的参数 --${key}：本命令只接受 ${allowed.map((k) => `--${k}`).join(' ')}；查全量用法跑 node sentinel.mjs help`);
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      fail(`--${key} 写了两次：一个参数只写一遍，别让后半个悄悄盖掉前半个`);
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`--${key} 需要一个值：例如 --${key} ${key === 'to' ? 'remote-workbench' : key === 'what' ? '"修完跑 xx 复验"' : '<值>'}；只给参数名不给值等于没派单`);
    }
    out[key] = value;
    i += 1;
  }
  return out;
}

function requireText(flags, key, hint) {
  const v = flags[key];
  // 空字符串和缺失一样危险：写进去就成了没人知道要干什么的「通知」。
  if (v === undefined || v.trim() === '') fail(`--${key} 不能为空：${hint}`);
  return v.trim();
}

function nonNegNumber(raw, label, hint) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) fail(`${label} 需要不小于 0 的数字，拿到「${raw}」：${hint}`);
  return n;
}

function positiveInt(raw, label) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(`${label} 需要正整数，拿到「${raw}」：例如 --limit 20`);
  return n;
}

function freshId(rows) {
  const used = new Set(rows.filter((r) => r.rec).map((r) => r.rec.id));
  for (;;) {
    const id = `s_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    if (!used.has(id)) return id;
  }
}

function waitedMs(rec, now) {
  const t = Date.parse(rec.at);
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
}

function waitedText(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

function direction(rec) {
  return rec.kind === 'inbound' ? `${rec.from} → 我` : `我 → ${rec.to}`;
}

function warnNoEvidence(id) {
  console.error(`⚠ ${id} 的回执没带证据：只说「做完了」等于没说。可补：node sentinel.mjs ack --id ${id} --evidence "命令输出/文件路径"`);
}

// ---------- 命令 ----------

function cmdDispatch(args) {
  const flags = parseFlags(args, ['to', 'what', 'expect', 'id']);
  const to = requireText(flags, 'to', '写明交给谁（子 agent 的 id 或 remote-workbench）；没有收件人的派单没法催');
  const what = requireText(flags, 'what', '用祈使句写清「现象 / 照哪做 / 怎么验 / 回一句」，别写成「请注意一下」这种没人会动手的通知');
  // expect 留空会让人催的时候不知道该要什么，所以给个能直接用的默认值。
  const expect = flags.expect === undefined ? '带证据的回执（结论 / 证据 / 落盘）' : flags.expect.trim();
  const rows = readRows();
  const id = flags.id === undefined ? freshId(rows) : flags.id.trim();
  if (!ID_RE.test(id)) {
    fail(`--id 不合法「${id}」：只能用字母、数字、_ . -，长度 1-80；id 会进 shell 命令和台账，别带空格或换行`);
  }
  if (rows.some((r) => r.rec && r.rec.id === id)) {
    fail(`--id ${id} 已经存在：换个 id，或者不写 --id 让哨兵自动生成；跑 node sentinel.mjs list 看现有 id`);
  }
  const rec = {
    id, kind: 'dispatch', from: 'me', to, what, expect,
    at: new Date().toISOString(), ackAt: null, evidence: null,
  };
  appendRecord(rec);
  // 只输出 id：调用方要能 `ID=$(node sentinel.mjs dispatch ...)` 直接拿去查状态。
  console.log(id);
  return 0;
}

function cmdInbound(args) {
  const flags = parseFlags(args, ['from', 'what']);
  const from = requireText(flags, 'from', '写明谁把活交给我（子 agent 的 id 或 remote-workbench）；不知道是谁就没法回执');
  const what = requireText(flags, 'what', '抄下对方要我做什么，越具体越好；空着只会让 awaited 变成一句看不懂的「有事」');
  const id = freshId(readRows());
  const rec = {
    id, kind: 'inbound', from, to: 'me', what, expect: null,
    at: new Date().toISOString(), ackAt: null, evidence: null,
  };
  appendRecord(rec);
  console.log(id);
  console.log(`已记入 awaited：干完用 node sentinel.mjs ack --id ${id} --evidence "命令输出/文件路径" 销账，别让对方空等`);
  return 0;
}

function cmdAck(args) {
  const flags = parseFlags(args, ['id', 'evidence']);
  const id = requireText(flags, 'id', '写明要销哪一条（open / awaited 输出里的 s_ 开头的 id）；跑 node sentinel.mjs list 可以查 id');
  const evidence = flags.evidence === undefined ? null : flags.evidence.trim() || null;
  const rows = readRows();
  const matches = rows.filter((r) => r.rec && r.rec.id === id);
  if (matches.length === 0) {
    const known = rows.filter((r) => r.rec).map((r) => r.rec.id);
    console.log(`✗ 没找到 id ${id}：台账里没有这一单，没销掉任何记录`);
    console.log(`  → 跑 node sentinel.mjs list 核对 id${known.length ? `（现有：${known.slice(-8).join('、')}）` : '（台账是空的）'}；注意 --id 大小写和空格`);
    return 1;
  }
  if (matches.length > 1) {
    // 重复 id 是台账被人手改过的痕迹，只销第一条并显式说出来，避免自作主张合并。
    console.error(`⚠ 台账里有 ${matches.length} 条 id ${id}（第 ${matches.map((m) => m.line).join('、')} 行），本次只销第 ${matches[0].line} 行；跑 list 核对后手工删掉多余行`);
  }
  const row = matches[0];
  const rec = row.rec;
  const waited = waitedText(waitedMs(rec, Date.now()));
  if (rec.ackAt) {
    if (evidence && !rec.evidence) {
      // 补证据不改写 ackAt：首次回执时间是「对方到底等多久」的唯一凭据，覆盖掉就查不清了。
      rec.evidence = evidence;
      row.raw = JSON.stringify(rec);
      writeRows(rows);
      console.log(`✓ 已补证据：${id}（${direction(rec)}，首次回执 ${rec.ackAt}，时间保持不变）`);
      console.log(`  证据：${evidence}`);
      return 0;
    }
    console.log(`⚠ ${id} 早就销过账了：${rec.ackAt}${rec.evidence ? `，证据「${rec.evidence}」` : '（没留证据）'}`);
    console.log('  → 收到回执就结束，别再回「收到/好的」开新一条线；确实要补证据就跑：node sentinel.mjs ack --id ' + id + ' --evidence "命令输出/文件路径"');
    return 1;
  }
  rec.ackAt = new Date().toISOString();
  rec.evidence = evidence;
  row.raw = JSON.stringify(rec);
  writeRows(rows);
  console.log(`✓ 已销账：${id}（等了 ${waited}，${direction(rec)}）：${rec.what}`);
  if (evidence) console.log(`  证据：${evidence}`);
  else warnNoEvidence(id);
  return 0;
}

/** 未回执：ackAt 缺失、null、空串一律算没回 —— 宽松读，宁可多催一次也别漏掉。 */
function isOpen(rec) {
  return !rec || !rec.ackAt;
}

function openRecords(rows) {
  return rows.filter((r) => r.rec && r.rec.kind === 'dispatch' && isOpen(r.rec));
}

function awaitedRecords(rows) {
  return rows.filter((r) => r.rec && r.rec.kind === 'inbound' && isOpen(r.rec));
}

function byWaitDesc(a, b) {
  // 等得越久越靠前：催人要先催最可能已经凉了的那一条。
  // 用同一个 now 做差，避免比较器里两次取时间导致排序结果抖动。
  const now = Date.now();
  return waitedMs(b.rec, now) - waitedMs(a.rec, now);
}

function cmdOpen(args) {
  const flags = parseFlags(args, ['stale']);
  const staleMin = flags.stale === undefined ? DEFAULT_STALE_MIN : nonNegNumber(flags.stale, '--stale', '写等待多少分钟算超时，例如 --stale 15；--stale 0 表示所有未回执都算超时');
  const staleMs = staleMin * 60_000;
  const rows = readRows();
  const open = openRecords(rows).sort(byWaitDesc);
  if (open.length === 0) {
    console.log('没有未回执的派单');
    return 0;
  }
  // 一次取 now：既保证行内时长和超时判定用的是同一时刻，也避免临界条目
  // 在「排序」和「判超时」之间翻面，出现「显示未超时却算进了超时汇总」。
  const now = Date.now();
  const items = open.map((row) => ({ row, ms: waitedMs(row.rec, now) }));
  const stale = items.filter((x) => x.ms >= staleMs);
  const fresh = items.filter((x) => x.ms < staleMs);
  // 输出保持全局倒序：超时只是加标记，不分组重排，否则「按等待时长倒序」就名不副实。
  for (const { row, ms } of items) {
    const rec = row.rec;
    const expect = rec.expect ? `，预期：${rec.expect}` : '';
    const badTime = Number.isFinite(Date.parse(rec.at)) ? '' : '（at 不是合法时间，按 0 分钟算，核对这条记录）';
    console.log(`${ms >= staleMs ? '⚠ 超时' : '· 未超时'} ${rec.id}（等了 ${waitedText(ms)}，交给 ${rec.to}）：${rec.what}${expect}${badTime}`);
  }
  console.log('');
  if (stale.length) {
    // 差异集合：只说「有超时」没法动手，得把该催的 id、等了多久、交给谁一次列全。
    console.log(`⚠ ${stale.length} 条超时未回执：${stale.map(({ row, ms }) => `${row.rec.id}（等了 ${waitedText(ms)}，交给 ${row.rec.to}）`).join('、')}`);
  }
  if (fresh.length) {
    console.log(`另有 ${fresh.length} 条还没回执、未超过 ${staleMin} 分钟`);
  }
  console.log(`→ 逐条去催或确认对方已经失败；拿到带证据的回执后跑 node sentinel.mjs ack --id <id> --evidence "命令输出/文件路径" 销账`);
  return 1;
}

function cmdAwaited(args) {
  parseFlags(args, []);
  const rows = readRows();
  const pending = awaitedRecords(rows).sort(byWaitDesc);
  if (pending.length === 0) {
    console.log('没有等我回执的派单');
    return 0;
  }
  for (const row of pending) {
    const rec = row.rec;
    console.log(`⚠ ${rec.id}（等了 ${waitedText(waitedMs(rec, Date.now()))}，来自 ${rec.from}）：${rec.what}`);
  }
  console.log('');
  console.log(`⚠ ${pending.length} 条别人在等我回：${pending.map((r) => `${r.rec.id}（${r.rec.from}）`).join('、')}`);
  console.log('→ 对方可能正空等。先把活干完，再用 node sentinel.mjs ack --id <id> --evidence "命令输出/文件路径" 回一条带证据的回执，然后结束，不要再回「收到」');
  return 1;
}

function cmdList(args) {
  const flags = parseFlags(args, ['limit']);
  const limit = flags.limit === undefined ? null : positiveInt(flags.limit, '--limit');
  const rows = readRows();
  const records = rows.filter((r) => r.rec);
  const shown = limit === null ? records : records.slice(-limit);
  if (records.length === 0) {
    console.log('台账里还没有记录：用 dispatch 记一条我发出的派单，或用 inbound 记一条别人发来的派单');
    return 0;
  }
  if (limit !== null) console.log(`最近 ${shown.length} 条（共 ${records.length} 条）：`);
  for (const row of shown) {
    const rec = row.rec;
    const state = rec.ackAt ? `已回执 ${rec.ackAt}` : `未回执，已等 ${waitedText(waitedMs(rec, Date.now()))}`;
    const ev = rec.evidence ? `，证据：${rec.evidence}` : '';
    console.log(`${rec.kind === 'inbound' ? '收' : '发'} ${rec.id} [${state}] ${rec.at} ${direction(rec)}：${rec.what}${ev}`);
  }
  const openCount = openRecords(rows).length;
  const awaitedCount = awaitedRecords(rows).length;
  console.log(`共 ${records.length} 条：${openCount} 条我发出还没回（open），${awaitedCount} 条别人在等我回（awaited）`);
  // list 只陈列不判失败；但把差异的去处指出来，别让人翻完一屏还得自己想下一步。
  if (openCount || awaitedCount) console.log('→ 分别跑 node sentinel.mjs open / awaited 看该催谁、该回谁');
  return 0;
}

function cmdGc(args) {
  const flags = parseFlags(args, ['days']);
  const days = flags.days === undefined ? DEFAULT_GC_DAYS : nonNegNumber(flags.days, '--days', '写「销账多少天前」的记录可以清，例如 --days 7；--days 0 清掉所有已销账的');
  const cutoff = Date.now() - days * 86_400_000;
  const rows = readRows();
  const removed = [];
  const kept = [];
  for (const row of rows) {
    const rec = row.rec;
    const ackedAt = rec && rec.ackAt ? Date.parse(rec.ackAt) : NaN;
    // 没销账的一条都不删：把卡住的单清掉，等于亲手把黑洞挖回来。
    const expired = rec && rec.ackAt && Number.isFinite(ackedAt) && ackedAt <= cutoff;
    if (expired) removed.push(row); else kept.push(row);
  }
  if (removed.length) {
    writeRows(kept);
    console.log(`已清理 ${removed.length} 条 ${days} 天前销账的记录：${removed.map((r) => `${r.rec.id}（${r.rec.ackAt} 销账，${direction(r.rec)}）`).join('、')}`);
  } else {
    console.log(`没有 ${days} 天前已销账的记录可清`);
  }
  const stillOpen = kept.filter((r) => r.rec && r.rec.kind === 'dispatch' && isOpen(r.rec)).length;
  const stillAwaited = kept.filter((r) => r.rec && r.rec.kind === 'inbound' && isOpen(r.rec)).length;
  console.log(`保留 ${kept.filter((r) => r.rec).length} 条：${stillOpen} 条 open、${stillAwaited} 条 awaited 未销账，一律不清理`);
  if (stillOpen || stillAwaited) console.log('→ 想清掉它们得先销账：跑 node sentinel.mjs open / awaited 拿到 id，再 ack 带证据回执');
  return 0;
}

// ---------- 入口 ----------

// 坏行是台账本身的问题，只有「检查类」命令把它升级成退出 1；
// 写命令已经把单记进去了，若也返回 1 会让调用方误以为派单失败而重复派单。
const CHECK_CMDS = new Set(['open', 'awaited', 'list', 'gc']);

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const rest = args.slice(1);
  let code;
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return 0;
  }
  if (cmd === 'dispatch') code = cmdDispatch(rest);
  else if (cmd === 'ack') code = cmdAck(rest);
  else if (cmd === 'open') code = cmdOpen(rest);
  else if (cmd === 'awaited') code = cmdAwaited(rest);
  else if (cmd === 'inbound') code = cmdInbound(rest);
  else if (cmd === 'list') code = cmdList(rest);
  else if (cmd === 'gc') code = cmdGc(rest);
  else {
    fail(cmd === undefined
      ? '缺少命令：要记派单写 dispatch，要查没回的写 open 或 awaited；完整用法跑 node sentinel.mjs help'
      : `不认识的命令「${cmd}」：只支持 dispatch / ack / open / awaited / inbound / list / gc；完整用法跑 node sentinel.mjs help`);
  }
  if (brokenRows.length && CHECK_CMDS.has(cmd) && code === 0) {
    console.log(`⚠ 台账还有 ${brokenRows.length} 行坏数据（第 ${brokenRows.map((r) => r.line).join('、')} 行）：检查命令不能装作没看见，手工修好再跑`);
    return 1;
  }
  return code;
}

try {
  const code = main();
  process.exit(code);
} catch (e) {
  if (e instanceof UsageError) {
    // 用法错误必须和「发现问题」分开：2 让 shell 知道是自己命令写错了，不是台账有坑。
    console.error(`用法错误：${e.message}`);
    console.error(USAGE);
    process.exit(2);
  }
  // 台账故障属于「操作没成功」，按 1 报：让调用方知道别把这条当成已派单。
  console.error(`${e instanceof LedgerError ? '台账故障' : '执行失败'}：${e && e.message ? e.message : String(e)}；这条没写成，别当成成功`);
  process.exit(1);
}
