// evolve-promote.test.mjs —— 候选技能 → 真技能的契约
//
// 这是进化闭环的最后一段。它坏掉的表现：候选永远躺在文件里，
// 技能检索看不到，日志里一切正常——「学了但没学会」。
// 另一个风险相反：把没补全的骨架当成真技能，比没有技能更糟。
// 两个方向都要断言。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'skills', 'evolve', 'promote.mjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'evo-'));

function run(dir, ...args) {
  try {
    return {
      code: 0,
      out: execFileSync('node', [SCRIPT, ...args], {
        encoding: 'utf8',
        env: { ...process.env, DSH_IOS_DATA: dir, DSH_BUNDLED_SKILL_DIR: path.join(dir, 'skills') },
      }),
    };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function seed(dir, rows) {
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.evolved-candidates.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
}

const CAND = {
  at: 1, tag: 'build failure', samples: 6, fails: 4, failRatio: 0.67,
  problem: 'npm install 在 CI 上超时', practice: '改用 cache 并拆成两步',
  verified: false, fingerprint: 'b1',
};

test('list 列出待确认的候选', () => {
  const d = tmp();
  seed(d, [CAND]);
  const r = run(d, 'list');
  assert.equal(r.code, 0);
  assert.match(r.out, /待确认/);
  assert.match(r.out, /build failure/);
});

test('没有候选时如实说"还没有"', () => {
  const r = run(tmp(), 'list');
  assert.equal(r.code, 0);
  assert.match(r.out, /还没有候选技能/);
});

test('promote 生成 SKILL.md，名字从 tag 派生', () => {
  const d = tmp();
  seed(d, [CAND]);
  const r = run(d, 'promote', 'b1');
  assert.equal(r.code, 0);

  const file = path.join(d, 'skills', 'evolved-build-failure', 'SKILL.md');
  assert.ok(fs.existsSync(file), '应该生成 SKILL.md');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^---/, '要有 frontmatter');
  assert.match(text, /name: evolved-build-failure/);
  assert.match(text, /这是自动生成的骨架/, '必须标出这是骨架');
});

test('promote 不覆盖已存在的技能', () => {
  const d = tmp();
  seed(d, [CAND]);
  run(d, 'promote', 'b1');
  const second = run(d, 'promote', 'b1');
  assert.equal(second.code, 1);
  assert.match(second.out, /技能已存在/);
});

test('check 把骨架报成待补全', () => {
  const d = tmp();
  seed(d, [CAND]);
  run(d, 'promote', 'b1');
  const r = run(d, 'check');
  assert.match(r.out, /待补全/);
});

test('check 对补全后的技能放行', () => {
  const d = tmp();
  seed(d, [CAND]);
  run(d, 'promote', 'b1');
  // 模拟人工补全
  fs.writeFileSync(path.join(d, 'skills', 'evolved-build-failure', 'SKILL.md'), `---
name: evolved-build-failure
description: CI 构建失败。
version: 1.0.0
source: evolved:b1
permissions: []
---

# 构建失败

本地能装 CI 超时，先查 cache key。
`);
  const r = run(d, 'check');
  assert.match(r.out, /已补全/);
  assert.doesNotMatch(r.out, /待补全/);
});

test('reject 丢弃候选并留备份', () => {
  const d = tmp();
  seed(d, [CAND]);
  const r = run(d, 'reject', 'b1');
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(path.join(d, '.evolved-candidates.jsonl.bak')), '必须留备份');
  assert.equal(fs.readFileSync(path.join(d, '.evolved-candidates.jsonl'), 'utf8').trim(), '');
});

test('找不到编号时报错而不是静默成功', () => {
  const d = tmp();
  seed(d, [CAND]);
  const r = run(d, 'promote', '不存在的编号');
  assert.equal(r.code, 1);
  assert.match(r.out, /找不到候选/);
});

test('未知命令给出用法并以非零退出', () => {
  const r = run(tmp(), 'bogus');
  assert.equal(r.code, 2);
  assert.match(r.out, /用法/);
});
