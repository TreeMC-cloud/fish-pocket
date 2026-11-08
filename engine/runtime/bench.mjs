#!/usr/bin/env node
/**
 * bench.mjs —— 基准测量（BENCH-001）
 *
 * 这个文件的目的不是证明「我们很快」，而是让「变快了 / 变慢了」有数字。
 * 没有基线的优化都是猜测；没有重复测量的结论都不可复现。
 *
 * 测三件对 Super-agent 最关键的、且**当前代码真的能测**的事：
 *
 *   1. 任务表吞吐：N 个任务建表 + 状态流转 + 落盘需要多久
 *   2. 幂等去重成本：重复事件（webhook 重投的常态）会不会拖慢
 *   3. 并发调度：不同 maxConcurrent 下 N 个任务的完成时间
 *
 * 不测的（诚实声明）：真实 DSH session 并行、网络延迟、模型响应时间——
 * 这些依赖外部环境，测出来的数字会被误读成系统能力。
 *
 * 用法：
 *   node bench.mjs                默认跑全部
 *   node bench.mjs --json         机器可读输出
 *   node bench.mjs --tasks 500    改样本量
 *
 * 输出：每项的中位数与 P95（单次测量噪声太大，不报单次值）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from './router.mjs';
import { load, save, create, transition } from './task-registry.mjs';

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const TASKS = Number(
  args[args.indexOf('--tasks') + 1]
  || 200,
);

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
}

/** 重复测量取中位数与 P95：单次结果受 GC 和调度抖动影响，不可信。 */
function measure(fn, rounds = 5) {
  const samples = [];
  for (let i = 0; i < rounds; i += 1) {
    const start = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);   // ms
  }
  samples.sort((a, b) => a - b);
  return {
    median: Number(samples[Math.floor(samples.length / 2)].toFixed(1)),
    p95: Number(samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))].toFixed(1)),
    min: Number(samples[0].toFixed(1)),
    rounds,
  };
}

/** 1. 建表 + 状态流转 + 落盘 */
function benchTaskLifecycle(n) {
  return measure(() => {
    const dir = tmp();
    const state = load(dir);
    for (let i = 0; i < n; i += 1) {
      const { task } = create(state, { source: 'user', eventId: `e${i}`, title: `任务 ${i}` });
      transition(state, task.taskId, 'queued');
      transition(state, task.taskId, 'running');
    }
    save(state, dir);
  });
}

/** 2. 纯内存建表（不含落盘），用来分离磁盘成本 */
function benchTaskMemoryOnly(n) {
  return measure(() => {
    const state = load(tmp());
    for (let i = 0; i < n; i += 1) {
      create(state, { source: 'user', eventId: `e${i}`, title: `任务 ${i}` });
    }
  });
}

/** 3. 幂等去重：全部是重复事件时的成本 */
function benchIdempotentDuplicates(n) {
  return measure(() => {
    const state = load(tmp());
    for (let i = 0; i < n; i += 1) {
      create(state, { source: 'webhook', eventId: 'same-event', title: '重投' });
    }
  });
}

/**
 * 4. 并发调度：不同并发上限下跑完 n 个任务。
 * @param taskMs 每个任务体的耗时（默认 5ms，模拟一次工具调用）。
 *               传 0 得到"调度底噪"——没有它就无法区分「并行生效」和「IO 开销占大头」。
 */
async function benchConcurrency(n, maxConcurrent, taskMs = 5) {
  const rounds = 3;
  const samples = [];
  for (let r = 0; r < rounds; r += 1) {
    const router = new Router({
      dataDir: tmp(),
      maxConcurrent,
      runTask: async () => { if (taskMs > 0) await new Promise((res) => setTimeout(res, taskMs)); return { ok: true }; },
    });
    for (let i = 0; i < n; i += 1) router.accept({ source: 'user', eventId: `c${i}`, title: `任务 ${i}` });
    const start = process.hrtime.bigint();
    await router.execute();
    // 等所有任务落定
    const deadline = Date.now() + 30_000;
    for (;;) {
      const running = Object.values(router.state().tasks).filter(
        (t) => t.status === 'running' || t.status === 'queued',
      ).length;
      if (running === 0 || Date.now() > deadline) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return { median: Number(samples[Math.floor(samples.length / 2)].toFixed(1)), rounds };
}

async function main() {
  const results = {};

  results['任务生命周期（含落盘）'] = { ...benchTaskLifecycle(TASKS), n: TASKS, unit: 'ms' };
  results['任务建表（纯内存）'] = { ...benchTaskMemoryOnly(TASKS), n: TASKS, unit: 'ms' };
  results['幂等去重（全重复）'] = { ...benchIdempotentDuplicates(TASKS), n: TASKS, unit: 'ms' };
  // 对照组：任务体**完全不做事**，只测「20 次状态落盘 + 调度」的固定成本。
  // 没有这个对照，看到「并发 4 比并发 1 快 2 倍」会误以为是并行生效——
  // 实测任务的 5ms 延迟在总耗时里只占很小一部分，大头是每次 transition 的同步写盘。
  results['调度底噪（任务零耗时）'] = { ...(await benchConcurrency(20, 1, 0)), n: 20, unit: 'ms' };
  results['并发调度 1'] = { ...(await benchConcurrency(20, 1)), n: 20, unit: 'ms' };
  results['并发调度 4'] = { ...(await benchConcurrency(20, 4)), n: 20, unit: 'ms' };
  results['并发调度 20'] = { ...(await benchConcurrency(20, 20)), n: 20, unit: 'ms' };

  if (JSON_OUT) {
    console.log(JSON.stringify({ at: new Date().toISOString(), tasks: TASKS, results }, null, 2));
    return;
  }

  console.log(`\n基准测量 · ${TASKS} 个任务 · ${new Date().toISOString().slice(0, 19)}\n`);
  console.log('项目'.padEnd(24), '中位数'.padStart(10), 'P95'.padStart(10), '单任务'.padStart(12));
  console.log('-'.repeat(60));
  for (const [name, r] of Object.entries(results)) {
    const per = r.n ? (r.median / r.n * 1000).toFixed(1) + ' µs' : '';
    console.log(
      name.padEnd(24),
      String(r.median + ' ms').padStart(10),
      String((r.p95 ?? r.median) + ' ms').padStart(10),
      per.padStart(12),
    );
  }
  console.log('\n注意：这只测本进程的文件 IO 与调度开销。');
  console.log('真实 DSH session 并发、网络与模型耗时不在其中，不能用它宣称端到端性能。');
}

main().catch((error) => {
  console.error('基准失败:', error);
  process.exit(1);
});
