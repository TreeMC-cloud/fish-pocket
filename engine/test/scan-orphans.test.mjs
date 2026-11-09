import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scan } from '../tools/scan-orphans.mjs';

/**
 * scan-orphans 的测试。
 *
 * 这个工具本身没有运行时副作用，但它**判错**的代价很高：把「已经接好线的模块」
 * 报成孤儿，下一个人就会去「修」一个不存在的 bug，或者把还在用的文件删掉。
 * 第一次跑它时 96 个文件里报了 63 个真孤儿，其中 capability-status 明明被
 * auto-guard 用 createRequire 引着——这类误报比漏报更贵，因为它会误导行动。
 *
 * 所以这里测两类东西：
 *   1. 回归：曾经被误报的那批真实模块，现在必须在 used 里（跑真实 engine 目录）。
 *   2. 判据本身：用临时目录造最小样本，验证「孤儿 / CLI / 入口 / 被引用」
 *      四条分类规则各自成立。合成样本比真实目录更能锁住语义——真实目录会变，
 *      判据不该跟着变。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '..');

/** 相对 engine 根目录的短路径，断言失败时打印出来更好读。 */
const rel = (f, base = ENGINE) => path.relative(base, f).split(path.sep).join('/');

/** 某个分类里是否包含指定相对路径的文件。 */
const has = (list, target, base = ENGINE) => list.some((f) => rel(f, base) === target);

/**
 * 造一个临时「引擎目录」。
 *
 * 为什么用临时目录而不是真实目录：判据测试必须能造出「没人引用」「只自引用」
 * 这种真实仓库里不存在的极端形态。往真仓库里塞这种文件既脏又容易被删。
 *
 * 注意目录名不能叫 test / tools / p1 / proj1——这些在 SKIP_DIRS 里，
 * 造进去等于没造（walk 根本不会进去）。
 */
function makeEngine(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-orphans-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

/** 带 CLI 守卫的最小模块：直接运行时才执行，被 import 时什么都不做。 */
const CLI_GUARD = `import { pathToFileURL } from 'node:url';

function main() { console.log('hi'); }

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
`;

// ---------------------------------------------------------------------------
// 1. 回归：真实引擎里的 capability-status 不能被报成孤儿
// ---------------------------------------------------------------------------

test('capability-status.mjs 不被报成孤儿（auto-guard 用 createRequire 引用）', () => {
  const r = scan(ENGINE);
  const target = 'runtime/capability-status.mjs';

  assert.ok(
    !has(r.orphans, target),
    `capability-status.mjs 被误报成孤儿。auto-guard 里明明有 req('../../runtime/capability-status.mjs')。`,
  );
  assert.ok(
    has(r.used, target),
    'capability-status.mjs 应该在 used（被引用）里，而不是落进任何「没人用」的分组。',
  );
});

test('auto-guard 的 5 个 createRequire 目标都不在孤儿列表', () => {
  // 这五个模块的共同点：**自身没有任何本地 import**（只 import node: 内置模块），
  // 所以它们最容易被「零引用 = 只自引用」这个错误判据吞掉。
  const targets = [
    'runtime/capability-status.mjs',
    'runtime/task-tracking.mjs',
    'runtime/router.mjs',
    'runtime/task-runner.mjs',
    'runtime/schedule-bridge.mjs',
  ];
  const r = scan(ENGINE);

  for (const t of targets) {
    assert.ok(!has(r.orphans, t), `${t} 被误报成孤儿`);
    assert.ok(has(r.used, t), `${t} 应该计入 used`);
  }
});

// ---------------------------------------------------------------------------
// 2. 入口：main / boot / plugins/*/index.mjs 归 entries，不算孤儿
// ---------------------------------------------------------------------------

test('真实引擎：main.mjs、boot.mjs、plugins/*/index.mjs 都归入 entries', () => {
  const r = scan(ENGINE);
  assert.ok(has(r.entries, 'main.mjs'), 'main.mjs 应是入口');
  assert.ok(has(r.entries, 'boot.mjs'), 'boot.mjs 应是入口');

  const plugins = r.entries.filter((f) => /^plugins\/[^/]+\/index\.mjs$/.test(rel(f)));
  assert.ok(plugins.length >= 4, `应有至少 4 个插件入口，实际 ${plugins.length}`);

  // 入口绝不能同时出现在孤儿里——那会让「入口文件被当成死代码删掉」变成现实风险。
  for (const e of r.entries) {
    assert.ok(!r.orphans.includes(e), `入口 ${rel(e)} 同时被列为孤儿`);
  }
});

test('合成目录：入口判定不依赖文件内容，只看路径', () => {
  const dir = makeEngine({
    // 入口文件故意什么都不写：入口的身份来自「谁拉起它」，不是它自己写了什么。
    'main.mjs': 'export const x = 1;\n',
    'boot.mjs': 'export const y = 2;\n',
    'plugins/demo/index.mjs': 'export const z = 3;\n',
    // 同样内容，但不在入口路径上 —— 没人引用就该报孤儿。
    'plugins/demo/helper.mjs': 'export const w = 4;\n',
  });
  const r = scan(dir);

  assert.ok(has(r.entries, 'main.mjs', dir));
  assert.ok(has(r.entries, 'boot.mjs', dir));
  assert.ok(has(r.entries, 'plugins/demo/index.mjs', dir));
  assert.ok(!has(r.orphans, 'plugins/demo/index.mjs', dir));

  assert.ok(has(r.orphans, 'plugins/demo/helper.mjs', dir), '插件目录里的非 index 文件不是入口');
});

// ---------------------------------------------------------------------------
// 3. 真孤儿：没人引用、也没有 CLI 守卫
// ---------------------------------------------------------------------------

test('合成目录：没人引用也没有守卫的 .mjs 必须被找出来', () => {
  const dir = makeEngine({
    'runtime/lonely.mjs': 'export function nobodyCalls() {}\n',
  });
  const r = scan(dir);

  assert.deepEqual(r.orphans.map((f) => rel(f, dir)), ['runtime/lonely.mjs']);
  assert.equal(r.counts.orphans, 1);
});

test('合成目录：有 CLI 守卫的 .mjs 归 clis，不进 orphans', () => {
  const dir = makeEngine({
    'runtime/standalone.mjs': CLI_GUARD,
  });
  const r = scan(dir);

  assert.ok(has(r.clis, 'runtime/standalone.mjs', dir), '带守卫的文件应归入 clis');
  assert.ok(!has(r.orphans, 'runtime/standalone.mjs', dir), '带守卫的文件不是孤儿');
  assert.equal(r.counts.orphans, 0);
});

test('合成目录：被 import 的模块进 used；import 它的那个才是孤儿', () => {
  const dir = makeEngine({
    // 被引用方：零本地 import —— 正是历史 bug 里被吞掉的那种形状。
    'runtime/leaf.mjs': 'export function leaf() {}\n',
    // 引用方：自己没人引用，所以它才是孤儿。
    'runtime/caller.mjs': "import { leaf } from './leaf.mjs';\nexport const v = leaf;\n",
  });
  const r = scan(dir);

  assert.ok(has(r.used, 'runtime/leaf.mjs', dir), '被 import 的模块不能算孤儿');
  assert.ok(has(r.orphans, 'runtime/caller.mjs', dir), '没人引用 caller，它自己才是孤儿');
});

test('合成目录：只 import 自己的文件仍算孤儿', () => {
  // 自引用是「看起来有引用、其实没有调用方」的典型形态，不能因此被放过。
  const dir = makeEngine({
    'runtime/narcissus.mjs': "import './narcissus.mjs';\nexport const n = 1;\n",
  });
  const r = scan(dir);

  assert.ok(has(r.orphans, 'runtime/narcissus.mjs', dir), '只自引用的文件仍然是孤儿');
});

// ---------------------------------------------------------------------------
// 4. 引用收集必须覆盖入口文件（旧 bug 的另一个面）
// ---------------------------------------------------------------------------

test('合成目录：插件入口里的 createRequire 引用必须被收集', () => {
  // 旧实现先 `if (isEntryPoint(f)) continue;` 再收集引用，于是插件入口里
  // 那些按需加载的模块一条都收不到，全被报成孤儿。
  const dir = makeEngine({
    'plugins/demo/index.mjs': [
      "import { createRequire } from 'node:module';",
      'const req = createRequire(import.meta.url);',
      "export const lazy = () => req('../../runtime/lazy.mjs');",
      '',
    ].join('\n'),
    'runtime/lazy.mjs': 'export const lazy = 1;\n',
  });
  const r = scan(dir);

  assert.ok(has(r.used, 'runtime/lazy.mjs', dir), '插件入口里的 createRequire 引用没被收集');
  assert.ok(has(r.entries, 'plugins/demo/index.mjs', dir));
  assert.equal(r.counts.orphans, 0);
});

test('合成目录：import / export from / 动态 import 三种写法都算引用', () => {
  const dir = makeEngine({
    'runtime/a.mjs': 'export const a = 1;\n',
    'runtime/b.mjs': 'export const b = 2;\n',
    'runtime/c.mjs': 'export const c = 3;\n',
    'main.mjs': [
      "import { a } from './runtime/a.mjs';",
      "export { b } from './runtime/b.mjs';",
      "export const loadC = () => import('./runtime/c.mjs');",
      'export const all = [a, loadC];',
      '',
    ].join('\n'),
  });
  const r = scan(dir);

  for (const t of ['runtime/a.mjs', 'runtime/b.mjs', 'runtime/c.mjs']) {
    assert.ok(has(r.used, t, dir), `${t} 的引用写法没被识别`);
    assert.ok(!has(r.orphans, t, dir), `${t} 被误报成孤儿`);
  }
});

// ---------------------------------------------------------------------------
// 5. 汇总自洽：四类互斥且覆盖全部文件
// ---------------------------------------------------------------------------

test('四类互斥、合计等于文件总数（真实引擎 + 合成目录）', () => {
  const dirs = [
    ENGINE,
    makeEngine({
      'main.mjs': 'export const m = 1;\n',
      'runtime/lonely.mjs': 'export const l = 1;\n',
      'runtime/standalone.mjs': CLI_GUARD,
      'runtime/leaf.mjs': 'export const leaf = 1;\n',
      'runtime/caller.mjs': "import { leaf } from './leaf.mjs';\nexport const v = leaf;\n",
    }),
  ];

  for (const dir of dirs) {
    const r = scan(dir);
    const all = [...r.orphans, ...r.clis, ...r.entries, ...r.used];

    assert.equal(new Set(all).size, all.length, `${dir}: 有文件被分进多个类`);
    assert.equal(all.length, r.counts.total, `${dir}: 分类总数与 total 不一致`);
    assert.equal(
      r.counts.orphans + r.counts.clis + r.counts.entries + r.counts.used,
      r.counts.total,
      `${dir}: counts 相加不等于 total`,
    );
  }
});
