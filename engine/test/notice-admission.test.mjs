import test from 'node:test';
import assert from 'node:assert/strict';
import { createNoticeAdmission } from '../runtime/notice-admission.mjs';

const notice = (kind, session = 's1') => ({ type: 'dsh-ios/notice', message: '需要处理', detail: { kind, session } });

/**
 * 准入分两级，这个区分是功能性的，不是风格问题：
 *   出事类（中断/注入/失败/待批准）必须送达，不受冷却——
 *     给它们加冷却等于「同一个坑踩第二次就不报了」。
 *   高频类（轮次/重复失败/压缩/派单）按会话冷却——第一次有意义，之后是噪音。
 *   其余不放行，只留引擎日志。
 */
test('出事类不受冷却，每次都送达', () => {
  const admit = createNoticeAdmission({ cooldownMs: 60_000, now: () => 1000 });
  for (const kind of ['interrupted', 'injection', 'task_failed', 'task_interrupted', 'approval_needed']) {
    assert.equal(admit(notice(kind)), true, `${kind} 第一次应送达`);
    assert.equal(admit(notice(kind)), true, `${kind} 第二次也应送达（不受冷却）`);
  }
});

test('高频类按会话 + 类型冷却', () => {
  let time = 1000;
  const admit = createNoticeAdmission({ cooldownMs: 100, now: () => time });
  assert.equal(admit(notice('turns', 'a')), true);
  assert.equal(admit(notice('turns', 'a')), false, '同一会话同一类型应被冷却');
  assert.equal(admit(notice('repeat', 'a')), true, '不同类型互不影响');
  assert.equal(admit(notice('turns', 'b')), true, '不同会话互不影响');
  time += 101;
  assert.equal(admit(notice('turns', 'a')), true, '冷却过后重新放行');
});

test('未登记类型不进用户通道', () => {
  const admit = createNoticeAdmission();
  assert.equal(admit(notice('debug')), false);
  assert.equal(admit(notice('whatever')), false);
});

test('空消息和非 notice 类型一律拒绝', () => {
  const admit = createNoticeAdmission();
  assert.equal(admit({ ...notice('interrupted'), message: '   ' }), false);
  assert.equal(admit({ ...notice('interrupted'), type: 'other' }), false);
  assert.equal(admit(null), false);
});

test('冷却表不会无限增长', () => {
  const admit = createNoticeAdmission({ cooldownMs: 1, now: () => 1000 });
  for (let i = 0; i < 400; i += 1) admit(notice('turns', `s${i}`));
  // 内部实现细节不做断言，只要求不抛错且仍能正常工作
  assert.equal(admit(notice('turns', 'final')), true);
});
