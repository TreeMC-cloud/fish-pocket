import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 飞行记录的完整链路：turn/start → assistant/message(tool-call) → 落盘。
 *
 * 为什么不只单独测 recordStep：它是「传什么写什么」，单独调它证明不了
 * 参数提取那一段。真正会出错的是中间那层——从 tool-call 的 arguments
 * 里取 command / file_path，取不到就退化成整个 JSON 字符串。所以要
 * 走 onAssistantMessage，绕开任何我手写的输入。
 */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'guard-step-'));

async function guardIn(dir) {
  process.env.DSH_IOS_DATA = dir;
  const { default: AutoGuard } = await import(`../plugins/auto-guard/index.mjs?t=${Date.now()}`);
  const ctx = { effect: (fn) => fn(), on: () => () => {}, logger: { warn: () => {} } };
  return new AutoGuard(ctx, {});
}

const session = (id, origin = 'user') => ({ header: { id, origin }, ownEvents: () => [] });
const callMessage = (...calls) => ({
  data: { message: { content: calls.map(([name, args]) => ({ type: 'tool-call', name, arguments: args })) } },
});
const stepOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'in-flight.json'), 'utf8')).running;

test('从 tool-call 参数里取出命令，不是整段 JSON', async () => {
  const dir = tmp();
  const guard = await guardIn(dir);
  guard.onTurnStart(session('s1'));
  guard.onAssistantMessage(session('s1'), callMessage(['bash', '{"command":"npm run build"}']));
  assert.equal(stepOf(dir).s1.step, '正在运行命令（npm run build）');
});

test('多个调用取最后一个（崩溃时看到的就是它）', async () => {
  const dir = tmp();
  const guard = await guardIn(dir);
  guard.onTurnStart(session('s1'));
  guard.onAssistantMessage(session('s1'), callMessage(
    ['read', '{"file_path":"/a.ts"}'],
    ['grep', '{"pattern":"TODO"}'],
    ['bash', '{"command":"xcodebuild"}'],
  ));
  assert.equal(stepOf(dir).s1.step, '正在运行命令（xcodebuild）');
});

test('argv 数组形式的 command 也能读', async () => {
  const dir = tmp();
  const guard = await guardIn(dir);
  guard.onTurnStart(session('s1'));
  guard.onAssistantMessage(session('s1'), callMessage(['bash', '{"command":["git","push"]}']));
  assert.equal(stepOf(dir).s1.step, '正在运行命令（git push）');
});

test('参数不是合法 JSON 时退回原文，不抛异常', async () => {
  const dir = tmp();
  const guard = await guardIn(dir);
  guard.onTurnStart(session('s1'));
  guard.onAssistantMessage(session('s1'), callMessage(['bash', 'not json at all']));
  assert.match(stepOf(dir).s1.step, /正在运行命令/);
});

test('子智能体不写飞行记录，主会话照常', async () => {
  const dir = tmp();
  const guard = await guardIn(dir);
  guard.onTurnStart(session('main', 'user'));
  guard.onTurnStart(session('child', 'subagent'));
  assert.deepEqual(Object.keys(stepOf(dir)), ['main']);
});

test('多个主会话各自独立，一个结束不影响另一个', async () => {
  const dir = tmp();
  const guard = await guardIn(dir);
  guard.onTurnStart(session('a'));
  guard.onTurnStart(session('b'));
  guard.onAssistantMessage(session('a'), callMessage(['bash', '{"command":"npm test"}']));
  guard.onAssistantMessage(session('b'), callMessage(['read', '{"file_path":"/x.ts"}']));

  const both = stepOf(dir);
  assert.equal(both.a.step, '正在运行命令（npm test）');
  assert.equal(both.b.step, '正在读取文件（/x.ts）');

  guard.onTurnEnd(session('a'), { data: { reason: { kind: 'user' } } });
  assert.deepEqual(Object.keys(stepOf(dir)), ['b']);
});
