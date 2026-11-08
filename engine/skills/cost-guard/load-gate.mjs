#!/usr/bin/env node
/**
 * 负载闸（iOS 版）—— 负载太高就不许再派活。
 *
 * 移植来源：luanyujia-workbench 的 `负载闸.mjs`。用户 2026-10-16 定的硬规矩：
 *   「内存以及 CPU 大于 90 的时候不可以再派子代理，严格不超过 95」
 * 本文件保留那条判据，但采样方式必须换掉：原版是 Windows PowerShell + WMI，
 * iOS 上不存在；而且 iSH 的 `free -m` 是**静态桩**（固定返回 4096/0/4096），
 * 拿它判断等于没判断——这是本项目踩过的坑。
 *
 * 判据（只在这里定义，别处不许再算一套）：
 *   内存 = 1 - MemAvailable/MemTotal，直接读 /proc/meminfo
 *   CPU  = /proc/stat 累计 tick 差分，采样 2 次、间隔 1.5s 取均值（单次太抖）
 *
 *   CPU 与内存都 < 90%        ⇒ ✓ 可派单   → 退出码 0
 *   任一 ≥ 90%（且都 <95%）   ⇒ ⚠ 停止派单 → 退出码 10
 *   任一 ≥ 95%                ⇒ ⛔ 停重活   → 退出码 20
 *   量不了（/proc 不可读）    ⇒ 无法判定   → 退出码 3
 *
 * ⚠ 10/20/3 都不是 0。调用方一律当「别派」处理最安全。
 * ⚠ 本工具只读：不写文件、不杀进程。
 *
 * 用法：
 *   node load-gate.mjs            一行结论
 *   node load-gate.mjs --json     完整数据
 *   node load-gate.mjs --quiet    只打结论
 *   node load-gate.mjs --min-ok 80 --min-warn 92   覆盖阈值（仅用于负例自测）
 */
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const MEM_STOP = 90;
const MEM_HEAVY = 95;
const CPU_STOP = 90;
const CPU_HEAVY = 95;

function readMem() {
  // 优先 /proc/meminfo 的 MemAvailable：它是内核算好的「真实可用」，含可回收缓存。
  //
  // ⚠ 关键坑（实测）：iSH 的 /proc/meminfo **没有 MemAvailable 字段**，只有 MemFree，
  // 而 MemFree 是内核空闲页（示例：64MB/4GB），不含可回收缓存。用它算「已用」
  // 会得出 97% 这种假警报——实测同一时刻 os.freemem() 报 3447MB 空闲（18% 已用），
  // 两者差 80 个百分点。用错指标会让负载闸把每一次派活都拒掉，等于功能全禁。
  // 所以：MemAvailable 拿不到时，退回 os.freemem()，**绝不用 MemFree**。
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const field = (k) => {
      const m = new RegExp(`^${k}:\\s+(\\d+)\\s+kB`, 'm').exec(text);
      return m ? Number(m[1]) : null;
    };
    const total = field('MemTotal');
    const available = field('MemAvailable');
    if (total && available !== null) {
      return {
        totalMB: Math.round(total / 1024),
        freeMB: Math.round(available / 1024),
        usedRatio: 1 - available / total,
        source: 'meminfo:MemAvailable',
      };
    }
    // 退路：Node 的 freemem（iOS 上是真实值）
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    if (!totalBytes) return null;
    return {
      totalMB: Math.round(totalBytes / 1048576),
      freeMB: Math.round(freeBytes / 1048576),
      usedRatio: 1 - freeBytes / totalBytes,
      source: 'os.freemem',
    };
  } catch {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    if (!totalBytes) return null;
    return {
      totalMB: Math.round(totalBytes / 1048576),
      freeMB: Math.round(freeBytes / 1048576),
      usedRatio: 1 - freeBytes / totalBytes,
      source: 'os.freemem',
    };
  }
}

/** /proc/stat 第一行累计 tick；返回 {idle, total}。 */
function cpuTicks() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const idle = parts[3] + (parts[4] ?? 0);
    return { idle, total: parts.reduce((a, b) => a + b, 0) };
  } catch { return null; }
}

export async function sample() {
  const a = cpuTicks();
  await new Promise((r) => setTimeout(r, 1500));
  const b = cpuTicks();
  const mem = readMem();
  if (!a || !b || !mem) return null;
  const dt = b.total - a.total;
  const busy = dt > 0 ? (dt - (b.idle - a.idle)) / dt : null;
  return {
    time: new Date().toISOString(),
    cpu: busy === null ? null : Number((busy * 100).toFixed(1)),
    mem: Number((mem.usedRatio * 100).toFixed(1)),
    totalMB: mem.totalMB,
    freeMB: mem.freeMB,
    // 数据来源要透出：MemFree 与 os.freemem 差 80 个百分点，排查时第一眼看这个。
    source: mem.source,
  };
}

export function verdict(s) {
  if (!s || s.cpu === null) return { code: 3, label: '无法判定', exit: 3 };
  const worst = Math.max(s.cpu, s.mem);
  if (worst >= Math.max(MEM_HEAVY, CPU_HEAVY)) return { code: 20, label: '⛔ 停重活', exit: 20 };
  if (worst >= Math.max(MEM_STOP, CPU_STOP)) return { code: 10, label: '⚠ 停止派单', exit: 10 };
  return { code: 0, label: '✓ 可派单', exit: 0 };
}

// 只有直接运行时才采样并退出。被 import 时只导出 sample/verdict：
// 顶层 exit 会让任何 import 它的代码（测试、插件、其他工具）整个进程退出，
// 这是实测踩到的坑——测试跑一半直接以退出码 20 结束，看起来像断言失败。
const invokedDirectly = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('负载闸：CPU/内存 ≥90% 停派单，≥95% 停重活。退出码 0/10/20/3');
    process.exit(0);
  }
  const data = await sample();
  const v = verdict(data);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ...data, verdict: v }, null, 2));
  } else if (data) {
    const head = `负载闸：CPU ${data.cpu}% · 内存 ${data.mem}%（剩 ${data.freeMB}/${data.totalMB}MB）`;
    console.log(args.includes('--quiet') ? v.label : `${head} → ${v.label}`);
  } else {
    console.log('⚠ 无法判定：读不到 /proc/meminfo 或 /proc/stat');
  }
  process.exit(v.exit);
}
