import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * 技能撤销（Phase 1 回滚工具）。
 *
 * 为什么撤销必须是工具而不是「手编 JSONL」：进化闭环的最后一道闸是
 * 「错误技能能停下来」。手编没有审计、容易写坏 JSON、且没人会真的去做。
 * 撤销要快于技能生效，否则错误的技能会一直把任务带偏。
 */
const SCRIPT = path.join(new URL('..', import.meta.url).pathname, 'skills/evolve/skill-revoke.mjs');

const run = (args, env = {}) => {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: (error.stdout ?? '') + (error.stderr ?? '') };
  }
};

const setup = (rows) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revoke-'));
  const file = path.join(dir, 'cand.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dir, file, read: () => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
};

test('撤销 verified 技能：置 revoked、清 verified、留原因', () => {
  const s = setup([{ tag: '下载', samples: 5, fails: 3, verified: true, status: 'active' }]);
  const r = run(['revoke', '--tag', '下载', '--reason', '上游改版过期', '--by', 'user'], { DSH_CANDIDATES_FILE: s.file });
  assert.equal(r.code, 0, r.out);

  const [row] = s.read();
  assert.equal(row.status, 'revoked');
  assert.equal(row.verified, false, '撤销必须同时清掉 verified');
  assert.equal(row.revokeReason, '上游改版过期');
  assert.equal(row.revokedBy, 'user');
  assert.ok(row.revokedAt > 0);
});

test('撤销是软删除：记录仍在文件里', () => {
  const s = setup([{ tag: 'x', verified: true, status: 'active' }]);
  run(['revoke', '--tag', 'x', '--reason', 'r'], { DSH_CANDIDATES_FILE: s.file });
  assert.equal(s.read().length, 1, '撤销不删除行');
});

test('没有 reason 拒绝执行', () => {
  const s = setup([{ tag: 'x', verified: true, status: 'active' }]);
  const r = run(['revoke', '--tag', 'x'], { DSH_CANDIDATES_FILE: s.file });
  assert.equal(r.code, 2, '用法错误');
  assert.equal(s.read()[0].status, 'active', '拒绝时不能改数据');
});

test('撤销不存在的技能报错', () => {
  const s = setup([{ tag: 'x', verified: true, status: 'active' }]);
  const r = run(['revoke', '--tag', '不存在', '--reason', 'r'], { DSH_CANDIDATES_FILE: s.file });
  assert.equal(r.code, 1);
});

test('恢复后回到 active 且不自动 verified', () => {
  const s = setup([{ tag: 'x', verified: true, status: 'active' }]);
  run(['revoke', '--tag', 'x', '--reason', 'r'], { DSH_CANDIDATES_FILE: s.file });
  const r = run(['restore', '--tag', 'x'], { DSH_CANDIDATES_FILE: s.file });
  assert.equal(r.code, 0, r.out);

  const [row] = s.read();
  assert.equal(row.status, 'active');
  assert.equal(row.verified, false, '恢复 ≠ 重新验证，必须人工再确认');
  assert.equal(row.revokeReason, undefined, '旧撤销原因要清掉，避免矛盾状态');
});

test('撤销幂等：已撤销的再撤销不报错', () => {
  const s = setup([{ tag: 'x', verified: true, status: 'active' }]);
  const env = { DSH_CANDIDATES_FILE: s.file };
  assert.equal(run(['revoke', '--tag', 'x', '--reason', '一'], env).code, 0);
  assert.equal(run(['revoke', '--tag', 'x', '--reason', '二'], env).code, 0);
  assert.equal(s.read().length, 1, '幂等不能产生重复行');
});

test('按 id 撤销也行', () => {
  const s = setup([{ id: 'skill-123', tag: 'y', verified: true, status: 'active' }]);
  const r = run(['revoke', '--id', 'skill-123', '--reason', 'r'], { DSH_CANDIDATES_FILE: s.file });
  assert.equal(r.code, 0, r.out);
  assert.equal(s.read()[0].status, 'revoked');
});

test('list 显示撤销原因', () => {
  const s = setup([{ tag: '下载', samples: 3, fails: 2, verified: true, status: 'active' }]);
  run(['revoke', '--tag', '下载', '--reason', '镜像地址变了'], { DSH_CANDIDATES_FILE: s.file });
  const r = run(['list'], { DSH_CANDIDATES_FILE: s.file });
  assert.match(r.out, /已撤销/);
  assert.match(r.out, /镜像地址变了/);
});
