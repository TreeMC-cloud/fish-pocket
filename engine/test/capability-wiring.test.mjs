// capability-wiring.test.mjs —— 「六项能力」接线的回归钉子
//
// 为什么专门钉这件事：这个项目最大的 bug 类不是写错代码，是机制在、接线无——
// 模块写好了、测试过了、运行时没有任何调用方。scan-orphans.mjs 找的是
// 「全仓没人引」；这里钉得更窄、也更容易被一次重构悄悄摘掉：六项能力各自的
// 关键调用链。断言的是「调用存在」；行为正确性在各自的行为测试里
// （router.test / flight-recorder.test / notice-admission.test / evolve-promote.test…）。
//
// 每一项的钉法都来自 docs/SUPER-AGENT-STATUS.md 的核实结论：
// 改这里之前先读那份文档，说明为什么这条接线不能拆。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

const AUTO = '../plugins/auto-guard/index.mjs';
const MAIN = '../main.mjs';
const ROUTER = '../runtime/router.mjs';
const RUNNER = '../runtime/task-runner.mjs';

test('身份：AGENTS.md 以 BUNDLED:END 收尾，合并逻辑用同一标记', () => {
  const agents = read('../AGENTS.md');
  assert.match(agents, /你是 Sigma/, 'AGENTS.md 必须写明身份（每轮注入的那一份）');
  assert.ok(
    agents.trimEnd().endsWith('<!-- BUNDLED:END -->'),
    'AGENTS.md 必须以 BUNDLED:END 结尾——按它切分更新，缺了会在重启后静默失效',
  );
  // 标记的唯一定义处现在是 agents-md.mjs（main.mjs 只负责读写文件）。
  // 断言「同一个常量被两边共用」，而不是某个具体文件里出现过这行字符串。
  const mod = read('../runtime/agents-md.mjs');
  assert.match(mod, /BUNDLED_END = '<!-- BUNDLED:END -->'/, '合并模块必须用同一个标记');
  assert.match(read(MAIN), /mergeAgentsMd/, 'main.mjs 必须调用合并模块，而不是自己拼');
  assert.match(
    read(MAIN),
    /dirs\.DSH_HOME, 'AGENTS\.md'/,
    '安装位置必须是 $DSH_HOME/AGENTS.md',
  );
});

test('跨任务协调：调度循环真的调用 Router / task-runner / task-control / task-tracking', () => {
  const src = read(AUTO);
  for (const spec of [
    '../../runtime/router.mjs',
    '../../runtime/task-runner.mjs',
    '../../runtime/task-tracking.mjs',
    '../../runtime/task-control.mjs',
  ]) {
    assert.ok(src.includes(`req('${spec}')`), `auto-guard 必须按需加载 ${spec}`);
  }
  assert.match(src, /\btick\(router\)/, '15 秒调度循环必须在调 task-runner.tick()');
  assert.match(src, /\.drain\(router/, '必须处理人工确认请求（task-control.drain）');
  assert.match(read(RUNNER), /router\.sweep\(\)/, 'tick 先 sweep 再 execute——顺序不能反');
  assert.match(read(RUNNER), /router\.execute\(\)/, 'tick 必须推队列');
});

test('恢复：sweep 收僵尸 + 调 gc；main.mjs 启动即报告中断', () => {
  const router = read(ROUTER);
  assert.match(router, /expired\(state/, 'sweep 必须按租约过期识别僵尸任务');
  assert.match(router, /gcRegistry\(state/, 'sweep 必须回收（gc 曾长期没有任何调用方）');
  assert.match(read(MAIN), /reportInterrupted\(data\)/, '启动时必须先读走并报告上次的中断记录');
  assert.match(
    read('../runtime/flight-recorder.mjs'),
    /export function reportInterrupted/,
    'flight-recorder 的报告函数必须存在',
  );
});

test('通知准入：出事类不受冷却；高频类按会话冷却；未知类型不放行', async () => {
  const { createNoticeAdmission } = await import('../runtime/notice-admission.mjs');
  const admit = createNoticeAdmission({ cooldownMs: 60_000 });
  const msg = (kind) => ({ type: 'dsh-ios/notice', message: '占位', detail: { kind, session: 'sess-x' } });

  assert.equal(admit(msg('interrupted')), true, '中断必须送达');
  assert.equal(admit(msg('interrupted')), true, '出事类不受冷却（同一会话再报也要出）');
  assert.equal(admit(msg('injection')), true, '注入必须送达');
  assert.equal(admit(msg('turns')), true, '高频类第一次放行');
  assert.equal(admit(msg('turns')), false, '高频类同会话要冷却');
  assert.equal(admit(msg('some-unknown-kind')), false, '未知类型只进日志，不打扰用户');
});

test('技能：三个 evolve 模块共用同一个候选文件名', () => {
  const nameOf = (rel) => {
    const m = read(rel).match(/'(\.[a-z-]*candidates\.jsonl)'/);
    return m ? m[1] : null;
  };
  const [trace, promote, revoke] = [
    '../skills/evolve/trace.mjs',
    '../skills/evolve/promote.mjs',
    '../skills/evolve/skill-revoke.mjs',
  ].map(nameOf);
  assert.ok(trace && promote && revoke, '三个模块都必须能在源码里找到候选文件名');
  assert.equal(trace, promote, `trace 与 promote 的候选文件名必须一致，现在分别是 ${trace} 和 ${promote}`);
  assert.equal(trace, revoke, `trace 与 skill-revoke 的候选文件名必须一致，现在分别是 ${trace} 和 ${revoke}`);
});

test('技能/记忆：每轮结束自动写 trace；Dream 有运行时触发点', () => {
  const src = read(AUTO);
  assert.match(src, /appendJsonlBounded\(this\.traceFile\(\)/, 'turn/end 必须自动写 trace');
  assert.match(src, /this\.maybeDream\(\)/, '必须有 Dream 的轮次触发点');
  assert.match(src, /runDream\(this\.dataDir\(\)/, '触发点要真的调用 runDream');
});

test('记忆：构建脚本保护 prompts 与 dsh install anchor', () => {
  const sh = fs.readFileSync(new URL('../../scripts/build-engine.sh', import.meta.url), 'utf8');
  assert.ok(
    sh.includes('! -path "$nm/*/prompts/*"'),
    '剪枝必须放行 */prompts/*（meow-memory 在模块初始化时读它，删了整层不激活）',
  );
  assert.ok(
    sh.includes('! -path "$nm/*/skills/*"'),
    '剪枝必须放行 */skills/*（插件在运行时读这些提示词）',
  );
  assert.match(sh, /injected meow-memory@%s into dsh install anchor/, '必须把 meow-memory 注入 dsh 包的 dependencies');
});

test('定时任务：schedule-bridge 只读——不导出会改变 schedule 状态的函数', () => {
  const bridge = read('../runtime/schedule-bridge.mjs');
  const exported = [...bridge.matchAll(/export function (\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    exported,
    ['isDue', 'summarize', 'toEvent'],
    '只允许这三个只读辅助函数；harvest 一类会重复投递，已删除，不要加回来',
  );
  assert.match(read(AUTO), /这里\*\*不\*\*去 harvest/, 'auto-guard 必须保留「不接管投递」的注释与行为');
});
