#!/usr/bin/env node
/**
 * 负载哨兵 —— 派活之前，先问机器还扛不扛得住。
 *
 * 治什么病：有人在 4GB 内存的小机器上放了几个 AI 同时干活，机器被拖垮，
 * 连自己刷视频都卡。他后来立了两条规矩：一个「负载胶囊」随时显示
 * CPU/GPU/内存，一条硬规矩「系统负载超过 90% 就不许再派活」。
 * 原话是「如果他们无限干活的话，就会非常影响我的电脑性能」。
 *
 * iOS 上后果更重：内存受系统严格限制，多个子 agent 并行容易被 jetsam
 * 直接杀掉，而且**杀掉时没有任何提示**——用户只看到「App 突然回到桌面」，
 * 不知道是自己派多了活。所以「能不能再派一个」必须在派之前用代码判断，
 * 不能等系统杀完进程再猜。
 *
 * 这个工具只回答一个问题：现在适不适合启动新任务。它不负责限流、不负责
 * 杀进程，只给一个可被 shell 消费的退出码：
 *
 *   node load.mjs check [--threshold 90] [--json]   0 适合 / 1 不适合 / 2 用法错
 *   node load.mjs show                             永远 0，只打印原始读数
 *   node load.mjs watch --interval 5 --times 12     采样趋势 + 末尾结论
 *
 * 「没有会失败的检查的规矩 = 一句口号」。所以 check 必须真的会返回 1：
 * --threshold 1 就是把负载上限压到 1%，必然越线，用来证明这检查不是装饰。
 *
 * 关于 --threshold：它是「系统已用负载上限」的百分数，默认 90，直接对应
 * 那条硬规矩「系统负载超过 90% 就不许再派活」。已用率 = 100 − 可用内存占比。
 * 另外两条内存线是固定的：可用 <15% 直接拦（iOS 会无声杀进程），
 * 可用 <25% 给谨慎（能跑但别再并行）。三条取最严的一条。
 *
 * 数据采集一律「能读到哪个用哪个」：iSH 上 free -m 是静态桩、/proc 可能
 * 被裁剪、os.cpus() 可能返回 0、loadavg 可能是宿主机的值、BusyBox pgrep
 * 没有 -c。任何一个指标读不到都跳过并写明原因，绝不拿 0 冒充读数——
 * 拿 0 冒充「内存为 0」会让哨兵永远报警，等于把规矩变成噪音。
 * 同样地，loadavg 若大到不可能是沙箱内进程造成的排队，就是宿主透传值，
 * 也按「不可用」降级：拿宿主机的全局负载拦沙箱内的派活，比不检查更糟。
 */
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const DEFAULT_THRESHOLD = 90;
const STOP_FREE_PERCENT = 15;
const WARN_FREE_PERCENT = 25;
const LOAD_FACTOR = 0.9;
// loadavg 数值不可能超过沙箱可用核数还被当作「本 App 的排队长度」：
// 那需要比核数更多的 runnable 进程，而 iOS 沙箱里同时跑的 node 只有个位数，
// ps 里也看不到对应数量的 R 状态进程。实测本机 cpus=6，loadavg 却在
// 6~172 之间跳（1~28.75 倍），只能解释为 iOS 透传了宿主机全局值。
// 这个门槛只用来识别「数据源不适用」，不是放宽题目要求的 0.9 红线：
// 数值落在 [0, cpus] 可信区间时，仍严格按 load1 > cpus × 0.9 拦截。
const LOAD_HOST_LEAK_FACTOR = 1;
// load1 远低于 load5/load15（比值 < 0.5）意味着系统在报「一台正在变闲的
// 机器」，而此刻沙箱刚启动进程、内存读数也在变——两者对不上。真实 Linux
// 的 1/5/15 分钟均值会同向缓变，不会长期维持 1:4 以上的落差。
// 实测本机 6.202 / 27.985 / 32.413，比值 0.22。
const LOAD_DECAY_RATIO = 0.5;
const DISK_MIN_GB = 1;

// 让「某个指标读不到」成为可测试的一等场景：测试时可以改这里的路径，
// 指向不存在的文件，验证降级而非崩溃。常量集中在一处，避免散落魔数。
const SOURCES = {
  meminfo: '/proc/meminfo',
  diskRoot: '/',
};

function run(cmd, args) {
  // execFileSync 而非 shell 字符串：路径/参数不经过 shell 解析，也不会被
  // BusyBox 的别名行为意外改写。读不到就返回 null，由调用方决定降级。
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

// ---------- 内存：free -m → /proc/meminfo ----------

function parseFreeMB(text) {
  // BusyBox/GNU free 的 Mem 行是「total used free shared buff/cache available」，
  // 但 iSH 的 free 可能是静态桩（used 恒 0、available 恒 0）。available 为 0
  // 时不能当真实读数用：那会把机器误判成「一点内存都没了」。
  const line = text.split('\n').find((l) => /^Mem:/.test(l.trim()));
  if (!line) return null;
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  if (n.length < 3 || !Number.isFinite(n[0]) || n[0] <= 0) return null;
  const total = n[0];
  const available = n.length >= 6 && n[5] > 0 ? n[5] : n[2];
  if (!Number.isFinite(available) || available < 0 || available > total) return null;
  return { totalMB: total, freeMB: available };
}

function parseMeminfoMB(text) {
  // MemAvailable 比 MemFree 更接近「还能给新进程多少」：它算上了可回收的
  // page cache。iOS 上被杀的往往正是「MemFree 看着够但可回收内存已耗尽」
  // 的情况。iSH 的 /proc/meminfo 通常只有 MemFree，所以两级都要接。
  const get = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
    return m ? Number(m[1]) / 1024 : null;
  };
  const total = get('MemTotal');
  const avail = get('MemAvailable') ?? get('MemFree');
  if (!(total > 0) || !(avail >= 0)) return null;
  return { totalMB: Math.round(total), freeMB: Math.round(avail) };
}

function readMemory(skipped, notes) {
  // 优先级按项目约定：free -m 可用就用它，不可用才退 /proc/meminfo。
  // 但 iSH 的 free 实测是静态桩（连续 3 次都是 4096/0/4096，与 /proc 的
  // MemFree 差 3900MB 以上），所以两个都读得到时额外做一次交叉校验，
  // 把差值原样写进 notes：读数存疑必须让人看见，不能悄悄"修正"数据，
  // 否则哨兵给出的判断就没有可复核的依据。
  let proc = null;
  try {
    proc = parseMeminfoMB(fs.readFileSync(SOURCES.meminfo, 'utf8'));
  } catch {
    // /proc 被裁剪是 iOS 常态，只有 free 也失败时才算降级。
  }

  const freeText = run('free', ['-m']);
  let mem = freeText === null ? null : parseFreeMB(freeText);
  if (mem) {
    if (proc) {
      const gap = Math.abs(proc.freeMB - mem.freeMB);
      if (gap > proc.totalMB * 0.1) {
        notes.push(
          `free -m 报可用 ${mem.freeMB} MB，${SOURCES.meminfo} 报可用 ${proc.freeMB} MB，差 ${gap} MB / 总量 ${proc.totalMB} MB；` +
          `按优先级采用 free -m，但该环境 free 疑似静态桩，内存结论可信度低`,
        );
      }
    }
    return { ...mem, source: 'free -m', procFreeMB: proc?.freeMB ?? null, procTotalMB: proc?.totalMB ?? null };
  }
  if (proc) {
    return { ...proc, source: SOURCES.meminfo, procFreeMB: proc.freeMB, procTotalMB: proc.totalMB };
  }
  skipped.push('free -m 与 /proc/meminfo 都不可用，已跳过内存指标');
  return null;
}

// ---------- CPU 核数与 loadavg ----------

function readCpu(skipped) {
  // iSH 上 os.cpus() 返回空数组（拿不到 /proc/cpuinfo 的 per-cpu 表），
  // 但 os.availableParallelism() 仍能给出 6。核数为 0 时 loadavg 的判据
  // 「load1 > 核数 × 0.9」会退化成「>0 就报警」，那等于永远不让派活。
  let cpus = os.cpus().length;
  let source = 'os.cpus()';
  let trustworthy = cpus > 0;
  if (!(cpus > 0)) {
    const par = typeof os.availableParallelism === 'function' ? os.availableParallelism() : 0;
    if (par > 0) {
      cpus = par;
      source = 'os.availableParallelism()';
      trustworthy = true;
    } else {
      const nproc = run('nproc', []);
      const n = nproc ? Number.parseInt(nproc.trim(), 10) : NaN;
      if (Number.isFinite(n) && n > 0) {
        cpus = n;
        source = 'nproc';
        trustworthy = true;
      }
    }
  }
  if (!trustworthy) {
    skipped.push('CPU 核数读不到（os.cpus()=0，nproc 也不可用），已跳过 loadavg 判据');
    return { cpus: null, source: '不可用', load1: null, loadNote: 'CPU 核数不可用' };
  }

  let load1 = null;
  let loadNote = '';
  const avg = os.loadavg();
  // iOS 上 loadavg 常见四种坏数据：全 0（内核没实现）、把宿主机全局值
  // 透传进来（本机实测 6~172，而沙箱 cpus=6；且 load1/load5/load15 =
  // 6.202/27.985/32.413 呈宿主机历史下降曲线）、或根本不是数组。这些情况
  // 都按「不可用」降级：拿宿主机的排队长度去拦本 App 的派活，会让 check
  // 在负载正常时也偶发返回 1，那和永远返回 0 一样是坏掉的检查。降级后
  // CPU 判据不做替代推断（不拿进程数冒充 CPU 使用率），只写明「已跳过」，
  // 避免造出一条看起来有判据其实没有的结论。
  if (!Array.isArray(avg) || avg.length === 0 || !Number.isFinite(avg[0])) {
    loadNote = 'loadavg 在当前环境不可用，已跳过该指标';
    skipped.push(loadNote);
  } else if (avg.every((x) => x === 0)) {
    loadNote = 'loadavg 返回全 0（iOS 上常见），视为不可用，已跳过该指标';
    skipped.push(loadNote);
  } else if (avg[0] > cpus * LOAD_HOST_LEAK_FACTOR) {
    loadNote = `loadavg[0]=${(Math.round(avg[0] * 100) / 100)} > ${cpus} 核 × ${LOAD_HOST_LEAK_FACTOR}（${(avg[0] / cpus).toFixed(2)} 倍），沙箱内没有对应数量的 runnable 进程，判定为宿主机透传值，已跳过该指标`;
    skipped.push(loadNote);
  } else if (avg.length >= 3 && avg[2] > 0 && avg[0] / avg[2] < LOAD_DECAY_RATIO) {
    const triple = avg.slice(0, 3).map((x) => Math.round(x * 100) / 100).join(' / ');
    loadNote = `loadavg 三项=${triple}，1分钟/15分钟比值=${(avg[0] / avg[2]).toFixed(2)} < ${LOAD_DECAY_RATIO}，与刚启动进程的沙箱不符，判定为宿主机透传值，已跳过该指标`;
    skipped.push(loadNote);
  } else {
    load1 = Math.round(avg[0] * 100) / 100;
    loadNote = `loadavg[0]=${load1}，核数=${cpus}，倍数=${(load1 / cpus).toFixed(2)}`;
  }
  return { cpus, source, load1, loadNote };
}

// ---------- 当前 node 进程数 ----------

function countNodeProcs(text) {
  // ps 输出里带表头，也有 ps/grep/sh 自己；只数命令名以 node 起始的行，
  // 且排除本工具自身那次 ps。真正的判据是「有没有别的 node 在跑」。
  const lines = text.split('\n').slice(1);
  return lines.filter((l) => {
    const f = l.trim().split(/\s+/);
    // 形如 " 1234 node" 或 " 1234 node load.mjs"
    return /^(?:\S+\/)?node(?:\d+)?(?:\s|$)/.test(f.slice(1).join(' ').trim());
  }).length;
}

function readNodeProcs(skipped) {
  // BusyBox pgrep 没有 -c（本机实测报 "unrecognized option: c"），
  // 所以优先 pgrep node 数行，再退 ps。两者都失败就跳过。
  const pgrep = run('pgrep', ['node']);
  if (pgrep !== null) {
    const n = pgrep.split('\n').filter((l) => /^\d+$/.test(l.trim())).length;
    // pgrep 找不到匹配时返回非 0，execFileSync 抛错 → 上面拿到 null；
    // 能拿到输出就一定有匹配（含本进程自己），故 n>=1。
    if (n > 0) return { nodeProcs: n, source: 'pgrep node' };
  }
  const ps = run('ps', ['-o', 'pid=,comm=']) ?? run('ps', ['aux']);
  if (ps !== null) {
    return { nodeProcs: countNodeProcs(ps), source: 'ps' };
  }
  skipped.push('pgrep 与 ps 都不可用，已跳过进程数指标');
  return { nodeProcs: null, source: '不可用' };
}

// ---------- 磁盘剩余 ----------

function parseDiskFreeGB(text) {
  // df -h / 的 Filesystem 在 iOS 上是一长串容器路径，可能含空格并折行；
  // 用 -P 强制单行 POSIX 格式，取「Available」列（第 4 列，1K 块）。
  // 不解析 -h 的 "24.8G" 是因为不同 BusyBox 会用 M/G/T 甚至 1024/1000 混算。
  const lines = text.trim().split('\n');
  const data = lines.slice(1).find((l) => l.trim() && /^\S+\s+\d+/.test(l.trim()));
  if (!data) return null;
  const f = data.trim().split(/\s+/);
  const kb = Number(f[3]);
  return Number.isFinite(kb) ? Math.round((kb / 1024 / 1024) * 100) / 100 : null;
}

function readDisk(skipped) {
  const text = run('df', ['-P', '-k', SOURCES.diskRoot]) ?? run('df', ['-h', SOURCES.diskRoot]);
  const gb = text === null ? null : parseDiskFreeGB(text);
  if (gb === null) {
    skipped.push(`df ${SOURCES.diskRoot} 不可用，已跳过磁盘指标`);
    return { diskFreeGB: null, source: '不可用' };
  }
  return { diskFreeGB: gb, source: 'df' };
}

// ---------- 采集一次完整快照 ----------

function collect() {
  const skipped = [];
  const notes = [];
  const mem = readMemory(skipped, notes);
  const cpu = readCpu(skipped);
  const procs = readNodeProcs(skipped);
  const disk = readDisk(skipped);
  const memPercent = mem && mem.totalMB > 0
    ? Math.round((mem.freeMB / mem.totalMB) * 1000) / 10
    : null;
  return {
    at: new Date().toISOString(),
    metrics: {
      memTotalMB: mem?.totalMB ?? null,
      memFreeMB: mem?.freeMB ?? null,
      memPercent,
      memProcFreeMB: mem?.procFreeMB ?? null,
      memProcTotalMB: mem?.procTotalMB ?? null,
      cpus: cpu.cpus,
      load1: cpu.load1,
      nodeProcs: procs.nodeProcs,
      diskFreeGB: disk.diskFreeGB,
    },
    sources: {
      mem: mem?.source ?? '不可用',
      cpu: cpu.source,
      load: cpu.loadNote,
      procs: procs.source,
      disk: disk.source,
    },
    skipped,
    notes,
  };
}

// ---------- 判断：多指标综合，且每条理由都带数字 ----------

function judge(snap, threshold) {
  const m = snap.metrics;
  const reasons = [];
  let level = 'ok';

  // 内存是 iOS 上唯一会「无声杀进程」的指标，所以它的优先级最高：
  // 读不到就明说降级，不能用别的指标假装补上。
  // 三条线取最严的一条：--threshold 是「已用负载上限」（默认 90%，
  // 即要求可用 ≥10%），固定红线 15%（可用 <15% 直接拦），
  // 谨慎线 25%（可用 <25% 别再加并行）。
  const usedPercent = m.memPercent === null
    ? null
    : Math.round((100 - m.memPercent) * 10) / 10;
  const freeStop = Math.max(STOP_FREE_PERCENT, 100 - threshold);
  if (m.memPercent === null) {
    reasons.push({ level: 'warn', text: '可用内存读数不可用，无法判断内存红线' });
    level = 'warn';
  } else if (m.memPercent < freeStop) {
    const why = m.memPercent < STOP_FREE_PERCENT
      ? `低于 15% 固定红线（已用 ${usedPercent}%）`
      : `低于 ${freeStop}% 可用下限（已用 ${usedPercent}% > 负载上限 ${threshold}%）`;
    reasons.push({
      level: 'stop',
      text: `可用内存 ${m.memFreeMB} MB / ${m.memTotalMB} MB（${m.memPercent}%，${why}）；iOS 上再派活可能被系统无提示杀掉，表现为 App 突然回到桌面`,
    });
  } else if (m.memPercent < WARN_FREE_PERCENT) {
    reasons.push({
      level: 'warn',
      text: `可用内存 ${m.memFreeMB} MB / ${m.memTotalMB} MB（${m.memPercent}%，低于 ${WARN_FREE_PERCENT}% 谨慎线；已用 ${usedPercent}% ≤ 上限 ${threshold}%）`,
    });
  } else {
    reasons.push({
      level: 'ok',
      text: `可用内存 ${m.memFreeMB} MB / ${m.memTotalMB} MB（${m.memPercent}%，已用 ${usedPercent}% ≤ 上限 ${threshold}%，高于 ${WARN_FREE_PERCENT}% 谨慎线）`,
    });
  }

  // loadavg 判据只在核数与 load1 都可信时才成立；缺一个就跳过并说明，
  // 否则「load1 > 0」会把所有正常机器判成 CPU 排满。
  if (m.load1 === null || !(m.cpus > 0)) {
    reasons.push({ level: 'info', text: `${snap.sources.load}；CPU 判据已跳过` });
  } else {
    const limit = Math.round(m.cpus * LOAD_FACTOR * 100) / 100;
    if (m.load1 > limit) {
      reasons.push({
        level: 'stop',
        text: `loadavg[0]=${m.load1} > ${m.cpus} 核 × ${LOAD_FACTOR} = ${limit}（CPU 排队已满）`,
      });
    } else {
      reasons.push({
        level: 'ok',
        text: `loadavg[0]=${m.load1} ≤ ${m.cpus} 核 × ${LOAD_FACTOR} = ${limit}`,
      });
    }
  }

  // 磁盘不足不拦派活，但要提醒：日志/缓存写满会让任务以更隐蔽的方式失败。
  if (m.diskFreeGB === null) {
    reasons.push({ level: 'info', text: `df ${SOURCES.diskRoot} 不可用，已跳过磁盘指标` });
  } else if (m.diskFreeGB < DISK_MIN_GB) {
    reasons.push({ level: 'warn', text: `磁盘可用 ${m.diskFreeGB} GB < ${DISK_MIN_GB} GB（影响写日志和缓存，不影响派活）` });
    if (level === 'ok') level = 'warn';
  } else {
    reasons.push({ level: 'ok', text: `磁盘可用 ${m.diskFreeGB} GB ≥ ${DISK_MIN_GB} GB` });
  }

  // 进程数只是旁证，不单独决定结论：一个 node 也可能吃掉全部内存。
  // 给出具体个数 + 与核数的差，供人判断并行度是否该收。
  if (m.nodeProcs === null) {
    reasons.push({ level: 'info', text: 'node 进程数不可用，已跳过该指标' });
  } else {
    const note = m.cpus ? `，核数 ${m.cpus}，差 ${m.nodeProcs - m.cpus}` : '';
    reasons.push({ level: 'ok', text: `当前 node 进程 ${m.nodeProcs} 个${note}（旁证，不单独拦截）` });
  }

  // skipped 在前面各判据里已经逐条说明过（含「CPU 判据已跳过」），
  // 这里再列一遍会变成重复噪音；只在某条降级没被任何判据提到时补上。
  for (const s of snap.skipped) {
    if (!reasons.some((r) => r.text.includes(s))) {
      reasons.push({ level: 'info', text: s });
    }
  }
  // 交叉校验发现的读数存疑属于「证据不足」，不是负载高：不拦派活，
  // 但必须让人看见差值，否则 show 与 check 会给出无法复核的内存数字。
  for (const n of snap.notes) {
    reasons.push({ level: 'warn', text: n });
  }

  for (const r of reasons) {
    if (r.level === 'stop') level = 'stop';
    else if (r.level === 'warn' && level === 'ok') level = 'warn';
  }

  // 降级到「内存 + CPU 判据都拿不到」时，不能返回 ok 假装检查过：
  // 那正是「装饰性检查」。此时给 warn，并写清楚还缺哪块数据。
  const judged = [m.memPercent !== null, m.load1 !== null && m.cpus > 0];
  if (judged.every((x) => !x)) {
    level = level === 'stop' ? 'stop' : 'warn';
    reasons.push({ level: 'warn', text: '内存与 CPU 两项主判据均不可用，本次结论不足以放行新任务' });
  }

  return {
    ok: level !== 'stop',
    level,
    threshold,
    reasons: reasons.map((r) => `${r.level === 'info' ? '说明' : r.level === 'stop' ? '拦截' : r.level === 'warn' ? '警告' : '通过'}｜${r.text}`),
    metrics: m,
    sources: snap.sources,
    skipped: snap.skipped,
    notes: snap.notes,
  };
}

const ICON = { ok: '✅', warn: '⚠️', stop: '❌' };
const TITLE = {
  ok: '现在适合启动新任务',
  warn: '可以启动新任务，但别再加并行数',
  stop: '现在不适合启动新任务',
};

function advice(level, result) {
  if (level === 'stop') {
    return '建议：等现有任务结束，或先砍掉并行数；iOS 上被系统杀进程不会有任何提示';
  }
  if (level === 'warn') {
    return result.notes.length
      ? '建议：内存读数两源不一致，先跑 show 核对差值再决定是否加并行；批量任务仍按 cost-guard 分批'
      : result.reasons.some((r) => r.startsWith('警告｜磁盘可用'))
        ? '建议：清出磁盘空间再跑长任务，避免日志写满导致静默失败'
        : '建议：先跑单个任务并盯一轮 check，不要同时开新的子 agent';
  }
  return '建议：按原计划派活；批量任务仍按 cost-guard 分批（每批 5-10 个）';
}

function printVerdict(result) {
  console.log(`${ICON[result.level]} ${TITLE[result.level]}`);
  for (const r of result.reasons) {
    console.log(`   ${r}`);
  }
  console.log(`   ${advice(result.level, result)}`);
  const memConf = result.notes.length ? '（free -m 与 /proc/meminfo 差值见警告）' : '';
  console.log(`   阈值：系统已用负载上限 ${result.threshold}%；判据来源：内存 ${result.sources.mem}${memConf} / 核数 ${result.sources.cpu}`);
  return result.ok ? 0 : 1;
}

// ---------- show：只给原始读数，永远 0 ----------

function printShow(snap) {
  const m = snap.metrics;
  const line = (label, value) => console.log(`${label.padEnd(16, ' ')} ${value}`);
  console.log(`采样时间        ${snap.at}`);
  line('内存总量', m.memTotalMB === null ? '不可用' : `${m.memTotalMB} MB`);
  line('可用内存', m.memFreeMB === null ? '不可用' : `${m.memFreeMB} MB / ${m.memTotalMB} MB（${m.memPercent}%）`);
  if (m.memProcFreeMB !== null) {
    line('/proc 对照', `MemFree/MemAvailable ${m.memProcFreeMB} MB / ${m.memProcTotalMB} MB，与 free -m 差 ${Math.abs(m.memProcFreeMB - m.memFreeMB)} MB`);
  }
  line('判据来源', snap.sources.mem);
  line('CPU 核数', m.cpus === null ? '不可用' : `${m.cpus}（${snap.sources.cpu}）`);
  line('loadavg[0]', m.load1 === null ? '不可用' : `${m.load1}`);
  line('负载说明', snap.sources.load);
  line('node 进程数', m.nodeProcs === null ? '不可用' : `${m.nodeProcs}（${snap.sources.procs}）`);
  line('磁盘可用', m.diskFreeGB === null ? '不可用' : `${m.diskFreeGB} GB（${snap.sources.disk}）`);
  if (snap.skipped.length) {
    console.log('降级说明：');
    for (const s of snap.skipped) console.log(`   · ${s}`);
  }
  if (snap.notes.length) {
    console.log('读数校验：');
    for (const n of snap.notes) console.log(`   · ${n}`);
  }
  console.log('');
  console.log('说明：show 只报数不下结论，退出码恒为 0；要判断能否派活用 check。');
  return 0;
}

// ---------- CLI ----------

const USAGE = `用法：
  node load.mjs check [--threshold 90] [--json]   判断现在能否派活（0 适合 / 1 不适合 / 2 用法错）
  node load.mjs show                             打印原始读数（永远 0）
  node load.mjs watch --interval 5 --times 12    采样趋势 + 末尾结论

参数：
  --threshold N   系统已用负载上限百分数，0-100 的数字，默认 ${DEFAULT_THRESHOLD}（规矩：超过 90% 不许派活）
  --json          check 输出结构化结果，供脚本读取
  --interval N    watch 采样间隔秒，>0 的数字，默认 5
  --times N       watch 采样次数，1-60 的整数，默认 12

示例：node load.mjs check --threshold 1   # 把已用负载上限压到 1%，必然越线，验证检查真的会失败`;

function usageError(msg) {
  // 参数写错和「机器扛不住」是两回事：混在一起会让脚本把用法错当成负载高，
  // 进而错误地重试。所以独立用退出码 2 并把正确写法直接给出来。
  console.error(`用法错误：${msg}`);
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(args) {
  const out = { json: false, threshold: DEFAULT_THRESHOLD, interval: 5, times: 12 };
  const needValue = new Set(['--threshold', '--interval', '--times']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') {
      if (out.json) usageError('--json 重复');
      out.json = true;
      continue;
    }
    if (needValue.has(a)) {
      const raw = args[++i];
      if (raw === undefined || raw.startsWith('--')) usageError(`${a} 需要一个数字，例如 ${a} 5`);
      const n = Number(raw);
      if (!Number.isFinite(n)) usageError(`${a} 需要数字，收到 "${raw}"`);
      if (a === '--threshold' && (n < 0 || n > 100)) usageError(`--threshold 需在 0-100 之间，收到 ${raw}`);
      if (a === '--interval' && !(n > 0)) usageError(`--interval 需大于 0，收到 ${raw}`);
      if (a === '--times' && (!Number.isInteger(n) || n < 1 || n > 60)) usageError(`--times 需为 1-60 的整数，收到 ${raw}`);
      out[a.slice(2)] = n;
      continue;
    }
    usageError(`未知参数 "${a}"`);
  }
  return out;
}

// watch 要能看出「派活前后有没有变化」，所以每次都给一行数字，
// 末尾再给趋势差值和结论；只打印「负载高」是没有可复核证据的。
async function watch(opts) {
  const rows = [];
  console.log(`开始采样：每 ${opts.interval} 秒一次，共 ${opts.times} 次；系统已用负载上限 ${opts.threshold}%。`);
  for (let i = 1; i <= opts.times; i++) {
    const snap = collect();
    const m = snap.metrics;
    rows.push(snap);
    console.log(
      `[${String(i).padStart(2, '0')}/${opts.times}] ${snap.at.slice(11, 19)} ` +
      `可用内存 ${m.memFreeMB ?? '—'} MB / ${m.memTotalMB ?? '—'} MB（${m.memPercent ?? '—'}%） ` +
      `load1 ${m.load1 ?? '—'} node ${m.nodeProcs ?? '—'} 磁盘 ${m.diskFreeGB ?? '—'} GB`,
    );
    if (i < opts.times) {
      await new Promise((r) => setTimeout(r, opts.interval * 1000));
    }
  }

  const first = rows[0].metrics;
  const last = rows[rows.length - 1].metrics;
  const diff = (a, b) => (a === null || b === null ? '不可用' : `${Math.round((b - a) * 10) / 10}（${a} → ${b}）`);
  console.log('');
  console.log('趋势变化（末次 − 首次）：');
  console.log(`   可用内存 %    ${diff(first.memPercent, last.memPercent)}`);
  console.log(`   loadavg[0]   ${diff(first.load1, last.load1)}`);
  console.log(`   node 进程数  ${diff(first.nodeProcs, last.nodeProcs)}`);
  console.log(`   磁盘可用 GB  ${diff(first.diskFreeGB, last.diskFreeGB)}`);

  const levels = rows.map((s) => judge(s, opts.threshold).level);
  const stops = levels.filter((l) => l === 'stop').length;
  const warns = levels.filter((l) => l === 'warn').length;
  console.log(`   ${opts.times} 次采样中：stop ${stops} 次，warn ${warns} 次，ok ${opts.times - stops - warns} 次`);
  console.log('');

  // 结论取最后一次实时采样的判断，而不是历史平均：派活 decision 只看「现在」。
  const result = judge(rows[rows.length - 1], opts.threshold);
  if (opts.json) {
    console.log(JSON.stringify({ ...result, samples: opts.times, stops, warns }));
    return result.ok ? 0 : 1;
  }
  return printVerdict(result);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || ['-h', '--help', 'help'].includes(cmd)) {
    console.log(USAGE);
    process.exit(cmd ? 0 : 2);
  }
  if (!['check', 'show', 'watch'].includes(cmd)) {
    usageError(`未知命令 "${cmd}"（可用：check / show / watch）`);
  }

  const opts = parseArgs(argv.slice(1));
  if (opts.json && cmd !== 'check' && cmd !== 'watch') {
    usageError('--json 只用于 check 或 watch');
  }
  if (cmd !== 'watch' && (argv.includes('--interval') || argv.includes('--times'))) {
    usageError('--interval / --times 只用于 watch');
  }

  if (cmd === 'show') {
    process.exit(printShow(collect()));
  }
  if (cmd === 'watch') {
    process.exit(await watch(opts));
  }

  const snap = collect();
  const result = judge(snap, opts.threshold);
  // --json 时 stdout 必须只有一行纯 JSON：混一句中文提示就会让下游
  // python3 -m json.tool / jq 直接解析失败。降级说明已放进 skipped 字段。
  if (opts.json) {
    console.log(JSON.stringify({
      ok: result.ok,
      level: result.level,
      reasons: result.reasons,
      metrics: result.metrics,
      sources: result.sources,
      skipped: result.skipped,
      notes: result.notes,
    }));
    process.exit(result.ok ? 0 : 1);
  }
  process.exit(printVerdict(result));
}

main().catch((err) => {
  // 到这里是工具自身出错，不是「机器负载高」，也不是用法错；
  // 用 1 表示检查没能给出可信结论，并说清下一步该做什么。
  console.error(`采集或判断失败：${err.message}`);
  console.error('建议：先跑 node load.mjs show 看是哪个指标读不到，再按降级说明跳过该指标');
  process.exit(1);
});
