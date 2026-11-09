// 回归钉子：auto-guard 发出去的每一种通知，都必须能过准入器。
//
// 为什么需要这条：准入器（notice-admission）是白名单制，名单外的 kind 会被
// **静默丢弃**——auto-guard 以为发出去了，用户永远看不到，engine.log 里
// 只有一行。已经踩过两次：gate_failed / task_needs_redesign 一次，
// scene_missing / scene_mismatch 又一次。两次都不报错，只是「功能没用」。
//
// 所以这里不写死名单，而是**从 auto-guard 源码里抽出所有 notify 的 kind**，
// 逐个喂给真实准入器。以后谁加了新 kind 却忘了进白名单，这条测试立刻红。
//
// 消息形态必须是真实的，否则测试测的是幻觉：
//   notify(message, detail)
//     → { type: 'dsh-ios/notice', level: 'warn', message, detail }
//   准入器读的是 message.detail.kind，不是顶层 kind。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createNoticeAdmission } from '../runtime/notice-admission.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineDir = path.resolve(here, '..');
const guardSrc = fs.readFileSync(path.join(engineDir, 'plugins/auto-guard/index.mjs'), 'utf8');

/**
 * 抽出 `notify(...)` 调用第二参数里的 kind。
 *
 * 只截到最近的 `);`——`tick` / `task` 那些 kind 是写进 .turns.jsonl、
 * .trace.jsonl 的，不走通知通道，不能算进白名单要求。
 */
function noticeKinds() {
  const kinds = new Set();
  let index = 0;
  while ((index = guardSrc.indexOf('notify(', index)) !== -1) {
    const end = guardSrc.indexOf(');', index);
    if (end === -1) break;
    const call = guardSrc.slice(index, end);
    for (const k of call.matchAll(/kind:\s*'([a-z_]+)'/g)) kinds.add(k[1]);
    index = end + 2;
  }
  return [...kinds].sort();
}

/** 按真实形态构造一条通知。 */
function notice(kind, eventId = `probe-${kind}`) {
  return {
    type: 'dsh-ios/notice',
    level: 'warn',
    message: `probe ${kind}`,
    detail: { kind, session: 'S-probe', eventId },
  };
}

test('auto-guard 发出的每一种通知 kind 都能通过准入器', () => {
  const kinds = noticeKinds();
  assert.ok(kinds.length > 0,
    '没从源码里抽到任何 kind——抽取规则失效了，先修测试而不是放过它');

  const admit = createNoticeAdmission({ cooldownMs: 0 });
  const dropped = [];
  for (const kind of kinds) {
    if (!admit(notice(kind))) dropped.push(kind);
  }
  assert.deepEqual(dropped, [],
    `这些 kind 会被准入器静默丢弃，用户永远看不到：${dropped.join(', ')}。` +
    '要么加进 notice-admission 的 ALWAYS/THROTTLED，要么别用通知通道发。');
});

test('冷却生效：同类通知在冷却期内只过一次', () => {
  let clock = 1_000_000;
  const admit = createNoticeAdmission({ cooldownMs: 10 * 60_000, now: () => clock });
  assert.equal(admit(notice('repeat', 'e1')), true, '第一条要过');
  clock += 1_000;
  assert.equal(admit(notice('repeat', 'e2')), false, '冷却期内要拦');
  clock += 10 * 60_000;
  assert.equal(admit(notice('repeat', 'e3')), true, '过了冷却要放行');
});

test('出事类不受冷却：interrupted 连续来也要都送到', () => {
  let clock = 1_000_000;
  const admit = createNoticeAdmission({ cooldownMs: 10 * 60_000, now: () => clock });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(admit(notice('interrupted', `i${i}`)), true,
      '出事类每一条都要送达，冷却不该作用在它上面');
    clock += 1_000;
  }
});

test('未知 kind 一律拦掉（白名单制，不是黑名单）', () => {
  const admit = createNoticeAdmission({ cooldownMs: 0 });
  assert.equal(admit(notice('something_new', 'z1')), false,
    '新增 kind 必须显式进白名单，否则会被当成未知类型丢掉');
});

test('形态不对的消息一律拦掉（防止上游改字段后静默失效）', () => {
  const admit = createNoticeAdmission({ cooldownMs: 0 });
  assert.equal(admit({ kind: 'interrupted', message: 'x' }), false,
    '没有 type 的消息不该被放行');
  assert.equal(admit({ type: 'dsh-ios/notice', detail: { kind: 'interrupted' } }), false,
    '没有正文的消息不该被放行');
  assert.equal(admit({ type: 'dsh-ios/notice', message: 'x', detail: {} }), false,
    '没有 kind 的消息不该被放行');
});
