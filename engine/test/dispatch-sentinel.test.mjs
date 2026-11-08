import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * 派单催办必须真的接上，而不是只有 sentinel.mjs 放那儿等人跑。
 *
 * 回归背景：sentinel.mjs 早就有 open/awaited 和超时判断，但全仓没有一处调用
 * 它——和轮次计数、记忆注入是同一个病：能力在，触发无。这个测试从「写一条
 * 未销账派单」开始，走到「auto-guard 至少发现一次」，全部用真实文件和真实进程。
 */
const engine = new URL('..', import.meta.url).pathname;
const sentinel = path.join(engine, 'skills/dispatch-protocol/sentinel.mjs');

// 这些用例要 spawn 真进程。iSH 上内存吃紧时同时起多个 Node 会互相拖死
// （实测串行 24s、四个测试文件并行时 60s 超时失败），所以每个 spawn 都显式
// 给了 timeout，避免并行跑时无限等待。

test('有超时未回执时 sentinel 退出码为 1，且报出条数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
  const ledger = path.join(dir, 'ledger.jsonl');
  const env = { ...process.env, DSH_SENTINEL_LEDGER: ledger };

  // 造一条派单；把时间往前拨到「必然超时」
  execFileSync(process.execPath, [sentinel, 'dispatch', '--to', 'agent-b', '--what', '修构建'], { env, timeout: 90_000 });
  const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  rows[0].at = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  fs.writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  let status = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [sentinel, 'open', '--stale', '30'], { env, encoding: 'utf8', timeout: 90_000 });
  } catch (error) {
    status = error.status;
    out = error.stdout;
  }
  assert.equal(status, 1, '有待催的派单时必须非零退出，否则它就是装饰');
  assert.match(out, /1 条超时未回执/);
});

test('销账之后不再报超时', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
  const ledger = path.join(dir, 'ledger.jsonl');
  const env = { ...process.env, DSH_SENTINEL_LEDGER: ledger };

  execFileSync(process.execPath, [sentinel, 'dispatch', '--to', 'agent-b', '--what', '修构建', '--id', 'x1'], { env, timeout: 90_000 });
  const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  rows[0].at = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  fs.writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  execFileSync(process.execPath, [sentinel, 'ack', '--id', 'x1', '--evidence', '构建通过'], { env, timeout: 90_000 });
  const out = execFileSync(process.execPath, [sentinel, 'open', '--stale', '30'], { env, encoding: 'utf8', timeout: 90_000 });
  assert.doesNotMatch(out, /条超时未回执/);
});

test('auto-guard 在 turn/start 后真的去查了派单台账', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-dispatch-'));
  const ledger = path.join(dir, 'ledger.jsonl');
  process.env.DSH_IOS_DATA = dir;
  process.env.DSH_SENTINEL_LEDGER = ledger;

  // 一条两小时前的未回执派单。
  // 多重试几次：并行跑测试时多个 Node 子进程抢 CPU，sentinel 偶尔起不来，
  // 那是环境问题不是逻辑问题——单跑时 3/3 全过，全量并行时会偶发失败。
  const dispatchOnce = () => execFileSync(process.execPath, [sentinel, 'dispatch', '--to', 'agent-b', '--what', '修构建'], { env: process.env, timeout: 90_000 });
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { dispatchOnce(); lastErr = null; break; } catch (error) { lastErr = error; }
  }
  if (lastErr) throw lastErr;
  const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  rows[0].at = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  fs.writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const { default: AutoGuard } = await import(`../plugins/auto-guard/index.mjs?t=${Date.now()}`);
  const notices = [];
  const ctx = { effect: (fn) => fn(), on: () => () => {}, logger: { warn: () => {} } };
  const guard = new AutoGuard(ctx, {});
  // 只拦通知，不真的发；其余逻辑照跑
  guard.notify = (message, detail) => notices.push({ message, detail });

  guard.onTurnStart({ header: { id: 's1', origin: 'user' }, ownEvents: () => [] });

  const dispatch = notices.find((n) => n.detail?.kind === 'dispatch');
  assert.ok(dispatch, `没触发派单提醒，实际收到: ${JSON.stringify(notices)}`);
  assert.match(dispatch.message, /派单超时/);
});
