// AGENTS.md 合并逻辑的测试。
//
// 为什么必须有：这段逻辑决定「身份文件的更新能不能传到已装设备」。
// 老实现只要目标文件里没有 `<!-- SCENE:BEGIN -->` 就直接不改，
// 而包内的 AGENTS.md 本身没有 SCENE 标记 —— 于是设备上那份永远是首装版本，
// 改身份描述、加记忆工具说明，真机上一点变化都没有，而且完全静默。
//
// 这个 bug 靠人眼看不出来（两份文件都合法，只是旧的没被替换），
// 所以每条分支都要有测试钉住。

import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeAgentsMd, withMarker, BUNDLED_END, SCENE_BEGIN } from '../runtime/agents-md.mjs';

const BUNDLED_V1 = '# 铁律 v1\n\n你是 Sigma。';
const BUNDLED_V2 = '# 铁律 v2\n\n你是 Sigma（Σ）。';

test('withMarker：没有标记时补上，有时不重复补', () => {
  assert.ok(withMarker(BUNDLED_V1).endsWith(BUNDLED_END));
  const once = withMarker(BUNDLED_V1);
  assert.equal(withMarker(once), once, '已经有标记就不该再补一条');
});

test('首次安装：目标不存在时直接写带标记的版本', () => {
  const { next, changed, overwrite } = mergeAgentsMd(BUNDLED_V1, null);
  assert.equal(changed, true);
  assert.equal(overwrite, false, '首次安装不是「覆盖」，不需要备份');
  assert.ok(next.includes('铁律 v1'));
  assert.ok(next.endsWith(BUNDLED_END));
});

test('回归：设备上是旧铁律且没有 SCENE 标记时，更新必须生效', () => {
  // 这是真实踩过的场景：首装写入 v1，之后包内升级到 v2，设备文件里既没有
  // BUNDLED:END（老版本写的）也没有 SCENE（还没跑过 scene.mjs）。
  const existing = `${BUNDLED_V1}\n`;
  const { next, changed } = mergeAgentsMd(BUNDLED_V2, existing);
  assert.equal(changed, true, '包内铁律更新后必须写盘——否则改动永远到不了设备');
  assert.ok(next.includes('铁律 v2'), '新铁律要出现');
  assert.ok(!next.includes('铁律 v1'), '旧铁律要被替换掉，不是叠加');
});

test('有 BUNDLED:END：只换铁律段，标记之后的内容原样保留', () => {
  const existing = `${withMarker(BUNDLED_V1)}\n\n${SCENE_BEGIN}\n当前项目：fish-pocket\n用户手写：别改我的代码风格\n`;
  const { next, changed } = mergeAgentsMd(BUNDLED_V2, existing);
  assert.equal(changed, true);
  assert.ok(next.includes('铁律 v2'));
  assert.ok(next.includes('当前项目：fish-pocket'), '场景段必须保留');
  assert.ok(next.includes('别改我的代码风格'), '用户手写的内容必须保留');
  // 场景段只应出现一次，不能因为拼接重复
  assert.equal(next.split(SCENE_BEGIN).length - 1, 1, 'SCENE 标记不能重复');
});

test('已经是最新：不应该写盘（避免每次启动都改 mtime）', () => {
  const existing = withMarker(BUNDLED_V1);
  const { changed } = mergeAgentsMd(BUNDLED_V1, existing);
  assert.equal(changed, false, '内容没变就不该写，否则 mtime 每次都动');
});

test('老设备只有 SCENE 段：从 SCENE 处切开，前面整体替换', () => {
  const existing = `旧铁律很旧\n\n${SCENE_BEGIN}\n场景内容\n`;
  const { next, changed } = mergeAgentsMd(BUNDLED_V2, existing);
  assert.equal(changed, true);
  assert.ok(next.includes('铁律 v2'));
  assert.ok(next.includes('场景内容'), '场景段要保留');
  assert.ok(!next.startsWith('旧铁律很旧'), '旧的铁律段要被换掉');
});

test('两种标记都没有：要求调用方先备份再覆盖（不静默丢用户内容）', () => {
  // 这里 `overwrite: true` 是给调用方的信号：先写 .bak 再覆盖。
  const existing = '完全无法判断的一段文字\n用户可能自己写的\n';
  const { next, changed, overwrite } = mergeAgentsMd(BUNDLED_V2, existing);
  assert.equal(changed, true);
  assert.equal(overwrite, true, '无法判断时必须让调用方备份，不能静默覆盖');
  assert.equal(next, withMarker(BUNDLED_V2));
});

test('两种标记都没有、但内容恰好等于最新版：不覆盖也不要求备份', () => {
  const bundled = withMarker(BUNDLED_V2);
  const { changed, overwrite } = mergeAgentsMd(BUNDLED_V2, bundled);
  assert.equal(changed, false);
  assert.equal(overwrite, false);
});
