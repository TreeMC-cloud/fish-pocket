import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tokens, similarity, retrieve, evaluate, findConflicts, loadSkillIndex } from '../runtime/skill-eval.mjs';
import { shouldRun, acquireLock, releaseLock, runDream, recentAudit, LOCK_STALE_MS } from '../runtime/dream.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dream-'));

// ── 检索评测 ──────────────────────────────────────────────

test('中文按 2-gram 切分', () => {
  const t = tokens('派活给子代理');
  assert.ok(t.has('派活'));
  assert.ok(t.has('子代'));
});

test('英文按词切分，忽略短词', () => {
  const t = tokens('git push to remote');
  assert.ok(t.has('git'));
  assert.ok(t.has('remote'));
});

test('相同文本相似度为 1', () => {
  assert.equal(similarity('下载文件', '下载文件'), 1);
});

test('完全无关相似度为 0', () => {
  assert.equal(similarity('天气', 'git commit push'), 0);
});

test('检索按分数排序并截断', () => {
  const skills = [
    { name: 'a', description: '下载文件到本地' },
    { name: 'b', description: '上传文件到服务器' },
    { name: 'c', description: '完全无关的内容' },
  ];
  const r = retrieve('下载文件', skills, { limit: 2 });
  assert.equal(r[0].name, 'a');
  assert.ok(r.length <= 2);
});

test('评测：期望命中且真的命中', () => {
  const skills = [{ name: 'handoff', description: '交接进度到文件' }];
  const r = evaluate([{ query: '交接进度', expect: 'handoff' }], skills);
  assert.equal(r.passed, 1);
});

test('评测：不该命中却命中 → 记失败并说明原因', () => {
  const skills = [{ name: 'handoff', description: '交接进度到文件' }];
  const r = evaluate([{ query: '交接进度', expect: null }], skills);
  assert.equal(r.passed, 0);
  assert.match(r.details[0].why, /不该命中/);
});

test('评测：该命中却没命中 → 说清期望与实际', () => {
  const skills = [{ name: 'x', description: '无关内容' }];
  const r = evaluate([{ query: '交接进度', expect: 'handoff' }], skills);
  assert.equal(r.passed, 0);
  assert.match(r.details[0].why, /期望 handoff/);
});

test('冲突检测：描述高度相似的两个技能被报出来', () => {
  const skills = [
    { name: 'a', description: '把进度写到交接文件里保存' },
    { name: 'b', description: '把进度写到交接文件里保存备份' },
    { name: 'c', description: '完全不同的东西 git push' },
  ];
  const c = findConflicts(skills, { threshold: 0.5 });
  assert.ok(c.length >= 1, '应报出 a 与 b 冲突');
  assert.equal(c[0].a, 'a');
});

test('真实技能目录：无关问题不误命中', () => {
  const skills = loadSkillIndex(new URL('../skills', import.meta.url).pathname);
  assert.ok(skills.length >= 18);
  const r = retrieve('今天中午吃什么好呢', skills);
  assert.equal(r.length, 0, '闲聊不该命中任何技能');
});

// ── Dream ────────────────────────────────────────────────

function seedTraces(dir, count, { okRate = 0.5, tag = '下载' } = {}) {
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(JSON.stringify({
      at: Date.now() - (count - i) * 1000,
      ok: Math.random() < okRate,
      summary: `第${i}次尝试，wait 卡死`,
      tags: [tag],
    }));
  }
  fs.writeFileSync(path.join(dir, '.trace.jsonl'), lines.join('\n') + '\n');
}

test('新 trace 不够时不跑', () => {
  const d = tmp();
  seedTraces(d, 5);
  const r = shouldRun(d, { minNew: 20 });
  assert.equal(r.shouldRun, false);
  assert.match(r.reason, /只有 5 条/);
});

test('够了就跑，但受最小间隔限制', () => {
  const d = tmp();
  seedTraces(d, 30);
  const now = Date.now();
  assert.equal(shouldRun(d, { now, minNew: 20, minIntervalMs: 0 }).shouldRun, true);
  runDream(d, { now, minNew: 20, distill: () => [] });
  // 刚跑完，再来一次应该被间隔挡住
  const second = shouldRun(d, { now: now + 1000, minNew: 5, minIntervalMs: 60_000 });
  assert.equal(second.shouldRun, false);
  assert.match(second.reason, /不到/);
});

test('锁：同一时间只允许一个 Dream', () => {
  const d = tmp();
  const first = acquireLock(d);
  assert.equal(first.acquired, true);
  const second = acquireLock(d);
  assert.equal(second.acquired, false, '第二个必须被挡住');
  releaseLock(d);
  assert.equal(acquireLock(d).acquired, true, '释放后可以再拿');
});

test('锁过期可被抢占（崩溃不留死锁）', () => {
  const d = tmp();
  const now = Date.now();
  fs.writeFileSync(path.join(d, '.dream.lock'), JSON.stringify({ pid: 999, at: now - LOCK_STALE_MS - 1000 }));
  const r = acquireLock(d, { now });
  assert.equal(r.acquired, true, '过期锁必须能抢占，否则崩溃后永远跑不了');
});

test('Dream 只写候选，不激活；并写审计', () => {
  const d = tmp();
  seedTraces(d, 30);
  const produced = [{ tag: '下载', verified: false }];
  const r = runDream(d, { minNew: 20, distill: () => produced });
  assert.equal(r.ran, true);
  assert.equal(r.produced.length, 1);
  assert.equal(r.produced[0].verified, false, '绝不能自动 verified');

  const audit = recentAudit(d);
  assert.ok(audit.some((a) => a.event === 'dream' && a.processed > 0));
});

test('预算生效：只处理最近 N 条', () => {
  const d = tmp();
  seedTraces(d, 100);
  let received = 0;
  runDream(d, { minNew: 20, budget: 25, distill: (rows) => { received = rows.length; return []; } });
  assert.equal(received, 25, '不能一次处理全部');
});

test('整理失败也要释放锁', () => {
  const d = tmp();
  seedTraces(d, 30);
  const r = runDream(d, { minNew: 20, distill: () => { throw new Error('boom'); } });
  assert.equal(r.ran, false);
  assert.match(r.reason, /boom/);
  assert.equal(acquireLock(d).acquired, true, '失败后锁必须释放，否则再也跑不了');
});
