// ⚠️ 这个模块**当前没有被接线**，而且**依赖缺失**。接上之前先读这段。
//
// 它想解决的问题是真的：nodejs-mobile 用 small-icu 构建，不带遗留编码，
// `new TextDecoder('gbk')` 会抛 ERR_ENCODING_NOT_SUPPORTED；而桌面版 Node
// 是标准调用。为桌面写的插件会在 import 期就调用它，于是插件加载失败，
// 或者退回 UTF-8 把中文解成乱码。
//
// 但它实现不下去了：decode 时要 `require('iconv-lite')`，
// 而这个包在 engine/package.json、仓库、构建产物里**都不存在**。
// 现在调用 `installTextDecoder()` 的后果是：检测到原生不支持 GBK → 替换全局
// TextDecoder → 真正解码时抛 MODULE_NOT_FOUND。比不替换更糟
// （原生至少抛的是清晰的 ERR_ENCODING_NOT_SUPPORTED）。
//
// 所以它目前是**未接线的半成品**，留着是为了不丢掉这段分析和实现骨架。
// 要真正启用，需要三步：
//   1. 把 iconv-lite 加进 engine/package.json 的 dependencies，确认它能进包
//   2. 在 boot.mjs 里 import 并调用 installTextDecoder()（跟 installSegmenter
//      放在一起，那两个是同一类 iOS 适配）
//   3. 补一个测试：在 small-icu 环境下 `new TextDecoder('gbk')` 能正确解出中文
//
// 在此之前，中文文本在引擎侧按 UTF-8 走；GBK 输入会失败——这是已知限制。
//
// 实现原文如下（GBK/GB18030 在 JavaScript 里解码；其余标签走原生；
// 码表首次使用时才加载）：
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
