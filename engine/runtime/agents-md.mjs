// AGENTS.md 的合并逻辑，抽成纯函数以可测。
//
// 为什么要单独一个文件：这段逻辑决定「身份文件的更新能不能传到已装设备」，
// 而它原本内联在 main.mjs 的启动流程里——main.mjs 一 import 就有副作用
//（建目录、读环境、起 worker），根本没法测。
//
// 踩过的坑：老实现是「找 `<!-- SCENE:BEGIN -->`，有就保留后半段，没有就用原文件不动」。
// 而包内的 AGENTS.md 本身没有 SCENE 标记，于是设备上那份（首次安装时写入的旧版）
// **永远不会被更新**——改了身份描述、加了记忆工具说明，真机上一点变化都没有，
// 而且完全静默。

/** 包内铁律段到此结束。用它切分，比猜哪部分是旧铁律可靠。 */
export const BUNDLED_END = '<!-- BUNDLED:END -->';
/** 场景段（scene.mjs 运行时写的）从这里开始，之后的内容一律保留。 */
export const SCENE_BEGIN = '<!-- SCENE:BEGIN -->';

/**
 * 保证包内铁律以结束标记收尾。
 * @param {string} bundledRaw - 包内 AGENTS.md 原文。
 * @returns {string} 带标记的版本；已有标记则原样返回。
 */
export function withMarker(bundledRaw) {
  const trimmed = String(bundledRaw ?? '').trimEnd();
  return trimmed.endsWith(BUNDLED_END) ? trimmed : `${trimmed}\n${BUNDLED_END}`;
}

/**
 * 决定目标文件应该是什么内容。
 *
 * 三种设备状态，三种处理：
 *   1. 有 `BUNDLED:END`      → 换掉标记之前的铁律段，标记之后（场景+用户内容）原样保留
 *   2. 只有 `SCENE:BEGIN`    → 老设备：从 SCENE 处切开，前面整体替换
 *   3. 两者都没有            → 分不清哪部分是旧铁律、哪部分是用户手写
 *
 * 第 3 种是最难的。这里返回 `overwrite: true` 让调用方先备份再写——
 * 宁可留一份 `.bak`，也不要静默丢掉用户写的东西。
 *
 * @param {string} bundledRaw - 包内 AGENTS.md 原文。
 * @param {string} existing - 目标文件现有内容；不存在时传 null。
 * @returns {{ next: string, changed: boolean, overwrite: boolean }}
 */
export function mergeAgentsMd(bundledRaw, existing) {
  const bundled = withMarker(bundledRaw);

  // 没有旧文件：直接落盘。
  if (existing === null || existing === undefined) {
    return { next: bundled, changed: true, overwrite: false };
  }

  const bundledMark = existing.indexOf(BUNDLED_END);
  if (bundledMark >= 0) {
    // 正常路径：替换铁律段，保留标记之后的所有内容。
    const tail = existing.slice(bundledMark + BUNDLED_END.length);
    const next = `${bundled}${tail}`;
    return { next, changed: next !== existing, overwrite: false };
  }

  const sceneMark = existing.indexOf(SCENE_BEGIN);
  if (sceneMark >= 0) {
    // 老设备：铁律在前、SCENE 段在后。
    const next = `${bundled}\n\n${existing.slice(sceneMark)}`;
    return { next, changed: next !== existing, overwrite: false };
  }

  // 两者都没有：无法判断，交给调用方备份后覆盖。
  return { next: bundled, changed: existing !== bundled, overwrite: existing !== bundled };
}
