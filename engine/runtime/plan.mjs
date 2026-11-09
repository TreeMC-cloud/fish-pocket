// plan.mjs —— 把计划写进文件，而不是只存在上下文里
//
// ## 为什么需要
//
// 复杂任务（改 5 个文件那种）全靠模型在脑子里记。一旦上下文被压缩、
// 或者引擎重启，计划就没了——它只能从头再想一遍，或者干脆跑偏。
//
// 写进 `<工作区>/.plan.md` 之后：
//   · 压缩前后都能读回来
//   · 重启后知道做到第几步（断点续跑的基础）
//   · 用户能直接看见它打算怎么做
//
// ## 格式刻意简单
//
// 只用两种行：
//   - [ ] 待做
//   - [x] 做完
// 不引入额外语法。解析器认不出的行一律忽略——**写得随意也能用**，
// 比要求严格格式然后模型不遵守要好。
//
// ## 为什么不让它自动生成计划文件
//
// 只有多步骤任务才值得写。一句话能说清的事也去开个文件，
// 用户会觉得啰嗦，而且计划文件本身会变成噪音。

import fs from 'node:fs';
import path from 'node:path';

export const PLAN_FILE = '.plan.md';

/** 计划文件的位置：跟着会话的工作区，不是数据目录。 */
export function planPath(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return null;
  return path.join(cwd, PLAN_FILE);
}

/**
 * 解析计划文件。
 *
 * @returns {{total:number, done:number, next:string|null, items:Array<{text:string, done:boolean}>}|null}
 *   null 表示没有计划文件（不是错误）
 */
export function parsePlan(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return null;
  const items = [];
  for (const line of markdown.split('\n')) {
    // 允许前置空格和 `*`/`-` 两种列表符号；`[ ]` 与 `[x]` 都认，大小写不敏感。
    const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/);
    if (!m) continue;
    const text = m[2].replace(/\s+/g, ' ').trim();
    if (!text) continue;
    items.push({ text, done: m[1].toLowerCase() === 'x' });
  }
  if (items.length === 0) return null;
  const done = items.filter((i) => i.done).length;
  const next = items.find((i) => !i.done)?.text ?? null;
  return { total: items.length, done, next, items };
}

/** 读并解析；文件不存在或读不了都返回 null。 */
export function readPlan(cwd) {
  const file = planPath(cwd);
  if (!file) return null;
  try {
    return parsePlan(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 给模型的一句话：现在计划到哪了。
 *
 * 放在 turn/start 时注入比放在系统提示里好——系统提示是静态的，
 * 而计划会变。
 */
export function describeProgress(plan) {
  if (!plan) return null;
  if (plan.total === 0) return null;
  const head = `计划进度 ${plan.done}/${plan.total}`;
  return plan.next ? `${head}，下一步：${plan.next}` : `${head}，全部完成`;
}

/** 写进 plan-view.json 的形状（给 App 读）。 */
export function toView(plan, { now = Date.now(), cwd = null } = {}) {
  if (!plan) return { at: now, ok: false, reason: '没有计划文件', total: 0, done: 0, next: null, cwd };
  return {
    at: now,
    ok: true,
    cwd,
    total: plan.total,
    done: plan.done,
    next: plan.next,
    items: plan.items.slice(0, 20),
  };
}
