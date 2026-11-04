// nodejs-mobile is built with small-icu, which leaves out ICU's break
// iteration data: Intl.Segmenter#segment then dereferences a null break
// iterator and takes the whole app down (SIGSEGV). Terminal UIs measure text
// with it (string-width, Claude Code), so it is replaced by a JavaScript
// segmenter on such builds: graphemes by Unicode properties (combining marks,
// ZWJ sequences, emoji modifiers, regional-indicator pairs, CRLF), words as
// runs of letters/digits, sentences up to terminal punctuation.
const GRAPHEME = /\r\n|\p{RI}\p{RI}|(?:\P{M}|\n)(?:[\p{M}‌️\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]|‍\p{Extended_Pictographic}[\p{M}️]*)*|./gsu;
const WORD = /[\p{L}\p{N}\p{M}_'’]+|\s+|./gsu;
const SENTENCE = /[^.!?。！？]+(?:[.!?。！？]+["'”’)\]]*\s*)?|[.!?。！？]+\s*/gsu;

class Segments {
  #text;
  #parts;
  constructor(text, parts) { this.#text = text; this.#parts = parts; }
  containing(index = 0) {
    const i = Math.trunc(Number(index) || 0);
    if (i < 0 || i >= this.#text.length) return undefined;
    return this.#parts.find((p) => i >= p.index && i < p.index + p.segment.length);
  }
  [Symbol.iterator]() { return this.#parts[Symbol.iterator](); }
}

export class Segmenter {
  #granularity;
  constructor(locales, options = {}) {
    const granularity = options?.granularity ?? 'grapheme';
    if (!['grapheme', 'word', 'sentence'].includes(granularity)) throw new RangeError(`Value ${granularity} out of range for Intl.Segmenter options property granularity`);
    this.#granularity = granularity;
  }
  segment(input) {
    const text = String(input);
    const pattern = this.#granularity === 'word' ? WORD : this.#granularity === 'sentence' ? SENTENCE : GRAPHEME;
    const parts = [];
    for (const match of text.matchAll(pattern)) {
      const part = { segment: match[0], index: match.index, input: text };
      if (this.#granularity === 'word') part.isWordLike = /[\p{L}\p{N}]/u.test(match[0]);
      parts.push(part);
    }
    return new Segments(text, parts);
  }
  resolvedOptions() { return { locale: 'en', granularity: this.#granularity }; }
  static supportedLocalesOf() { return ['en']; }
  get [Symbol.toStringTag]() { return 'Intl.Segmenter'; }
}

/** Replace the native segmenter where it would crash (small-icu builds). */
export function installSegmenter() {
  if (process.config.variables.icu_small !== true || Intl.Segmenter === Segmenter) return;
  Object.defineProperty(Intl, 'Segmenter', { value: Segmenter, configurable: true, writable: true });
}
