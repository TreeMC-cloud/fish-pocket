// The JavaScript Intl.Segmenter used on small-icu builds, checked against the
// host's full-ICU one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Segmenter } from '../runtime/intl-segmenter.mjs';

const split = (S, text, granularity) => [...new S('en', { granularity }).segment(text)].map((s) => s.segment);

test('graphemes match full ICU on emoji, marks, flags and CJK', () => {
  for (const text of ['hello', '中文测试', 'éclair', '👍🏽 ok', '👨‍👩‍👧‍👦!', '🇨🇳🇺🇸', 'a\r\nb', 'ä️x', '1️⃣2']) {
    assert.deepEqual(split(Segmenter, text, 'grapheme'), split(Intl.Segmenter, text, 'grapheme'), text);
  }
});

test('words carry isWordLike; segments cover the input; containing()', () => {
  const segments = new Segmenter('en', { granularity: 'word' }).segment("don't stop, 42 times");
  const parts = [...segments];
  assert.equal(parts.map((p) => p.segment).join(''), "don't stop, 42 times");
  assert.deepEqual(parts.filter((p) => p.isWordLike).map((p) => p.segment), ["don't", 'stop', '42', 'times']);
  assert.equal(segments.containing(7).segment, 'stop');
  assert.equal(segments.containing(99), undefined);
  assert.deepEqual(split(Segmenter, 'One. Two! 三。', 'sentence'), ['One. ', 'Two! ', '三。']);
  assert.throws(() => new Segmenter('en', { granularity: 'line' }), RangeError);
});
