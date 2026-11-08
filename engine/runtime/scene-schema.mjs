#!/usr/bin/env node
/**
 * scene-schema.mjs —— 场景的唯一权威定义与机器化解析
 *
 * 为什么需要它：场景原本只是「模型记得先 `cat .scene.json`」的一条规矩。
 * 靠自觉的副作用是：忘了读 → 它以为自己在通用环境里 → 在错的项目上动手，
 * 而且不报错。这一类「能力在、触发无」在这个项目里已经出现过三次
 * （轮次计数、记忆注入、派单催办），所以场景也必须变成机器执行。
 *
 * 本模块定义三件事：
 *   1. Scene 的唯一 schema（字段、类型、默认值、校验）
 *   2. 从「会话 → 工作区 → 场景文件」的解析顺序（resolver）
 *   3. 解析失败时的明确行为：**停下来问**，绝不猜一个项目接着干
 *
 * 与旧代码的关系：skills/scene/scene.mjs 负责把场景渲染进 AGENTS.md（展示层）；
 * 这里负责「定义与解析」（数据层）。两者共用同一个 .scene.json，不产生第二份事实。
 */
import fs from 'node:fs';
import path from 'node:path';

/** schema 版本：字段变化时递增，旧文件按缺省值补齐。 */
export const SCHEMA_VERSION = 1;

/** 允许的字段与类型。未知字段保留但不参与解析（便于手工备注）。 */
const FIELDS = {
  sceneId: 'string',
  identityId: 'string',
  projectId: 'string',
  name: 'string',
  workspaceRoot: 'string',
  projectBriefRef: 'string',
  indexRef: 'string',
  handoffRef: 'string',
  toolProfile: 'string',
  memoryNamespace: 'string',
  policyRef: 'string',
  version: 'number',
};

const REQUIRED = ['sceneId'];

/**
 * 校验并规范化一个场景对象。返回 `{ok, scene, problems}`，**不抛错**——
 * 解析场景是启动路径，抛错会让 App 起不来；有问题就降级并报告。
 */
export function validate(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, scene: null, problems: ['场景文件不是一个对象'] };
  }
  const scene = {};
  for (const [key, type] of Object.entries(FIELDS)) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== type) {
      problems.push(`${key} 应为 ${type}，实际 ${typeof value}`);
      continue;
    }
    scene[key] = type === 'string' ? String(value).trim() : value;
  }
  for (const key of REQUIRED) {
    if (!scene[key]) problems.push(`缺少必填字段 ${key}`);
  }
  // 未登记的字段原样保留：可能是用户自己加的备注，不该被静默丢掉。
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in FIELDS) && value !== undefined) scene[key] = value;
  }
  // 派生默认值：让下游不必到处判空。
  scene.memoryNamespace ??= scene.projectId ? `project:${scene.projectId}` : `scene:${scene.sceneId ?? 'unknown'}`;
  scene.identityId ??= 'fenjue';
  scene.toolProfile ??= 'default';
  scene.version ??= SCHEMA_VERSION;
  return { ok: problems.length === 0, scene, problems };
}

/** 场景文件的标准位置：工作区根下的 .scene.json。 */
export function sceneFile(workspaceRoot) {
  return path.join(workspaceRoot, '.scene.json');
}

export function readScene(workspaceRoot) {
  const file = sceneFile(workspaceRoot);
  if (!fs.existsSync(file)) {
    return { ok: false, scene: null, problems: ['没有 .scene.json'], file, missing: true };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...validate(raw), file };
  } catch (error) {
    return { ok: false, scene: null, problems: [`场景文件不是合法 JSON：${error.message}`], file };
  }
}

/**
 * 解析一个会话该用哪个场景。
 *
 * 顺序（先具体后笼统）：
 *   1. 会话显式绑定的 sceneId（用户选过，最可信）
 *   2. 会话工作区根目录下的 .scene.json
 *   3. 全局默认场景（DSH_DEFAULT_SCENE 环境变量指定的目录）
 *   4. 都没有 → **ambiguous（停下问）**，不猜
 *
 * 关键设计：第 4 条不是失败，是一种明确结果。返回 `{status:'ambiguous'}`，
 * 上层必须显示「未配置场景」并询问用户，而不是退回通用模式继续干活——
 * 那正是「在错的项目上动手」的来源。
 */
export function resolveScene({ session, workspaceRoot, defaultRoot = null } = {}) {
  // 1. 会话显式绑定
  const explicit = session?.sceneId ?? session?.header?.sceneId ?? null;
  if (explicit && workspaceRoot) {
    const result = readScene(workspaceRoot);
    if (result.ok && result.scene.sceneId === explicit) {
      return { status: 'resolved', source: 'session-binding', ...result };
    }
    // 绑定了但文件对不上：这是明确的配置错误，必须报告而不是悄悄降级。
    return {
      status: 'mismatch',
      source: 'session-binding',
      scene: null,
      problems: [`会话绑定场景 ${explicit}，但 ${sceneFile(workspaceRoot)} 里的 sceneId 是 ${result.scene?.sceneId ?? '(无)'}`],
      file: result.file ?? null,
    };
  }

  // 2. 工作区文件
  if (workspaceRoot) {
    const result = readScene(workspaceRoot);
    if (result.ok) return { status: 'resolved', source: 'workspace-file', ...result };
    if (!result.missing) return { status: 'invalid', source: 'workspace-file', ...result };
  }

  // 3. 全局默认
  if (defaultRoot) {
    const result = readScene(defaultRoot);
    if (result.ok) return { status: 'resolved', source: 'default', ...result };
  }

  // 4. 停下问
  return {
    status: 'ambiguous',
    source: 'none',
    scene: null,
    problems: ['没有找到场景配置：会话未绑定、工作区没有 .scene.json、也没有默认场景'],
    file: null,
  };
}

/** 解析结果是否可以直接用于执行（只有 resolved 才算）。 */
export function isRunnable(result) {
  return result?.status === 'resolved' && Boolean(result.scene?.sceneId);
}

/** 一句人话，给 UI 或提醒用。 */
export function describe(result) {
  switch (result?.status) {
    case 'resolved': return `场景：${result.scene.name ?? result.scene.sceneId}（来源：${result.source}）`;
    case 'ambiguous': return '未配置场景：先选一个项目，再开始。';
    case 'mismatch': return `场景配置冲突：${(result.problems ?? []).join('；')}`;
    case 'invalid': return `场景文件有问题：${(result.problems ?? []).join('；')}`;
    default: return '场景状态未知';
  }
}

/**
 * 生成一个可用的最小场景文件内容（供 init 使用）。
 * 只填必填项 + 明显默认值，其余留给用户。
 */
export function scaffold({ sceneId, name = null, projectId = null, workspaceRoot = null } = {}) {
  if (!sceneId) throw new Error('sceneId 必填');
  return {
    sceneId,
    name: name ?? sceneId,
    projectId: projectId ?? sceneId,
    workspaceRoot: workspaceRoot ?? '.',
    version: SCHEMA_VERSION,
  };
}

// ── CLI：方便手工检查，不参与运行时 ──────────────────────────────────

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  const [, , cmd, root] = process.argv;
  const dir = root ?? process.cwd();
  if (cmd === 'check') {
    const result = readScene(dir);
    console.log(describe({ status: result.ok ? 'resolved' : (result.missing ? 'ambiguous' : 'invalid'), ...result }));
    if (!result.ok) { for (const p of result.problems) console.log('  ✗', p); process.exit(1); }
    console.log(JSON.stringify(result.scene, null, 2));
    process.exit(0);
  }
  if (cmd === 'init') {
    const id = path.basename(path.resolve(dir));
    fs.writeFileSync(sceneFile(dir), JSON.stringify(scaffold({ sceneId: id, workspaceRoot: '.' }), null, 2) + '\n');
    console.log(`✓ 已创建 ${sceneFile(dir)}，按需补 name / projectId`);
    process.exit(0);
  }
  console.log('用法: scene-schema.mjs <check|init> [工作区目录]');
  process.exit(2);
}
