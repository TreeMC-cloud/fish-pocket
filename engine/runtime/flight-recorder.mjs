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
import { createRequire } from 'node:module';

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
  if (typeof value === 'number') return { session, at: value, step: '', turn: null };
  if (!value || typeof value !== 'object') return null;
  const at = Number(value.at);
  if (!Number.isFinite(at)) return null;
  return {
    session,
    at,
    step: typeof value.step === 'string' ? value.step : '',
    turn: Number.isInteger(value.turn) ? value.turn : null,
  };
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

/**
 * 重启后的处理：把发现的中断项转成等待投递事件，**投递成功写入后**才清空记录。
 *
 * 为什么要改（原来的洞）：
 *   旧实现直接 append notices.jsonl，写失败时 catch 掉然后照样清空 in-flight.json——
 *   注释写的是「否则每次启动都提示」，但代价是**唯一的中断证据被永久丢弃**。
 *   磁盘满、权限错、目录被清空时，用户永远不知道上一个任务断了。
 *
 * 现在的顺序：
 *   1. 把中断事件写进 task registry 的 outbox（与任务表同一次原子写）
 *   2. 只有第 1 步成功，才清空 in-flight.json
 *   3. 投递由 auto-guard 每轮 flush，失败会留到下一轮重试
 *
 * 语义变化：从「尽力而为、失败就丢」变成「至少投递一次」。可能重复（若 ack 前又崩溃），
 * 但重复提醒远好于静默丢失；App 侧按 eventId 去重。
 */
export function reportInterrupted(dataDir, { now = Date.now(), write = null } = {}) {
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
  const event = {
    kind: 'interrupted',
    message,
    sessions: interrupted.map((item) => item.session),
    steps: Object.fromEntries(interrupted.map((item) => [item.session, item.step])),
    turns: Object.fromEntries(interrupted.map((item) => [item.session, item.turn])),
    time: now,
  };

  // 测试可以注入 write 来模拟「写不进去」；生产走 outbox。
  let recorded = false;
  try {
    if (typeof write === 'function') {
      write(JSON.stringify(event) + '\n');
      recorded = true;
    } else {
      // 延迟 import：flight-recorder 被 task-registry 之外的地方引用时不强依赖它。
      const { load, save, enqueue } = requireTaskRegistry();
      const state = load(dataDir);
      enqueue(state, {
        kind: 'interrupted',
        message,
        taskId: null,
        detail: {
          kind: 'interrupted',
          sessions: event.sessions,
          steps: event.steps,
          turns: event.turns,
        },
      }, now);
      save(state, dataDir);
      recorded = true;
    }
  } catch { recorded = false; }

  // 关键：写失败就不清空。留下记录，下次启动还能再试一次。
  if (recorded) writeInFlight(dataDir, {});
  return interrupted;
}

/**
 * 同步拿到 task-registry 的导出。
 *
 * 为什么按需加载而不是顶层 import：flight-recorder 是更底层的模块，task-registry
 * 又用同一个数据目录；顶层互相 import 在 ESM 里可能拿到半初始化的命名空间。
 * 按需同步加载最稳，两个模块本身都只依赖文件系统，不存在真正的环。
 */
function requireTaskRegistry() {
  if (!globalThis.__taskRegistry) {
    const req = createRequire(import.meta.url);
    globalThis.__taskRegistry = req('./task-registry.mjs');
  }
  return globalThis.__taskRegistry;
}

