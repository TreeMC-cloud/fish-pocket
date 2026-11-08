/**
 * 飞行记录器：进程崩溃后，还知道刚才有哪几个任务在跑、跑到哪一步。
 *
 * 为什么需要它：引擎重启后 App 会新建一个 AppModel，之前所有 session 状态清零，
 * 「刚才那个任务跑完了吗」这个问题在 App 侧已经无从回答。而 supervisor
 * （main.mjs）跨重启存活，它手里的文件是唯一还记得这事的地方。
 *
 * 存法：不用追加日志，用「当前在跑的集合」覆盖写。文件里只有几个会话 ID 和
 * 最后一步，崩溃时它就停在崩溃前的样子——正好是我们要的答案。
 *
 * 为什么不做成「自动重跑」：任务多半有副作用（改了文件、推了代码、发了消息），
 * 自动重跑比不跑更危险。这里只负责回答「哪些被打断了、断在哪」，让用户决定。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 超过这个时间的中断记录不再提示：多半是几天前的事，弹出来只会让人困惑。 */
export const STALE_MS = 24 * 60 * 60_000;

export function flightFile(dataDir) {
  return path.join(dataDir, 'in-flight.json');
}

/**
 * 一个条目的统一形状：`{ at, step }`。
 *
 * 兼容早期只存时间戳的格式（`{"s1": 1794...}`）：那种记录里的 step 是空的，
 * 不影响提示，只是说不出断在哪一步。已经装在用户手机上的旧文件不能因为
 * 升级就读不出来了。
 */
function normalize(session, value) {
  if (typeof value === 'number') return { session, at: value, step: '' };
  if (!value || typeof value !== 'object') return null;
  const at = Number(value.at);
  if (!Number.isFinite(at)) return null;
  return { session, at, step: typeof value.step === 'string' ? value.step : '' };
}

/** 读残留记录。读不出来（首次启动、文件损坏）就当没有，不报错。 */
export function readInFlight(dataDir) {
  try {
    const raw = fs.readFileSync(flightFile(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    const running = parsed?.running;
    if (!running || typeof running !== 'object') return [];
    return Object.entries(running)
      .map(([session, value]) => normalize(session, value))
      .filter(Boolean);
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

/**
 * 把工具名翻译成一句人话，用在「停在『正在运行命令』这一步」里。
 *
 * 为什么不直接用工具名：`bash`、`apply_patch` 这些是给开发者的词，
 * 用户看到不知道在干什么。这里只保留几个动作类别，说不清的退回「调用工具」。
 * 与 App 里 StepKind 的口径一致，但故意更粗——中断提示只需要一个方向感。
 */
export function describeStep(toolName, summary) {
  const name = String(toolName ?? '').split('__').pop() ?? '';
  const detail = typeof summary === 'string' && summary.trim() ? summary.trim() : '';
  const label = (() => {
    switch (name) {
      case 'read': case 'read_image': return '正在读取文件';
      case 'grep': case 'glob': return '正在搜索代码';
      case 'write': return '正在写入文件';
      case 'edit': case 'apply_patch': return '正在修改文件';
      case 'bash': case 'pwsh': case 'exec_command': case 'write_stdin': return '正在运行命令';
      case 'run_code': return '正在运行代码';
      case 'web_search': return '正在搜索网页';
      case 'web_fetch': return '正在访问网页';
      case 'ask_user_question': case 'request_user_input': return '正在等你回答';
      default:
        if (name.startsWith('subagent')) return '正在协调子智能体';
        if (name.startsWith('terminal_')) return '正在运行命令';
        return '正在调用工具';
    }
  })();
  // 有摘要就带上，但截短：提示是一行字，不是日志。
  return detail ? `${label}（${detail.slice(0, 40)}）` : label;
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
  // 只有一个任务时，把它断在哪一步说出来——「被打断了」和「断在 npm run build」
  // 对用户的价值差很远：后者能直接判断要不要重跑、会不会有半成品文件。
  const only = interrupted.length === 1 ? interrupted[0] : null;
  const step = only?.step ? `，停在「${only.step}」这一步` : '';
  const message = interrupted.length === 1
    ? `被引擎重启中断${step}。先看看已经改了什么，再决定要不要重新发一次。`
    : `${interrupted.length} 个任务被引擎重启中断。先看看各自改了什么，再决定要不要重新发。`;
  try {
    write(JSON.stringify({
      kind: 'interrupted',
      message,
      sessions: interrupted.map((item) => item.session),
      steps: Object.fromEntries(interrupted.map((item) => [item.session, item.step])),
      time: now,
    }) + '\n');
  } catch { /* 写不进通知文件也要把记录清掉，否则每次启动都提示 */ }
  writeInFlight(dataDir, {});
  return interrupted;
}
