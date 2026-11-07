#!/usr/bin/env node
/**
 * 会话轮次守卫 —— 把「轮次多了就开新会话」从自觉变成会失败的检查。
 *
 * 事故背景：一晚几条 AI 互相写技术小论文，一个会话跑到 260 多轮，账户余额
 * 直接烧到报错停摆。另一条实测：新的一轮会重读旧轮次，轮次越多每轮越贵，
 * 第 50 轮的每句话都要把前 49 轮重新付费读一遍。靠「记得换会话」必然失效，
 * 所以这里把模糊判断变成三条可判定的红线，并让 shell 靠退出码拦住下一轮。
 *
 * 用法：
 *   node turns.mjs tick [--tokens N] [--turns N] [--note <文字>]
 *   node turns.mjs status
 *   node turns.mjs reset [--reason <原因>]
 *   node turns.mjs history [--limit N]
 *   node turns.mjs --help
 *
 * 三条红线（默认值，环境变量和参数都能改，参数优先）：
 *   轮次     40         DSH_TURNS_MAX    --turns-max
 *   累计 token 200,000  DSH_TOKENS_MAX   --tokens-max
 *   时长     3 小时     DSH_HOURS_MAX    --hours-max
 *
 * 存储：DSH_TURNS_FILE 指定，默认当前目录 .turns.jsonl。每行一条事件，只追加
 *   不改写；当前会话 = 最近一条 reset 之后的 tick 汇总。历史天然留在文件里，
 *   reset 不删任何东西 —— 旧会话的统计是复盘证据，不该被「整理」掉。
 *
 * 退出码（全项目统一，给 shell 用，不是给人看的装饰）：
 *   0 安全区   1 已超线、该换会话   2 用法错误 / 数据或存储错误
 *   tick / status / history 都按「当前会话」返回 0 或 1；reset 是修复动作，
 *   执行完当前会话归零，返回 0；--help 不判定状态，返回 0。
 */
import fs from 'node:fs';
import path from 'node:path';

// 40 轮不是拍的：新的一轮要重读前 39 轮，重复读取的成本随轮次线性上涨；
// 40 轮之后任务本身的开销已经淹没在重复里，继续聊只是在给旧内容付费。
const DEFAULT_TURNS_MAX = 40;
// 20 万 token 是余额护栏。那次 260 轮的事故里唯一的停止条件是「余额报错」，
// 而报错永远来得最晚；给金额划一条线，才有机会在报错之前停手。
const DEFAULT_TOKENS_MAX = 200000;
// 3 小时是「跑偏」的信号，不是效率指标：轮次不多但每轮极贵、或者挂在那里
// 反复确认，都是长会话的典型形态。用时间兜住轮次和 token 都漏掉的情况。
const DEFAULT_HOURS_MAX = 3;
const HOUR_MS = 3600000;

const USAGE = `用法：
  node turns.mjs tick [--tokens N] [--turns N] [--note <文字>]
  node turns.mjs status
  node turns.mjs reset [--reason <原因>]
  node turns.mjs history [--limit N]
  node turns.mjs --help

红线（命令行参数优先，其次环境变量，最后默认值）：
  --turns-max N   / DSH_TURNS_MAX    轮次上限，默认 40
  --tokens-max N  / DSH_TOKENS_MAX   累计 token 上限，默认 200000
  --hours-max N   / DSH_HOURS_MAX    时长上限（小时，可小数），默认 3
  DSH_TURNS_FILE                     事件文件路径，默认当前目录 .turns.jsonl

红线必须大于 0：设 0 会静默关掉守卫，所以不接受。只想守某一条线，
就把另外两条设成很大的数，别设 0。

退出码：0 安全区 / 1 已超线该换会话 / 2 用法、数据或存储错误`;

/** 用法错误要打印完整用法；数据/存储错误的提示写在 message 里，不必再刷一屏用法。 */
class GuardError extends Error {
  constructor(message, showUsage = false) {
    super(message);
    this.showUsage = showUsage;
  }
}

const OPT_TYPES = {
  '--tokens': 'nonNegInt',
  '--turns': 'posInt',
  '--note': 'text',
  '--reason': 'text',
  '--limit': 'posInt',
  '--turns-max': 'posInt',
  '--tokens-max': 'posInt',
  '--hours-max': 'posFloat',
};

const MAX_OPTS = ['--turns-max', '--tokens-max', '--hours-max'];
const ALLOWED = {
  tick: new Set(['--tokens', '--turns', '--note', ...MAX_OPTS]),
  status: new Set(MAX_OPTS),
  reset: new Set(['--reason', ...MAX_OPTS]),
  history: new Set(['--limit', ...MAX_OPTS]),
};

function parseValue(label, raw, type) {
  if (type === 'text') {
    const len = [...raw].length;
    // 备注不是交接文档。细节放文件里给路径，否则事件文件本身又变成上下文黑洞。
    if (len > 500) throw new GuardError(`${label} 有 ${len} 字，超过 500 字上限；细节放文件里，这里只写一句`);
    return raw;
  }
  if (type === 'posInt' || type === 'nonNegInt') {
    if (!/^\d+$/.test(raw)) throw new GuardError(`${label} 要整数，收到「${raw}」`);
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) throw new GuardError(`${label} 的数字太大：${raw}`);
    // 0 红线 = 守卫静默失效，比没有工具更危险（shell 会一直拿到 0）。
    if (type === 'posInt' && n === 0) throw new GuardError(`${label} 要大于 0，收到 0；不想守这条线就设一个很大的数，别设 0`);
    return n;
  }
  if (type === 'posFloat') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new GuardError(`${label} 要正数（小时，可写 0.5），收到「${raw}」`);
    return n;
  }
  throw new GuardError(`内部配置错：未知参数类型 ${type}`);
}

function parseArgs(argv) {
  if (argv.length === 0) throw new GuardError('缺命令：要写 tick / status / reset / history 之一', true);
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const cmd = argv[0];
  if (!Object.hasOwn(ALLOWED, cmd)) throw new GuardError(`不认识的命令「${cmd}」`, true);
  const allowed = ALLOWED[cmd];
  const opts = {};
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new GuardError(`不认识的参数「${flag}」；本工具不接受位置参数`, true);
    if (!allowed.has(flag)) throw new GuardError(`「${cmd}」不接受 ${flag}`, true);
    if (Object.hasOwn(opts, flag)) throw new GuardError(`${flag} 写了两次，只写一次`, true);
    const raw = argv[i + 1];
    if (raw === undefined) throw new GuardError(`${flag} 后面少了值`, true);
    i += 1;
    try {
      opts[flag] = parseValue(flag, raw, OPT_TYPES[flag]);
    } catch (error) {
      throw new GuardError(error.message, true);
    }
  }
  return { cmd, opts };
}

function envNumber(name, type) {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  if (raw.trim() === '') throw new GuardError(`${name} 是空值；不想设置就 unset ${name}，留空串会让人以为配置生效了`, true);
  try {
    return parseValue(name, raw, type);
  } catch (error) {
    // 配置写错时绝不能退回默认值继续跑：那等于用户以为下调了红线，守卫却还按 40 轮算。
    throw new GuardError(`${name}=${raw} 不合法：${error.message}；改完再跑`, true);
  }
}

function readLimits(opts) {
  // 三个环境变量先全部校验一遍：即使某个值被命令行参数覆盖了，写错的配置
  // 也不能装作没看见 —— 用户以为自己下调了红线，守卫却按默认值算，最危险。
  const fromEnv = {
    turns: envNumber('DSH_TURNS_MAX', 'posInt'),
    tokens: envNumber('DSH_TOKENS_MAX', 'posInt'),
    hours: envNumber('DSH_HOURS_MAX', 'posFloat'),
  };
  const pick = (flag, key, fallback) => (Object.hasOwn(opts, flag) ? opts[flag] : (fromEnv[key] === undefined ? fallback : fromEnv[key]));
  return {
    turns: pick('--turns-max', 'turns', DEFAULT_TURNS_MAX),
    tokens: pick('--tokens-max', 'tokens', DEFAULT_TOKENS_MAX),
    hours: pick('--hours-max', 'hours', DEFAULT_HOURS_MAX),
  };
}

function eventFile() {
  const raw = process.env.DSH_TURNS_FILE;
  if (raw !== undefined && raw.trim() === '') {
    throw new GuardError('DSH_TURNS_FILE 是空值；不想指定路径就 unset 它，会用当前目录 .turns.jsonl', true);
  }
  return raw === undefined ? path.join(process.cwd(), '.turns.jsonl') : path.resolve(raw);
}

// ---------- 显示：给数字和差距，不给形容词 ----------
function fmtNum(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function parts(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return {
    d: Math.floor(total / 86400),
    h: Math.floor((total % 86400) / 3600),
    m: Math.floor((total % 3600) / 60),
    s: total % 60,
  };
}

/** 人读的时间：「1 小时 12 分」，不是「4320 秒」。 */
function fmtElapsed(ms) {
  const { d, h, m } = parts(ms);
  if (d) return `${d} 天${h ? ` ${h} 小时` : ''}${m ? ` ${m} 分` : ''}`;
  if (h) return `${h} 小时${m ? ` ${m} 分` : ''}`;
  if (m) return `${m} 分`;
  return '不到 1 分';
}

/** 余量专用：不到 1 分给秒，不能含糊成「还剩 不到 1 分」。 */
function fmtSpareTime(ms) {
  const { d, h, m, s } = parts(ms);
  if (d || h || m) return fmtElapsed(ms);
  return `${Math.max(1, s)} 秒`;
}

/** 明细里用的紧凑时长：3h / 3h20m / 1h / 45s / 0s，短红线不丢精度。 */
function fmtCompact(ms) {
  const { d, h, m, s } = parts(ms);
  let out = '';
  if (d) out += `${d}d`;
  if (h) out += `${h}h`;
  if (m) out += `${m}m`;
  // 不到 1 分且没有更大的单位时，用秒；否则 0.0001 小时会显示成 0m，
  // 用户完全看不出这条红线到底卡在哪。
  if (!out && s) out += `${s}s`;
  // hours-max 可以是小数，0.0001h=0.36s：这时 parts() 全为 0，写 0s 会让人
  // 以为红线是 0（而 0 红线本工具明确拒绝）。标成 <1s，数字与判据不打架。
  return out || (ms > 0 ? '<1s' : '0s');
}

function fmtOver(ms) {
  const { d, h, m, s } = parts(ms);
  if (d) return `${d} 天${h ? ` ${h} 小时` : ''}${m ? ` ${m} 分钟` : ''}`;
  if (h) return `${h} 小时${m ? ` ${m} 分钟` : ''}`;
  if (m) return `${m} 分钟`;
  return `${Math.max(1, s)} 秒`;
}

/** ✅ 那一行报最紧的一条：告诉人「下一轮之前还有多少余量」，三条全列等于没说重点。 */
function fmtSafeGap(row) {
  const diff = row.limit - row.value;
  if (row.key === 'turns') return diff > 0 ? `距轮次红线还剩 ${fmtNum(diff)} 轮` : '轮次已到红线，再来 1 轮就超';
  if (row.key === 'tokens') return diff > 0 ? `距 token 红线还剩 ${fmtNum(diff)}` : 'token 已到红线，再加 1 token 就超';
  return diff > 0 ? `距时长红线还剩 ${fmtSpareTime(diff)}` : '时长已到红线，再等一会就超';
}

/** 明细行里的余量：只写差额，不重复「距…红线」。 */
function fmtSpare(row) {
  const diff = row.limit - row.value;
  if (row.key === 'turns') return diff > 0 ? `还剩 ${fmtNum(diff)} 轮` : '已到红线，再来 1 轮就超';
  if (row.key === 'tokens') return diff > 0 ? `还剩 ${fmtNum(diff)}` : '已到红线，再加 1 token 就超';
  return diff > 0 ? `还剩 ${fmtSpareTime(diff)}` : '已到红线，再等一会就超';
}

function fmtRow(row) {
  const spare = fmtSpare(row);
  if (row.key === 'turns') return `轮次 ${fmtNum(row.value)} / ${fmtNum(row.limit)}（${spare}）`;
  if (row.key === 'tokens') return `token ${fmtNum(row.value)} / ${fmtNum(row.limit)}（${spare}）`;
  return `时长 ${fmtCompact(row.value)} / ${fmtCompact(row.limit)}（${spare}）`;
}

function fmtBreach(row) {
  const over = row.value - row.limit;
  if (row.key === 'turns') return `轮次 ${fmtNum(row.value)} / ${fmtNum(row.limit)}（超 ${fmtNum(over)}）`;
  if (row.key === 'tokens') {
    const pct = (over / row.limit) * 100;
    const pctText = pct < 1 ? '不到 1%' : `${Math.round(pct)}%`;
    return `token ${fmtNum(row.value)} / ${fmtNum(row.limit)}（超 ${fmtNum(over)}，${pctText}）`;
  }
  return `时长 ${fmtCompact(row.value)} / ${fmtCompact(row.limit)}（超 ${fmtOver(over)}）`;
}

// ---------- 事件读取：只进不改，坏行不静默吞掉 ----------
/**
 * 事件文件是唯一的真相来源，读不进来的行必须报出来。静默跳过一行坏数据，
 * 等于少算一轮，而守卫的作用恰恰是「不多算也不少算」。
 */
function readEvents(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new GuardError(`读不了事件文件 ${file}：${error.message}；检查文件权限，或换一个 DSH_TURNS_FILE 路径`);
  }
  const lines = text.split('\n');
  // 末尾换行产生的空行是正常写法，不算坏行。
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const events = [];
  lines.forEach((line, i) => {
    if (line.trim() === '') throw new GuardError(`${file} 第 ${i + 1} 行是空行；每行必须是一条 JSON 事件，删掉这行或重写文件`);
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      throw new GuardError(`${file} 第 ${i + 1} 行不是合法 JSON；这一行对应的轮次没法算，修好再跑（不要删了当没发生）`);
    }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
      throw new GuardError(`${file} 第 ${i + 1} 行不是事件对象`);
    }
    if (ev.kind !== 'tick' && ev.kind !== 'reset') {
      throw new GuardError(`${file} 第 ${i + 1} 行的 kind 是「${String(ev.kind)}」；只认 tick / reset`);
    }
    if (!Number.isFinite(ev.at) || ev.at <= 0) {
      throw new GuardError(`${file} 第 ${i + 1} 行的 at 不是有效时间戳：${JSON.stringify(ev.at)}`);
    }
    if (ev.kind === 'tick' && (!Number.isSafeInteger(ev.turns) || ev.turns <= 0 || !Number.isSafeInteger(ev.tokens) || ev.tokens < 0)) {
      throw new GuardError(`${file} 第 ${i + 1} 行的 turns / tokens 不是合法数字`);
    }
    events.push(ev);
  });
  return events;
}

/**
 * 按 reset 切段。段号从 1 开始（没有 reset 事件时也是会话 #1），
 * 这样 history 里的编号和 status 里看到的编号是同一个，不用猜。
 * 一个 tick 都没写的空会话也保留：reset 本身是一次「旧会话结束」的事实。
 */
function buildSessions(events, now) {
  const sessions = [];
  for (const ev of events) {
    if (ev.kind === 'reset') {
      if (sessions.length) {
        const prev = sessions[sessions.length - 1];
        prev.endedAt = ev.at;
        prev.reason = typeof ev.reason === 'string' ? ev.reason : '';
      }
      sessions.push({
        id: sessions.length + 1,
        startedAt: ev.at,
        endedAt: null,
        reason: '',
        turns: 0,
        tokens: 0,
        lastAt: ev.at,
      });
    } else {
      if (sessions.length === 0) {
        sessions.push({ id: 1, startedAt: ev.at, endedAt: null, reason: '', turns: 0, tokens: 0, lastAt: ev.at });
      }
      const cur = sessions[sessions.length - 1];
      cur.turns += ev.turns;
      cur.tokens += ev.tokens;
      cur.lastAt = ev.at;
    }
  }
  if (sessions.length === 0) {
    sessions.push({ id: 1, startedAt: now, endedAt: null, reason: '', turns: 0, tokens: 0, lastAt: now });
  }
  return sessions;
}

function sessionDuration(s, now) {
  // 已结束的会话用 reset 的时刻封口，否则「持续多久」会随查看时间一直涨，
  // history 里的历史统计就再也不稳定了。
  return Math.max(0, (s.endedAt === null ? now : s.endedAt) - s.startedAt);
}

/** 三条线一起算，不短路：超了 2 条只报 1 条会让人低估处境。 */
function judge(s, limits, now) {
  const elapsedMs = sessionDuration(s, now);
  const rows = [
    { key: 'turns', value: s.turns, limit: limits.turns, over: s.turns - limits.turns },
    { key: 'tokens', value: s.tokens, limit: limits.tokens, over: s.tokens - limits.tokens },
    { key: 'hours', value: elapsedMs, limit: limits.hours * HOUR_MS, over: elapsedMs - limits.hours * HOUR_MS },
  ];
  const breaches = rows.filter((r) => r.over > 0);
  // 安全区里只报「余量最紧」的一条，用剩余比例而不是已用比例：
  // 新会话三条线的已用比例都是 ~0，用已用比例会挑中时长。但刚开会话时
  // 唯一有意义的数字是「还能跑几轮」，所以 0 轮 0 token 时固定报轮次线。
  const fresh = s.turns === 0 && s.tokens === 0;
  const tightest = fresh ? rows[0] : rows.slice(1).reduce((a, b) => {
    const spareA = (a.limit - a.value) / a.limit;
    const spareB = (b.limit - b.value) / b.limit;
    return spareB < spareA ? b : a;
  }, rows[0]);
  return { elapsedMs, rows, breaches, tightest, over: breaches.length > 0 };
}

function printSessionHead(s, elapsedMs) {
  console.log(`会话 #${s.id}：${fmtNum(s.turns)} 轮 · ${fmtNum(s.tokens)} tokens · 已持续 ${fmtElapsed(elapsedMs)}`);
}

function printStatus(s, limits, now) {
  const { elapsedMs, rows, breaches, tightest, over } = judge(s, limits, now);
  printSessionHead(s, elapsedMs);
  if (over) {
    // 超线时把每条线都列出来：哪条超了、超多少，是「要不要现在换」的依据。
    console.log(`❌ 超过 ${breaches.length} 条红线，该换会话了`);
    for (const r of breaches) console.log(`   ${fmtBreach(r)}`);
    console.log('   换会话前：把进度写进 HANDOFF.md，下一步写具体');
    console.log('   写好后执行：node turns.mjs reset --reason "已交接"');
    return 1;
  }
  // 没超也给「还剩多少」，因为主动换会话要发生在上下文变脏之前，不是超线之后。
  console.log(`✅ 还在安全区（${fmtSafeGap(tightest)}）`);
  for (const r of rows) console.log(`   ${fmtRow(r)}`);
  console.log('   换会话前：把进度写进 HANDOFF.md，下一步写具体');
  return 0;
}

function appendEvent(file, kind, data, now) {
  const ev = { kind, at: now, ...data };
  const line = `${JSON.stringify(ev)}\n`;
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // O_APPEND 保证一行一次写完，不会因为改写历史而丢事件。
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, line);
      // iOS 沙盒里某些文件系统不支持 fsync；writeSync 已经把事件交给内核，
      // 不能因为 fsync 抛错就报「这轮没记上」——那会诱使人重复 tick，多算一轮。
      try {
        fs.fsyncSync(fd);
      } catch {
        // 落盘时机交给系统；进程正常退出时 exitCode 会等 stdout 排空。
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    throw new GuardError(`写不进事件文件 ${file}：${error.message}；这一轮没被记录，确认目录可写或换 DSH_TURNS_FILE 再跑一次 tick`);
  }
  return ev;
}

// ---------- 命令 ----------
function cmdTick(file, opts, limits, now) {
  const events = readEvents(file);
  const sessions = buildSessions(events, now);
  const before = judge(sessions[sessions.length - 1], limits, now);
  const turns = opts['--turns'] ?? 1;
  const tokens = opts['--tokens'] ?? 0;
  const data = { turns, tokens };
  if (opts['--note'] !== undefined) data.note = opts['--note'];
  appendEvent(file, 'tick', data, now);
  // 写完立刻重新读一遍，判定用的是「真的落盘之后」的状态，不是内存里的推测。
  const after = readEvents(file);
  const sessionsAfter = buildSessions(after, now);
  const cur = sessionsAfter[sessionsAfter.length - 1];
  const verdict = judge(cur, limits, now);
  console.log(`已记 ${turns} 轮${tokens ? ` · 本轮 ${fmtNum(tokens)} tokens` : ''}${data.note ? ` · ${data.note}` : ''}`);
  // tick 也报状态：写入前就超线时必须当场喊停，否则「记完这一轮再说」永远有下一轮。
  const code = printStatus(cur, limits, now);
  if (before.over && verdict.over) {
    console.log('   注意：记这一轮之前就已经超线了；先交接再 reset，不要继续 tick。');
  }
  return code;
}

function cmdStatus(file, limits, now) {
  const sessions = buildSessions(readEvents(file), now);
  return printStatus(sessions[sessions.length - 1], limits, now);
}

function cmdReset(file, opts, limits, now) {
  const reason = opts['--reason'];
  // reset 是修复动作，但在没写交接之前就换会话，等于把记忆留在要丢掉的会话里。
  // 这句提示不能省；工具不替人判断交接是否已写好，只把代价说清楚。
  const sessions = buildSessions(readEvents(file), now);
  const prev = sessions[sessions.length - 1];
  appendEvent(file, 'reset', { reason: reason ?? '' }, now);
  const after = buildSessions(readEvents(file), now);
  const cur = after[after.length - 1];
  console.log(`会话 #${prev.id} 已结束：${fmtNum(prev.turns)} 轮 · ${fmtNum(prev.tokens)} tokens · 持续 ${fmtElapsed(sessionDuration(prev, now))}`);
  console.log(`原因：${reason ?? '（未写；下次写 --reason，history 里才查得清为什么换会话）'}`);
  printSessionHead(cur, sessionDuration(cur, now));
  console.log('✅ 新会话从 0 开始（旧记录仍留在事件文件里）');
  console.log('   如果还没交接：现在把进度写进 HANDOFF.md，下一步写具体 —— 记忆要在文件里，不在旧会话里');
  // 红线本身如果设成 0 级（不允许任何轮次），上面的 parseValue 已经拒了；
  // 新会话 0 轮 / 0 token / 0 时长，因此正常配置下必然是安全区。
  const verdict = judge(cur, limits, now);
  if (verdict.over) {
    console.log(`   ⚠ 新会话一创建就撞线：${verdict.breaches.map(fmtBreach).join('；')}。调大对应红线再继续。`);
    return 1;
  }
  return 0;
}

function cmdHistory(file, opts, limits, now) {
  const sessions = buildSessions(readEvents(file), now);
  const finished = sessions.filter((s) => s.endedAt !== null);
  const limit = opts['--limit'] ?? 10;
  const shown = finished.slice(-limit).reverse();
  if (shown.length === 0) {
    console.log('还没有已结束的会话（当前会话仍在进行中）。');
    console.log('想看当前会话：node turns.mjs status；结束它：node turns.mjs reset --reason "原因"');
  } else {
    console.log(`历次会话（共 ${finished.length} 次已结束，显示最近 ${shown.length} 次）：`);
    for (const s of shown) {
      console.log(`会话 #${s.id}：${fmtNum(s.turns)} 轮 · ${fmtNum(s.tokens)} tokens · 持续 ${fmtElapsed(sessionDuration(s, now))}`);
      console.log(`   结束原因：${s.reason || '（未写 reason）'}`);
    }
    console.log('当前会话：');
    printSessionHead(sessions[sessions.length - 1], sessionDuration(sessions[sessions.length - 1], now));
  }
  console.log('复盘看的是：哪次会话轮次最多、哪次 token 最贵、结束原因是不是「余额报错」这类被动停摆。');
  // history 是查看命令，但当前会话超线时同样返回 1：统一约定里「0 = 在安全区」，
  // 不能因为换了个子命令就把超线伪装成通过。
  const cur = judge(sessions[sessions.length - 1], limits, now);
  if (cur.over) {
    console.log('❌ 当前会话已超线，该换会话了；换会话前把进度写进 HANDOFF.md，下一步写具体');
    for (const r of cur.breaches) console.log(`   ${fmtBreach(r)}`);
    return 1;
  }
  return 0;
}

// ---------- 入口 ----------
/**
 * 输出先全部写进 stdout，退出码在写入完成后才设置。
 * 直接 process.exit() 会在输出被管道接走时丢掉最后几行（App 里 shell 输出
 * 经常是管道），「超线了但看不到为什么」比不检查更糟。
 */
function main() {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log(USAGE);
      return 0;
    }
    if (!Object.hasOwn(parsed, 'cmd')) throw new GuardError('缺命令', true);
    const { cmd, opts } = parsed;
    const file = eventFile();
    const limits = readLimits(opts);
    const now = Date.now();
    if (cmd === 'tick') return cmdTick(file, opts, limits, now);
    if (cmd === 'status') return cmdStatus(file, limits, now);
    if (cmd === 'reset') return cmdReset(file, opts, limits, now);
    if (cmd === 'history') return cmdHistory(file, opts, limits, now);
    throw new GuardError(`不认识的命令「${cmd}」`, true);
  } catch (error) {
    if (error instanceof GuardError) {
      console.error(`错误：${error.message}`);
      if (error.showUsage) console.error(`\n${USAGE}`);
      return 2;
    }
    console.error(`意外错误：${error && error.message ? error.message : String(error)}`);
    console.error('这是工具自身的错误，不是会话超线；把上面的信息和事件文件一起留证，别当作「检查通过」。');
    return 2;
  }
}

// exitCode 而不是 exit()：让 stdout 缓冲区自然排空，退出码依然是 0 / 1 / 2。
process.exitCode = main();
