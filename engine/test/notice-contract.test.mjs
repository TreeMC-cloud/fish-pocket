import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeInFlight, reportInterrupted } from '../runtime/flight-recorder.mjs';
import { createNoticeAdmission } from '../runtime/notice-admission.mjs';

/**
 * 引擎 → App 的通知字段契约。
 *
 * 这一层最容易静默失效：两边各自看都没错，但 key 对不上，功能就没了。
 * Swift 的 AppModel 读的是**顶层** obj["kind"] / ["sessions"] / ["turns"]；
 * 引擎如果把它们塞进 detail，横幅永远不出现、跳转永远失败，而且不报错。
 *
 * 这里用「引擎产出 → 准入 → 按 main.mjs 的规则组装 → 模拟 Swift 读取」整条链
 * 走一遍，确认字段都在该在的位置。
 */
const ENGINE = new URL('..', import.meta.url).pathname;

/** 复刻 main.mjs 里 engine.on('message') 对 notice 的处理。 */
function toNoticeRecord(message, detail) {
  const d = detail ?? {};
  return {
    kind: d.kind ?? 'notice',
    message,
    sessions: d.sessions ?? null,
    steps: d.steps ?? null,
    turns: d.turns ?? null,
    taskId: d.taskId ?? null,
    time: Date.now(),
  };
}

async function flushOnce(dir) {
  process.env.DSH_IOS_DATA = dir;
  const { default: AutoGuard } = await import(`${ENGINE}plugins/auto-guard/index.mjs?t=${Date.now()}`);
  const admit = createNoticeAdmission();
  const records = [];
  const guard = new AutoGuard({ effect: (fn) => fn(), on: () => () => {}, logger: { warn: () => {} } }, {});
  guard.notify = (message, detail) => {
    const notice = { type: 'dsh-ios/notice', message, detail };
    if (admit(notice)) records.push(toNoticeRecord(message, detail));
  };
  guard.onTurnStart({ header: { id: 's1', origin: 'user' }, ownEvents: () => [] });
  return records;
}

test('中断通知在顶层提供 kind / sessions / turns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'));
  writeInFlight(dir, { sessA: { at: Date.now() - 5000, step: '正在运行命令（npm run build）', turn: 3 } });
  reportInterrupted(dir);

  const records = await flushOnce(dir);
  const rec = records.find((r) => r.kind === 'interrupted');
  assert.ok(rec, '中断事件必须送达');

  // 这三条正是 Swift 侧真正读的字段
  assert.equal(rec.kind, 'interrupted', 'Swift 靠顶层 kind 判断是否显示横幅');
  assert.deepEqual(rec.sessions, ['sessA'], 'Swift 靠 sessions 决定跳哪个会话');
  assert.equal(rec.turns.sessA, 3, 'Swift 靠 turns 定位被打断的那一轮');
  assert.match(rec.steps.sessA, /npm run build/, '步骤用于横幅正文');
});

test('中断通知不会被准入冷却拦掉', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'));
  writeInFlight(dir, { s1: { at: Date.now() - 1000, step: 'x', turn: 1 } });
  reportInterrupted(dir);

  const admit = createNoticeAdmission({ cooldownMs: 60_000, now: () => 1000 });
  const notice = { type: 'dsh-ios/notice', message: '中断了', detail: { kind: 'interrupted', session: 's1' } };
  assert.equal(admit(notice), true);
  assert.equal(admit(notice), true, '第二次也必须送达');
});

test('多个会话中断时逐个带上 turn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'));
  writeInFlight(dir, {
    a: { at: Date.now() - 2000, step: '正在读取文件', turn: 1 },
    b: { at: Date.now() - 1000, step: '正在运行命令', turn: 7 },
  });
  reportInterrupted(dir);

  const rec = (await flushOnce(dir)).find((r) => r.kind === 'interrupted');
  assert.deepEqual(rec.sessions.sort(), ['a', 'b']);
  assert.equal(rec.turns.a, 1);
  assert.equal(rec.turns.b, 7);
});

test('没有被中断时不产生任何通知', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'));
  reportInterrupted(dir);
  const records = await flushOnce(dir);
  assert.equal(records.filter((r) => r.kind === 'interrupted').length, 0);
});
