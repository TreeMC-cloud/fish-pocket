// nodejs-mobile is built with small-icu, which carries no legacy encodings:
// `new TextDecoder('gbk')` throws ERR_ENCODING_NOT_SUPPORTED, while on any
// official Node build it is a standard call. Plugins written for desktop make
// it, some of them while their module loads, so the plugin then fails to
// import, or falls back to UTF-8 and garbles the text. GBK and GB18030 are
// decoded here in JavaScript on such builds; every other label stays native.
// The tables load on first use.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import util from 'node:util';

const require = createRequire(import.meta.url);
const Native = globalThis.TextDecoder;

// The WHATWG Encoding Standard's labels. Its GBK decoder is its gb18030 decoder.
const ENCODINGS = new Map([
  ...['chinese', 'csgb2312', 'csiso58gb231280', 'gb2312', 'gb_2312', 'gb_2312-80', 'gbk', 'iso-ir-58', 'x-gbk'].map((label) => [label, 'gbk']),
  ['gb18030', 'gb18030'],
]);

// iconv-lite keeps GB18030-2000's private-use code points for characters Unicode
// has since encoded; the standard, and full ICU, use the real ones.
const ENCODED_SINCE = new Map([
  ['\ue78d', '\ufe10'], ['\ue78e', '\ufe12'], ['\ue78f', '\ufe11'], ['\ue790', '\ufe13'], ['\ue791', '\ufe14'],
  ['\ue792', '\ufe15'], ['\ue793', '\ufe16'], ['\ue794', '\ufe17'], ['\ue795', '\ufe18'], ['\ue796', '\ufe19'],
  ['\ue81e', '\u9fb4'], ['\ue826', '\u9fb5'], ['\ue82b', '\u9fb6'], ['\ue82c', '\u9fb7'], ['\ue832', '\u9fb8'],
  ['\ue843', '\u9fb9'], ['\ue854', '\u9fba'], ['\ue864', '\u9fbb'],
]);
const PRIVATE_USE = new RegExp(`[${[...ENCODED_SINCE.keys()].join('')}]`, 'g');

const bytes = (input) => (ArrayBuffer.isView(input)
  ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  : Buffer.from(input));

export class TextDecoder extends Native {
  #encoding;
  #decoder;

  constructor(label = 'utf-8', options = {}) {
    const encoding = ENCODINGS.get(String(label).trim().toLowerCase());
    super(encoding ? 'utf-8' : label, options);
    this.#encoding = encoding;
  }

  // The native constructor reads this before #encoding exists.
  get encoding() { return (#encoding in this ? this.#encoding : undefined) ?? super.encoding; }

  decode(input = new Uint8Array(), options = {}) {
    if (!this.#encoding) return super.decode(input, options);
    // WHATWG: only the UTF encodings consume a BOM.
    this.#decoder ??= require('iconv-lite').getDecoder('gb18030', { stripBOM: false });
    let text = this.#decoder.write(bytes(input));
    if (!options?.stream) {
      text += this.#decoder.end() ?? '';
      this.#decoder = undefined;
    }
    if (this.fatal && text.includes('\ufffd')) {
      this.#decoder = undefined;
      const error = new TypeError(`The encoded data was not valid for encoding ${this.#encoding}`);
      error.code = 'ERR_ENCODING_INVALID_ENCODED_DATA';
      throw error;
    }
    return text.replace(PRIVATE_USE, (character) => ENCODED_SINCE.get(character));
  }
}

/** Replace the native decoder where it has no GBK (small-icu builds). */
export function installTextDecoder() {
  try { new Native('gbk'); return; } catch { /* small-icu */ }
  globalThis.TextDecoder = TextDecoder;
  util.TextDecoder = TextDecoder;
  syncBuiltinESMExports();
}
