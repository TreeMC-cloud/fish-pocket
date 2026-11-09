import test from 'node:test';
import assert from 'node:assert/strict';
import { verdict } from '../skills/cost-guard/load-gate.mjs';

/**
 * 负载闸的判据必须能被稳定测试，否则「90% 不许派单」只是文档里一句话。
 * verdict() 是纯函数，边界值逐个钉死。
 */
test('90 / 95 两条线的边界', () => {
  const at = (cpu, mem) => verdict({ cpu, mem }).exit;

  assert.equal(at(10, 10), 0, '低负载应放行');
  assert.equal(at(89.9, 10), 0, '89.9 还没到线');
  assert.equal(at(90, 10), 10, '正好 90 应停派单（≥ 不是 >）');
  assert.equal(at(10, 90), 10);
  assert.equal(at(94.9, 10), 10, '94.9 仍是停派单');
  assert.equal(at(95, 10), 20, '95 应升到停重活');
  assert.equal(at(10, 99), 20);
});

test('任一超线就拦，不看另一项', () => {
  assert.equal(verdict({ cpu: 5, mem: 96 }).exit, 20, 'CPU 低但内存爆了也要拦');
  assert.equal(verdict({ cpu: 96, mem: 5 }).exit, 20, '内存低但 CPU 爆了也要拦');
});

test('量不了时返回 3，不能当成可以通过', () => {
  assert.equal(verdict(null).exit, 3);
  assert.equal(verdict({ cpu: null, mem: 10 }).exit, 3);
  // 关键：3 必须不是 0 —— 调用方一律当「别派」处理
  assert.notEqual(verdict(null).exit, 0);
});

test('标签与退出码一一对应', () => {
  assert.equal(verdict({ cpu: 1, mem: 1 }).label, '✓ 可派单');
  assert.equal(verdict({ cpu: 91, mem: 1 }).label, '⚠ 停止派单');
  assert.equal(verdict({ cpu: 99, mem: 1 }).label, '⛔ 停重活');
});

test('内存读的是真实可用量，不是内核 MemFree', async () => {
  const { sample } = await import('../skills/cost-guard/load-gate.mjs');
  const s = await sample();
  assert.ok(s, '应该能采样到数据');
  // 这里**不**断言 source 具体是哪个：iSH 上 /proc/meminfo 没有 MemAvailable，
  // 必须退回 os.freemem；Linux 上有 MemAvailable；macOS 没有 /proc 也走 freemem。
  // 断言实现路径会把测试绑死在某个平台上——CI（Ubuntu/macOS runner）和
  // 本地（iSH）走的不是同一条分支，写死 source 就成了「只在本地绿」的假测试。
  // 真正要守的是**结果**：拿到的可用量得是真实可用量，不是内核空闲页。
  assert.ok(['MemAvailable', 'os.freemem'].includes(s.source),
    `可用量的来源不可信：${s.source}`);
  // 回归：MemFree 只有 ~64MB，若拿它当可用，会算出 97% 这种假警报。
  // 真实可用应该在总内存的 30% 以上——留足余量，不写死具体值。
  assert.ok(s.freeMB > s.totalMB * 0.3,
    `可用内存 ${s.freeMB}MB / ${s.totalMB}MB 偏低，怀疑又退回了 MemFree`);
});
