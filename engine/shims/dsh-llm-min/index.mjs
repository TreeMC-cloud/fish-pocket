/**
 * @deepseek-ai/dsh-llm 的最小替身（只实现 meow-memory 用到的那两个函数）。
 *
 * 为什么要这个 shim：
 *   meow-memory 静态 import 了 @deepseek-ai/dsh-llm 的 createUserMessage 和
 *   boundContextSummary。而 dsh-llm@0.0.1-rc.1 的 peer 依赖要求
 *   dsh-brand/timeout/attachment/invariants 都是 ^0.0.1-rc.1，
 *   宿主 dsh@0.2.2-rc.1 用的却是 0.2.2-rc.1 —— 两套版本 npm 无法同时满足。
 *
 *   而 dsh-invariants 根本没有 0.2.2 版本（最新只到 0.2.0-rc.2），
 *   所以「把 dsh-llm 升到配套版本」这条路不存在。
 *
 *   退回来看它到底用了什么：只有两个函数，而且逻辑各十行以内。
 *   与其为了两个函数拖进一整棵不兼容的依赖树，不如按原实现逐字复刻。
 *
 * 判据：这两个函数的行为必须和 dsh-llm 完全一致，否则 meow-memory 的消息
 * 会被宿主拒绝（角色标签、冻结语义、id 格式都会对不上）。
 * 复刻来源：dsh-llm@0.0.1-rc.1 的 lib/index.js（第 149-180 行）。
 */

import crypto from 'node:crypto';

/**
 * 深冻结。原实现用 structuredClone + 递归 Object.freeze。
 * 为什么必须冻结：宿主会把消息对象放进不可变状态树，未冻结的对象
 * 可能被下游误改，导致会话历史静默损坏。
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** 与 dsh-llm 的 MessageId 一致：带前缀的字符串，便于日志里一眼认出。 */
function makeMessageId(uuid) {
  return `msg_${uuid}`;
}

/**
 * 上下文摘要截断：超过 120 字符就截到 119 + 省略号。
 * 这个 120 是硬编码在 dsh-llm 里的（CONTEXT_SUMMARY_MAX_CHARS），
 * 不能自己改成更好看的数字 —— 宿主按这个长度做预算。
 */
export function boundContextSummary(summary) {
  return summary.length <= 120 ? summary : `${summary.slice(0, 119)}…`;
}

/** 建一条带稳定 id 的消息并冻结。 */
function createMessage(input) {
  return deepFreeze({
    ...input,
    id: makeMessageId(crypto.randomUUID()),
  });
}

/**
 * 建一条 user 角色的消息。
 * meow-memory 用它把「从记忆库里召回的内容」包装成一条 user 消息，
 * 再插进会话 —— 所以 role 必须是 'user'，不能是 'system'。
 */
export function createUserMessage(input) {
  return createMessage({ ...input, role: 'user' });
}

/** 给不支持的符号一个明确的报错，而不是 undefined。 */
export default new Proxy(
  { createUserMessage, boundContextSummary },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'then') return undefined;   // 别让 ESM 把包当成 thenable
      throw new Error(
        `dsh-llm-min 只实现了 createUserMessage / boundContextSummary，` +
        `不提供 ${String(prop)}。需要它就去读 dsh-llm 原实现再补进来。`
      );
    },
  }
);
