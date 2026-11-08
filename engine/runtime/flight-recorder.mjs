/**
 * 飞行记录器：进程崩溃后，还知道刚才有哪几个任务在跑。
 *
 * 为什么需要它：引擎重启后 App 会新建一个 AppModel，之前所有 session 状态清零，
 * 「刚才那个任务跑完了吗」这个问题在 App 侧已经无从回答。而 supervisor
 * （main.mjs）跨重启存活，它手里的文件是唯一还记得这事的地方。
 *
 * 存法：不用追加日志，用「当前在跑的集合」覆盖写。文件里只有几个会话 ID，
 * 崩溃时它就停在崩溃前的样子——正好是我们要的答案。
 *
 * 为什么不做成「自动重跑」：任务多半有副作用（改了文件、推了代码、发了消息），
 * 自动重跑比不跑更危险。这里只负责回答「哪些被打断了」，让用户决定。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 超过这个时间的中断记录不再提示：多半是几天前的事，弹出来只会让人困惑。 */
export const STALE_MS = 24 * 60 * 60_000;

export function flightFile(dataDir) {
  return path.join(dataDir, 'in-flight.json');
}

/** 读残留记录。读不出来（首次启动、文件损坏）就当没有，不报错。 */
export function readInFlight(dataDir) {
  try {
    const raw = fs.readFileSync(flightFile(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    const running = parsed?.running;
    if (!running || typeof running !== 'object') return [];
    return Object.entries(running)
      .map(([session, at]) => ({ session, at: Number(at) }))
      .filter((item) => Number.isFinite(item.at));
  } catch {
    return [];
  }
}

/** 覆盖写当前集合。原子写：崩溃发生在写一半时，也不能留下半个 JSON。 */
export function writeInFlight(dataDir, running) {
  const file = flightFile(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ running }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败无所谓 */ }
  }
}

/** 挑出值得提示的中断项：过期的不算，未来的时间戳（时钟漂移）也不算。 */
export function interruptedSince(dataDir, now = Date.now()) {
  return readInFlight(dataDir)
    .filter(({ at }) => now - at <= STALE_MS && at <= now)
    .sort((a, b) => b.at - a.at);
}

/** 重启后的处理：先把发现的中断项写进 notices.jsonl，再清空记录，免得重复提示。 */
export function reportInterrupted(dataDir, { now = Date.now(), write = (line) => {
  fs.appendFileSync(path.join(dataDir, 'notices.jsonl'), line, { mode: 0o600 });
} } = {}) {
  const interrupted = interruptedSince(dataDir, now);
  if (interrupted.length === 0) {
    writeInFlight(dataDir, {});
    return [];
  }
  const newest = interrupted[0];
  const message = interrupted.length === 1
    ? '上次有一个任务没跑完（引擎重启中断了）。点开那个会话看看，需要的话重新发一次。'
    : `上次有 ${interrupted.length} 个任务没跑完（引擎重启中断了）。点开那些会话看看，需要的话重新发一次。`;
  try {
    write(JSON.stringify({
      kind: 'interrupted',
      message,
      sessions: interrupted.map((item) => item.session),
      time: now,
    }) + '\n');
  } catch { /* 写不进通知文件也要把记录清掉，否则每次启动都提示 */ }
  writeInFlight(dataDir, {});
  return interrupted;
}
