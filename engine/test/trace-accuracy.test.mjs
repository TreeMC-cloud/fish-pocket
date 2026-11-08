import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * trace 是「经验」的原料。原料错了，蒸馏出来的技能会指向错误的事件。
 * 这里钉住三件事：
 *   1. 只记本轮（不能把上一轮的内容当本轮摘要）
 *   2. 结果判定用白名单（aborted / interrupted / max-tokens 不能算成功）
 *   3. 凭证必须脱敏（trace 会长期留存并参与导出）
 */
const ENGINE = new URL('..', import.meta.url).pathname;

async function guardWith(dir) {
  process.env.DSH_IOS_DATA = dir;
  process.env.DSH_TRACE_FILE = path.join(dir, '.trace.jsonl');
  const mod = await import(`${ENGINE}plugins/auto-guard/index.mjs?t=${Date.now()}`);
  const guard = new mod.default({ effect: (fn) => fn(), on: () => () => {}, logger: { warn: () => {} } }, {});
  return { guard, mod };
}

const turn = (n) => ({ type: 'turn/start', data: { turn: n } });
const user = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } });
const assistant = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
const readTrace = (dir) => {
  const file = path.join(dir, '.trace.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

test('只记录本轮，不串上一轮的内容', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
  const { guard } = await guardWith(dir);
  const events = [
    turn(1), user('下载 ipa 失败'), assistant('下载失败，wait 卡死'),
    turn(2), user('修构建'), assistant('修好了，构建通过'),
  ];
  guard.onTurnEnd({ header: { id: 's1', origin: 'user' }, ownEvents: () => events }, { data: { reason: { kind: 'completed' } } });

  const [record] = readTrace(dir);
  assert.equal(record.summary, '修好了，构建通过', '应取本轮的助手回复');
  assert.ok(!record.summary.includes('下载'), '不能混进上一轮的内容');
});

test('assistant 文本取自 data.message.content（结构别写错）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
  const { guard } = await guardWith(dir);
  guard.onTurnEnd(
    { header: { id: 's1', origin: 'user' }, ownEvents: () => [turn(1), user('问题'), assistant('答案在 message.content 里')] },
    { data: { reason: { kind: 'completed' } } },
  );
  assert.match(readTrace(dir)[0].summary, /答案在 message\.content 里/);
});

test('非正常结束不能算成功', async () => {
  const { mod } = await guardWith(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-')));
  const { outcomeOf } = mod;

  assert.equal(outcomeOf('completed'), true);
  assert.equal(outcomeOf('user'), true);
  for (const bad of ['error', 'aborted', 'interrupted', 'cancelled', 'max-tokens', 'quota']) {
    assert.equal(outcomeOf(bad), false, `${bad} 不能算成功`);
  }
  assert.equal(outcomeOf('weird-new-reason'), null, '未知原因必须返回 null，不能猜成成功');
});

test('trace 里写入的 ok 跟随 reason', async () => {
  for (const [reason, expected] of [['completed', true], ['aborted', false], ['interrupted', false]]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
    const { guard } = await guardWith(dir);
    guard.onTurnEnd(
      { header: { id: 's1', origin: 'user' }, ownEvents: () => [turn(1), user('做点事'), assistant('做完了')] },
      { data: { reason: { kind: reason } } },
    );
    assert.equal(readTrace(dir)[0].ok, expected, `${reason} 的 ok 应为 ${expected}`);
  }
});

test('凭证被脱敏后才落盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
  const { guard, mod } = await guardWith(dir);

  // 单元层面
  const masked = mod.redact('export KEY=sk-abcdefghijklmnopqrstuvwxyz token=abc123 https://x.com/a?token=zzz');
  assert.ok(!masked.includes('sk-abcdefghijklmnopqrstuvwxyz'), '密钥必须消失');
  assert.ok(!masked.includes('abc123'));
  assert.ok(!masked.includes('zzz'));

  // 落盘层面
  guard.onTurnEnd(
    { header: { id: 's1', origin: 'user' }, ownEvents: () => [
      turn(1),
      user('部署'),
      assistant('用 sk-livekey1234567890abcdefgh 部署成功了'),
    ] },
    { data: { reason: { kind: 'completed' } } },
  );
  const raw = fs.readFileSync(path.join(dir, '.trace.jsonl'), 'utf8');
  assert.ok(!raw.includes('sk-livekey1234567890abcdefgh'), '文件里不能出现原始密钥');
  assert.match(raw, /REDACTED/);
});

test('子智能体的轮次不记 trace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
  const { guard } = await guardWith(dir);
  guard.onTurnEnd(
    { header: { id: 'sub', origin: 'subagent' }, ownEvents: () => [turn(1), user('子任务'), assistant('做完了')] },
    { data: { reason: { kind: 'completed' } } },
  );
  assert.equal(readTrace(dir).length, 0);
});
