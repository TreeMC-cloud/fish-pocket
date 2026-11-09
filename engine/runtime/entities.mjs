// entities.mjs —— 从一段话里认出「实体」，用来按东西检索记忆
//
// ## 为什么需要
//
// 七层记忆有了，但检索是**关键词匹配取 top-2**。真实场景是：
// 「我在改这个文件，之前关于它决定过什么」「这个模块上次为什么那么改」。
// 这种问题拿一句自然语言去搜，命中率很低——一模一样的措辞不会再出现一次。
//
// 而文件路径、模块名、错误码是**稳定标识**：`engine/runtime/router.mjs`
// 每次出现都是同一个字符串。把它们抽出来当检索键，比自然语言靠谱得多。
//
// ## 只认确定性的东西
//
// 不做模糊匹配、不做同义词扩展。抽不出来就返回空数组——
// 抽错了会把不相干的记忆塞进上下文，比不检索更糟。

/** 文件路径：至少带一个斜杠或一个已知扩展名。 */
const PATH_RE = /(?:^|[\s(（"'`])((?:[\w.\-]+\/)+[\w.\-]+|[\w.\-]+\.(?:mjs|js|ts|tsx|jsx|swift|json|yml|yaml|md|sh|py|sql|plist|toml))(?![\w\/])/g;

/** 包名 / 模块名：dsh 生态里都是 `dsh-xxx` 或 `@scope/name` 的形式。 */
const MODULE_RE = /(@[a-z0-9][\w.\-]*\/[\w.\-]+|\bdsh-[a-z0-9][\w\-]*\b)/g;

/** 错误码：全大写下划线，至少两段，或常见的单段码。 */
const CODE_RE = /\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+|[A-Z]{3,12}_?[A-Z]*)\b/g;

/** 太常见的单词不配当实体（会把所有记忆都搜出来）。 */
const STOP = new Set(['ACCEPT', 'PASS', 'FAIL', 'TODO', 'NOTE', 'API', 'JSON', 'HTTP', 'HTTPS', 'URL', 'ID', 'OK']);

/**
 * 抽取实体。
 *
 * @param {string} text
 * @param {{limit?:number}} [opts]
 * @returns {string[]} 去重后的实体，最多 limit 条
 */
export function extractEntities(text, { limit = 8 } = {}) {
  const s = String(text ?? '');
  if (!s) return [];
  const found = [];

  for (const m of s.matchAll(PATH_RE)) {
    const p = m[1].replace(/^\.\//, '');
    // 单段文件名（如 `package.json`）信息量太低，除非它带目录
    if (!p.includes('/') && p.length < 8) continue;
    found.push(p);
  }
  for (const m of s.matchAll(MODULE_RE)) found.push(m[1]);
  for (const m of s.matchAll(CODE_RE)) {
    const code = m[1];
    if (STOP.has(code)) continue;
    if (code.length < 4) continue;
    found.push(code);
  }

  // 去重但保持出现顺序（先出现的通常更重要）
  const seen = new Set();
  const out = [];
  for (const e of found) {
    const key = e.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/** 把实体并进关键词：meow-memory 的检索就是按 keywords 匹配的。 */
export function mergeKeywords(keywords, entities, { limit = 24 } = {}) {
  const out = [];
  const seen = new Set();
  for (const k of [...(keywords ?? []), ...(entities ?? [])]) {
    const s = String(k ?? '').trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}
