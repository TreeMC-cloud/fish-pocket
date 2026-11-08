// delivery-gate.mjs —— 任务「算不算做完」的判据
//
// 为什么需要：Router 现在只要 runTask 返回 ok:true 就记 succeeded。但 ok:true 只是
// 「脚本没抛异常」，不是「东西真的出来了」。模型说「已构建完成」，产物目录却是空的；
// 说「已下载」，文件 0 字节——这类假成功最坑：用户以为好了，几小时后才发现什么都没有。
//
// 抄的是 Blender 插件的 gate 思路：交付前有明确判据，不通过就**阻止交付**，
// 而不是给个警告继续走。警告会被忽略，阻止不会。
//
// 判据分两级：
//   硬判据（判死）：产物应该存在的形态事实。-- 文件存在、非空、能解析
//   软判据（只记录）：数量、关键词覆盖等。进 notes，不拦

import fs from 'node:fs';
import path from 'node:path';

/**
 * 单个产物的硬检查。返回 {ok, reason}
 *
 * 支持 `path` 或 `content` 两种产物描述：
 *   {path: '/a/b.json'}         → 检查磁盘上的文件
 *   {content: '...', name:'x'}  → 检查内存里的内容（不落盘的任务）
 */
export function checkArtifact(artifact, { cwd = process.cwd() } = {}) {
  if (!artifact || typeof artifact !== 'object') {
    return { ok: false, reason: '产物描述不是对象' };
  }

  // 内存产物
  if (typeof artifact.content === 'string') {
    if (artifact.content.trim() === '') {
      return { ok: false, reason: `产物 ${artifact.name ?? '(未命名)'} 内容为空` };
    }
    return { ok: true };
  }

  const target = artifact.path;
  if (typeof target !== 'string' || !target.trim()) {
    return { ok: false, reason: '产物既没有 path 也没有 content' };
  }
  const full = path.isAbsolute(target) ? target : path.resolve(cwd, target);

  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return { ok: false, reason: `产物不存在：${target}` };
  }
  if (stat.isDirectory()) {
    // 目录算合格，但空目录不算——「构建输出目录存在但里面什么都没有」是典型假成功
    try {
      const entries = fs.readdirSync(full);
      if (entries.length === 0) return { ok: false, reason: `产物目录是空的：${target}` };
    } catch {
      return { ok: false, reason: `产物目录读不了：${target}` };
    }
    return { ok: true };
  }
  if (stat.size === 0) {
    return { ok: false, reason: `产物是 0 字节：${target}` };
  }

  // 结构化文件：能解析才算合格（截断的 JSON 是常见的半成品）
  const ext = path.extname(full).toLowerCase();
  if (ext === '.json') {
    try {
      JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      return { ok: false, reason: `产物不是合法 JSON：${target}` };
    }
  }
  return { ok: true };
}

/**
 * 判定一个任务能否交付。
 *
 * @param {object} task  任务对象（含 artifacts、expect 等）
 * @param {object} outcome runTask 的返回值
 * @param {object} [options] cwd / requireArtifacts
 * @returns {{pass: boolean, blockers: string[], notes: string[]}}
 */
export function gate(task, outcome, { cwd = process.cwd(), requireArtifacts = false } = {}) {
  const blockers = [];
  const notes = [];

  if (!outcome || typeof outcome !== 'object') {
    return { pass: false, blockers: ['执行结果不是对象'], notes };
  }
  const ok = outcome.ok === true;
  if (!ok) {
    // 失败任务不走 gate：它本来就该进 needs_reconciliation
    return { pass: false, blockers: [`执行返回失败：${String(outcome.error ?? '未说明')}`], notes };
  }

  const artifacts = Array.isArray(outcome.artifacts) ? outcome.artifacts : [];

  // 任务声明了要交产物，就一个都不能缺
  const expectsArtifacts = requireArtifacts || task?.expect?.artifacts === true;
  if (expectsArtifacts && artifacts.length === 0) {
    blockers.push('任务要求交付产物，但一个都没有');
  }

  // 每个产物都必须过硬判据
  for (const [index, artifact] of artifacts.entries()) {
    const result = checkArtifact(artifact, { cwd });
    if (!result.ok) blockers.push(`产物 #${index + 1}：${result.reason}`);
  }

  // 软判据：只记不拦
  if (Number.isInteger(task?.expect?.minArtifacts) && artifacts.length < task.expect.minArtifacts) {
    notes.push(`产物数量 ${artifacts.length} < 期望 ${task.expect.minArtifacts}`);
  }
  if (outcome.checkpoint) notes.push(`检查点：${String(outcome.checkpoint).slice(0, 60)}`);

  return { pass: blockers.length === 0, blockers, notes };
}
