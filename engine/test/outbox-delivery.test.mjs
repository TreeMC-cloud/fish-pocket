import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Router } from '../runtime/router.mjs';
import { load, pendingOutbox } from '../runtime/task-registry.mjs';
import { createNoticeAdmission } from '../runtime/notice-admission.mjs';

/**
 * 端到端：Router 队列里的事件，到底能不能送到用户面前。
 *
 * ## 被验证的链路（App 里实际跑的那条）
 *
 *   Router.runOne() 失败 → enqueue() → tasks.json 的 outbox
 *     → auto-guard.flushTaskOutbox()（由 15 秒调度循环的那一拍触发）
 *     → notify() → worker.parentPort.postMessage({ type: 'dsh-ios/notice' })
 *     → main.mjs 的 engine.on('message')：notice-admission 准入
 *     → 追加 notices.jsonl
 *     → App（AppModel.swift 每 3 秒轮询、按 eventId 去重、showToast）
 *
 * ## 为什么要这么测（而不是测 registry 的 enqueue/ack）
 *
 * 这个项目反复出现「机制写了但没接上」：outbox、ack、flushTaskOutbox 都写好了，
 * 却没有人证明「一条失败事件真的能到用户眼前」。task-outbox.test.mjs 只测到
 * registry 的读写；这里把整条链走完，任何一环断开都必须红。
 *
 * 具体做法：
 *   · 前半段用**真实 Router**真跑一条失败任务（runTask 返回 ok:false），不 mock 调度
 *   · 后半段用**真实 auto-guard 插件**，跑在真的 Worker 里（parentPort 是真的），
 *     只把「15 秒」这一拍换成手动触发——执行的是同一个 runOnce，不是复制品
 *   · 宿主侧（main.mjs 的角色）用**真实 notice-admission**，按 main.mjs 的字段
 *     规则组装记录、真的写进 notices.jsonl 再读回来核对
 *
 * 已知边界：main.mjs 要起整个引擎才能跑、App 侧是 Swift，都无法在本测试里直接
 * 执行。宿主那几行按 main.mjs 复刻（同 notice-contract.test.mjs 的惯例），
 * 并用一个单独的测试钉住 main.mjs 里那几个关键标记，防止复刻与真宿主脱节。
 */

const HERE = new URL('..', import.meta.url);                       // engine/
const PLUGIN_URL = new URL('plugins/auto-guard/index.mjs', HERE).href;
const REGISTRY_URL = new URL('runtime/task-registry.mjs', HERE).href;
const MAIN_SRC = fs.readFileSync(fileURLToPath(new URL('main.mjs', HERE)), 'utf8');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-deliv-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 真跑一条失败任务，返回任务和它留下的 outbox 事件。
 * 走的是 App 里同一条路：accept → execute → runOne。
 */
async function failOneTask(dir, { title = '会失败的任务' } = {}) {
  const router = new Router({
    dataDir: dir,
    runTask: async () => ({ ok: false, error: '测试注入的失败（runTask 返回 ok:false）' }),
  });
  const { task } = router.accept({ source: 'user', eventId: 'evt-outbox-delivery', title });
  await router.execute();

  // runOne 是 void 出去的异步补位，等它把任务推到终态（needs_reconciliation）。
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (router.state().tasks[task.taskId]?.status === 'needs_reconciliation') break;
    await wait(20);
  }
  const state = router.state();
  const event = pendingOutbox(state).find((e) => e.kind === 'task_failed' && e.taskId === task.taskId);
  return { task: state.tasks[task.taskId], event };
}

/**
 * 在真 Worker 里跑 auto-guard，宿主侧按 main.mjs 的规则收消息、写 notices.jsonl。
 *
 * ticks = 手动触发几「拍」15 秒调度循环。真实等待 15 秒又慢又抖，
 * 但触发的是同一个 runOnce，所以验证的仍是生产代码路径。
 *
 * @returns {Promise<{received: object[], rejected: string[], diag: object|null,
 *                    notices: object[], noticesPath: string}>}
 */
async function runThroughEngine({ dir, ticks }) {
  const noticesPath = path.join(dir, 'notices.jsonl');
  const received = [];
  const rejected = [];
  // 真实准入器：main.mjs 用的就是这一个（kind 白名单 + 冷却）。
  const admit = createNoticeAdmission();
  let diag = null;

  const scriptPath = path.join(dir, 'delivery-worker.mjs');
  fs.writeFileSync(scriptPath, workerScript({ dir, ticks }));
  const worker = new Worker(scriptPath);

  const finished = new Promise((resolve, reject) => {
    // 这是「防卡死」的上限，不是延迟预算：链路真断了时，worker 照样会很快回报
    // 诊断（diag），失败是立刻的。只有 worker 自己卡住（导入太慢、循环没转）
    // 才会等到这里——iSH 上内存吃紧时插件加载确实能慢到十几秒，所以放宽，
    // 免得把「机器慢」误判成「链路断」。
    const timer = setTimeout(
      () => reject(new Error('60 秒内没等到 worker 的 diag —— 链路卡死在 worker 里（插件加载失败，或调度循环没转起来）')),
      60_000,
    );
    worker.on('message', (message) => {
      if (message?.type === 'dsh-ios/notice') {
        received.push(message);
        if (admit(message)) {
          // 复刻 main.mjs 里 engine.on('message') 的 dsh-ios/notice 分支：
          // 顶层 kind/message/taskId 是 Swift 侧真正读的字段，detail 原样带上。
          const detail = message.detail ?? {};
          const record = {
            eventId: message.eventId ?? detail.eventId ?? null,
            kind: detail.kind ?? 'notice',
            message: message.message,
            sessions: detail.sessions ?? null,
            steps: detail.steps ?? null,
            turns: detail.turns ?? null,
            taskId: detail.taskId ?? null,
            detail,
            time: Date.now(),
          };
          fs.appendFileSync(noticesPath, JSON.stringify(record) + '\n', { mode: 0o600 });
        } else {
          // 被准入拦掉 = 用户看不到，但插件那边很可能已经 ack 了 —— 静默丢失。
          rejected.push(message.detail?.kind ?? '(无 kind)');
        }
      } else if (message?.type === 'diag') {
        diag = message;
        clearTimeout(timer);
        resolve();
      }
    });
    worker.on('error', (error) => { clearTimeout(timer); reject(error); });
    worker.on('exit', (code) => {
      if (diag === null) {
        clearTimeout(timer);
        reject(new Error(`worker 提前退出（code ${code}）：插件在跑完约定的一拍之前就死了`));
      }
    });
  });

  try { await finished; } finally { await worker.terminate(); }

  const notices = fs.existsSync(noticesPath)
    ? fs.readFileSync(noticesPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { received, rejected, diag, notices, noticesPath };
}

/**
 * 把「没送达」翻译成「断在哪一环」。
 * 测试失败时的报错必须能直接指向要修的地方，而不是一句「expected 1 got 0」。
 */
function explainBreak({ received, rejected, diag, notices, event }) {
  const mine = received.filter((m) => m.detail?.eventId === event.eventId);
  if (diag?.error) return `断在「worker 内部」：${diag.error}`;
  if (mine.length === 0) {
    if (diag && diag.pending > 0) {
      return `断在「投递触发」：15 秒调度循环跑了 ${diag.ticks ?? 0} 拍后，outbox 里仍有 ${diag.pending} 条未投递`
        + ` —— 期间没有任何地方调用 flushTaskOutbox。事件 ${event.eventId}（kind=${event.kind}）进得来、出不去。`;
    }
    if (diag && diag.pending === 0) {
      return '断在「发送段」：事件已被 flush 标记为已投递（ack），但没有一条 dsh-ios/notice 到达宿主'
        + ' —— notify() 没有真的经 parentPort 发出（或发到了没人收的通道）。';
    }
    return `断在「调度循环」：worker 没有报出可用诊断（diag=${JSON.stringify(diag)}）。`;
  }
  if (rejected.length > 0) {
    return `断在「宿主准入」：消息到了 parentPort，但 kind=${rejected.join(',')} 被 notice-admission 拦掉`
      + ' —— main.mjs 不会写 notices.jsonl，用户什么也看不到，而事件已经 ack，等于静默丢失。';
  }
  if (!notices.some((record) => record.eventId === event.eventId)) {
    return `断在「notices.jsonl 写入」：消息通过了准入，但文件里找不到 eventId=${event.eventId} 的记录。`;
  }
  return null;   // 送达了；「是否只送一次」由调用方断言
}

/** Worker 脚本：真插件 + 手动触发调度循环的那一拍。 */
function workerScript({ dir, ticks }) {
  return `
import { parentPort } from 'node:worker_threads';

// 插件用 DSH_IOS_DATA 定位 tasks.json / notices.jsonl（与 main.mjs 同口径）。
process.env.DSH_IOS_DATA = ${JSON.stringify(dir)};

// 真实插件，同一份代码、同一个 Worker 环境 —— parentPort 是真的。
const { default: AutoGuard } = await import(${JSON.stringify(PLUGIN_URL)});

// 截获「15 秒后跑的那一拍」，手动触发：测试不能真等 15 秒，
// 但执行的是同一个 runOnce，不是复制出来的逻辑。
const realSetTimeout = globalThis.setTimeout;
const slowTicks = [];
globalThis.setTimeout = function (fn, ms, ...rest) {
  if (Number(ms) === 15_000) { slowTicks.push(fn); return { unref() {} }; }
  return realSetTimeout.call(this, fn, ms, ...rest);
};

const ctx = {
  effect: (fn) => fn(),
  on: () => () => {},
  logger: { warn() {}, info() {} },
  // 调度循环要 agents 才继续往下走；给个空壳（本测试没有要执行的队列）。
  get: (name) => (name === 'agents' ? {} : undefined),
};
const guard = new AutoGuard(ctx, {});

let ran = 0;
try {
  for (let i = 0; i < ${ticks}; i += 1) {
    const tick = slowTicks.shift();
    if (typeof tick !== 'function') {
      parentPort.postMessage({ type: 'diag', error: '调度循环没有注册定时器（runOnce 从未被安排）' });
      break;
    }
    await tick();
    ran += 1;
  }
} catch (error) {
  parentPort.postMessage({ type: 'diag', error: String((error && error.stack) || error) });
}

const { load, pendingOutbox } = await import(${JSON.stringify(REGISTRY_URL)});
parentPort.postMessage({ type: 'diag', ticks: ran, pending: pendingOutbox(load(${JSON.stringify(dir)})).length });
`;
}

// ── 前半段：真实 Router 造出来的 outbox 事件 ──────────────────────

test('失败任务在 outbox 留下待投递事件（真实 Router）', async () => {
  const dir = tmp();
  const { task, event } = await failOneTask(dir, { title: '会被投递的失败任务' });

  assert.ok(task, '任务应已建立');
  assert.equal(task.status, 'needs_reconciliation', '失败任务应停在等人核对，而不是自动重跑');
  assert.ok(event, '失败之后 outbox 里必须有 task_failed 事件——没有它，用户永远不会知道有东西坏了');
  assert.equal(event.kind, 'task_failed');
  assert.equal(event.detail?.taskId, task.taskId);
  assert.equal(event.ackedAt, null, '刚入队的事件不该是已投递状态');
  assert.match(event.message, /会被投递的失败任务/, '通知里应带上任务标题');
});

// ── 后半段：走真实投递链路，落到 notices.jsonl ─────────────────────

test('端到端：调度循环把失败事件送进 notices.jsonl（用户看得见）', async () => {
  const dir = tmp();
  const { task, event } = await failOneTask(dir, { title: '只跑一拍也要送达' });
  assert.ok(event, '前置：outbox 里应有待投递事件');

  const out = await runThroughEngine({ dir, ticks: 1 });
  const breakage = explainBreak({ ...out, event });
  if (breakage) assert.fail(`链路断了：${breakage}`);

  const mine = out.received.filter((m) => m.detail?.eventId === event.eventId);
  assert.equal(mine.length, 1, '同一条事件一拍只应送一次');

  const record = out.notices.find((r) => r.eventId === event.eventId);
  assert.ok(record, 'notices.jsonl 里必须有这条记录，App 就是从这里弹横幅的');
  assert.equal(record.kind, 'task_failed', 'App 按顶层 kind 分流（AppModel.swift 读 obj["kind"]）');
  assert.equal(record.taskId, task.taskId, 'taskId 要能让人点回去看');
  assert.match(record.message, /只跑一拍也要送达/, '横幅正文应是给用户看的那句话');

  assert.equal(out.diag.pending, 0, '投递后必须 ack：outbox 里不该还挂着它，否则下一拍会重复弹');
});

test('幂等：ack 之后第二拍不再重投', async () => {
  const dir = tmp();
  const { event } = await failOneTask(dir, { title: '只该弹一次' });
  assert.ok(event, '前置：outbox 里应有待投递事件');

  const out = await runThroughEngine({ dir, ticks: 2 });
  const breakage = explainBreak({ ...out, event });
  if (breakage) assert.fail(`链路断了：${breakage}`);

  assert.equal(out.diag.ticks, 2, '两拍都要真的跑过，否则「只送一次」可能只是没跑第二拍');
  const mine = out.received.filter((m) => m.detail?.eventId === event.eventId);
  assert.equal(mine.length, 1, `同一条事件被投递了 ${mine.length} 次 —— ack 之后 pendingOutbox 没把它过滤掉`);
  assert.equal(
    out.notices.filter((r) => r.eventId === event.eventId).length,
    1,
    'notices.jsonl 里同一条事件也只应有一行（App 虽然按 eventId 去重，但引擎不该依赖它兜底）',
  );
  assert.equal(out.diag.pending, 0, '两拍之后 outbox 应为空');
});

// ── 边防线：防止链路在「准入」和「宿主」两处悄悄断开 ─────────────

test('准入白名单覆盖 outbox 所有事件 kind（否则 ack 后被静默丢弃）', () => {
  // kind 字面量直接从 enqueue 的调用方源码里扫，而不是在这里抄一份清单：
  // 以后谁加了新的事件类型却忘了进准入名单，这个测试立刻红。
  const sources = ['../runtime/router.mjs', '../runtime/flight-recorder.mjs']
    .map((rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
  const kinds = new Set();
  for (const src of sources) {
    // 逐行扫「带 kind: 的那行」里的所有字符串字面量：
    // 不能只匹配 `kind: 'x'`——`kind: rerouted ? 'a' : 'b'` 这种三元写法
    // 会把后半截漏掉，而漏掉的那半恰好是「连续失败要求重新拆解」这种必须送达的事件。
    for (const line of src.split('\n').filter((l) => l.includes('kind:'))) {
      for (const match of line.matchAll(/'([a-z_]+)'/g)) kinds.add(match[1]);
    }
  }
  assert.ok(kinds.size >= 5, `没扫到事件 kind（只扫到 ${kinds.size} 个），扫描规则可能过时了`);

  const admit = createNoticeAdmission();
  const dropped = [...kinds].filter(
    (kind) => !admit({ type: 'dsh-ios/notice', level: 'warn', message: '测试', detail: { kind } }),
  );
  assert.deepEqual(
    dropped,
    [],
    `这些 kind 会被 notice-admission 拦掉，但事件在插件侧已被 ack：${dropped.join(', ')}。`
    + '要么加进 ALWAYS（用户真的需要看到），要么就不要 enqueue——中间态是静默丢失。',
  );
});

test('宿主桥仍在：main.mjs 收 dsh-ios/notice 并写 notices.jsonl', () => {
  // main.mjs 不在本任务的修改范围，但整条链最后一段靠它。
  // 这几个标记是「插件说话 → 文件 → App」的接口本体；它们消失，
  // 上面复刻的宿主就与真宿主脱节，测试必须跟着红，而不是继续假装通过。
  assert.ok(MAIN_SRC.includes("'dsh-ios/notice'"), '断在「宿主桥」：main.mjs 不再处理 dsh-ios/notice 消息');
  assert.ok(MAIN_SRC.includes('notices.jsonl'), '断在「宿主桥」：main.mjs 不再写 notices.jsonl');
  assert.ok(MAIN_SRC.includes('admitNotice'), '断在「宿主桥」：main.mjs 不再走 notice-admission 准入');
});
