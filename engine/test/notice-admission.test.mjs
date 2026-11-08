import test from 'node:test';
import assert from 'node:assert/strict';
import { createNoticeAdmission } from '../runtime/notice-admission.mjs';

const notice = (kind, session = 's1') => ({
  type: 'dsh-ios/notice',
  message: '需要处理',
  detail: { kind, session },
});

test('only actionable guard notices are admitted', () => {
  const admit = createNoticeAdmission();
  assert.equal(admit(notice('turns')), true);
  assert.equal(admit(notice('debug')), false);
  assert.equal(admit({ ...notice('repeat'), message: '  ' }), false);
  assert.equal(admit({ ...notice('repeat'), type: 'other' }), false);
});

test('cooldown deduplicates per session and kind', () => {
  let time = 1000;
  const admit = createNoticeAdmission({ cooldownMs: 100, now: () => time });
  assert.equal(admit(notice('repeat', 'a')), true);
  assert.equal(admit(notice('repeat', 'a')), false);
  assert.equal(admit(notice('turns', 'a')), true);
  assert.equal(admit(notice('repeat', 'b')), true);
  time += 101;
  assert.equal(admit(notice('repeat', 'a')), true);
});
