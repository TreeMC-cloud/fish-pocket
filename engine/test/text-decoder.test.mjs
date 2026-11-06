// The JavaScript GBK decoder used on small-icu builds, checked against the
// host's full-ICU one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TextDecoder as Ours } from '../runtime/text-decoder.mjs';

const Full = globalThis.TextDecoder;
const native = (label, options) => new Full(label, options);

test('matches full ICU across the GBK double-byte range', () => {
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      const pair = Uint8Array.of(lead, trail);
      const expected = native('gb18030').decode(pair);
      assert.equal(new Ours('gbk').decode(pair), expected, `${lead.toString(16)} ${trail.toString(16)}`);
    }
  }
});

test('decodes Chinese text the way a plugin sniffing GBK does', () => {
  const bytes = Uint8Array.of(0xd6, 0xd0, 0xce, 0xc4, 0x61);
  assert.equal(new Ours('gbk', { fatal: true }).decode(bytes), '中文a');
  assert.equal(new Ours('GB2312').decode(bytes.buffer), '中文a');
  assert.equal(new Ours(' gb18030 ').decode(Buffer.from(bytes)), '中文a');
});

test('fatal rejects what is not GBK, as a sniffer relies on', () => {
  const utf8 = new TextEncoder().encode('😀'.repeat(2) + '\xFF');
  for (const input of [Uint8Array.of(0xff), Uint8Array.of(0xd6), Uint8Array.of(0x81, 0x20)]) {
    assert.throws(() => native('gb18030', { fatal: true }).decode(input), { code: 'ERR_ENCODING_INVALID_ENCODED_DATA' });
    assert.throws(() => new Ours('gbk', { fatal: true }).decode(input), { code: 'ERR_ENCODING_INVALID_ENCODED_DATA' });
  }
});

test('without fatal, a bad sequence becomes U+FFFD', () => {
  assert.equal(new Ours('gbk').decode(Uint8Array.of(0x61, 0xff, 0x62)), native('gb18030').decode(Uint8Array.of(0x61, 0xff, 0x62)));
});

test('streaming keeps a character split across chunks', () => {
  const decoder = new Ours('gbk');
  assert.equal(decoder.decode(Uint8Array.of(0xd6), { stream: true }), '');
  assert.equal(decoder.decode(Uint8Array.of(0xd0), { stream: true }), '中');
  assert.equal(decoder.decode(), '');
});

test('reports the standard name and leaves every other encoding native', () => {
  assert.equal(new Ours('gb2312').encoding, 'gbk');
  assert.equal(new Ours('x-gbk').encoding, 'gbk');
  assert.equal(new Ours('gb18030').encoding, 'gb18030');
  assert.equal(new Ours().encoding, 'utf-8');
  assert.equal(new Ours('utf-8').decode(new TextEncoder().encode('中文')), '中文');
  assert.equal(new Ours('utf-16le').encoding, 'utf-16le');
  assert.ok(new Ours('gbk') instanceof Full);
  assert.throws(() => new Ours('no-such-encoding'), { code: 'ERR_ENCODING_NOT_SUPPORTED' });
});
