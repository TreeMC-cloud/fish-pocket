// skill-registry.mjs —— 技能的版本、依赖、权限、生命周期
//
// 为什么需要：现在技能就是一堆 SKILL.md，谁写的、哪个版本、依赖什么、
// 有多大权限，全是空白。等到有几十个技能、其中一半是 evolve 自动提炼的，
// 就会出现这些问题：
//   - 两个技能说法冲突，不知道哪个新
//   - 某技能依赖的工具被裁掉了，加载后一用就报错
//   - 自动生成的技能悄悄改了行为，没人知道它什么时候进来的
//   - 出问题时不知道该退回到哪个版本
//
// Phase 4 的要求是「版本、依赖、权限、测试、适用场景标签」。
// 这个模块只做**元数据与校验**，不做执行——执行还是走 skill 工具。

import fs from 'node:fs';
import path from 'node:path';

/** 技能来源。决定信任级别：手写的可以放心用，自动提炼的要更严。 */
export const SOURCE = {
  HANDWRITTEN: 'handwritten',   // 人写的，随 App 发布
  EVOLVED: 'evolved',           // evolve 从 trace 提炼的
  INSTALLED: 'installed',       // 从 npm / 集市装的
};

/** 权限档。参照工作台的修改权五档，简化成技能能理解的粒度。 */
export const PERMISSION = {
  READ_ONLY: 'read-only',       // 只提供知识，不驱动副作用
  WRITES_FILES: 'writes-files',
  RUNS_COMMANDS: 'runs-commands',
  NETWORK: 'network',
};

/**
 * 校验一个技能的元数据。返回 {ok, errors, warnings}
 *
 * 为什么不抛异常：技能元数据缺失不该让整个加载失败，应该降级成警告，
 * 让人看到「这个技能信息不全」而不是「App 起不来」。
 */
export function validateMeta(meta) {
  const errors = [];
  const warnings = [];

  if (!meta || typeof meta !== 'object') {
    return { ok: false, errors: ['元数据不是对象'], warnings };
  }
  if (typeof meta.name !== 'string' || !meta.name.trim()) errors.push('缺 name');
  if (typeof meta.description !== 'string' || !meta.description.trim()) errors.push('缺 description');

  // version 缺失只警告：存量 18 个技能都没写版本，不能让它们全部失效。
  if (!meta.version) warnings.push('缺 version，按 0.0.0 处理');
  else if (!/^\d+\.\d+\.\d+/.test(meta.version)) errors.push(`version 格式不对：${meta.version}`);

  if (!meta.source) warnings.push('缺 source，按 handwritten 处理');

  // 自动生成的技能必须有溯源：哪次提炼、什么证据。
  // 没有溯源的自动技能等于来路不明，禁止启用。
  if (meta.source === SOURCE.EVOLVED) {
    if (!meta.origin?.traceRun && !meta.origin?.fingerprint) {
      errors.push('evolved 技能缺 origin（traceRun / fingerprint）——来路不明的自动技能不能启用');
    }
    if (meta.verified !== true) {
      warnings.push('evolved 技能未 verified，只能作为候选展示');
    }
  }

  // 权限必须显式声明；默认不给，避免「没写就无限」。
  if (!Array.isArray(meta.permissions) || meta.permissions.length === 0) {
    warnings.push('未声明 permissions，按 read-only 处理');
  } else {
    const valid = Object.values(PERMISSION);
    for (const p of meta.permissions) {
      if (!valid.includes(p)) errors.push(`未知权限：${p}`);
    }
  }

  if (meta.dependsOn && !Array.isArray(meta.dependsOn)) errors.push('dependsOn 必须是数组');

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 依赖解析：检查 dependsOn 里的技能/工具是否都在。
 *
 * 只报缺失，不做自动安装——技能依赖被裁掉的包是构建问题，
 * 不该在运行时偷偷补装（iOS 上也装不了）。
 */
export function resolveDependencies(meta, { availableSkills = [], availableTools = [] } = {}) {
  const missing = [];
  for (const dep of meta?.dependsOn ?? []) {
    const [kind, name] = String(dep).includes(':')
      ? String(dep).split(':', 2)
      : ['skill', String(dep)];
    if (kind === 'tool' && !availableTools.includes(name)) missing.push(`工具 ${name}`);
    if (kind === 'skill' && !availableSkills.includes(name)) missing.push(`技能 ${name}`);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * 从 SKILL.md 读元数据。frontmatter 是 YAML 子集，这里只解析扁平的 key: value，
 * 不引入 YAML 依赖——技能文件不该复杂到需要完整解析器。
 */
export function readMeta(skillFile) {
  const text = fs.readFileSync(skillFile, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return { name: path.basename(path.dirname(skillFile)) };

  const meta = {};
  let currentKey = null;
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      const [, key, raw] = kv;
      currentKey = key;
      const value = raw.trim();
      if (value === '') meta[key] = null;
      else if (value.startsWith('[') && value.endsWith(']')) {
        meta[key] = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      } else meta[key] = value.replace(/^['"]|['"]$/g, '');
      continue;
    }
    // 列表项：  - item
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item && currentKey) {
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
      meta[currentKey].push(item[1].trim().replace(/^['"]|['"]$/g, ''));
    }
  }
  return meta;
}

/**
 * 扫描一个 skills 目录，返回每个技能的元数据与校验结果。
 * 用于体检：哪些技能缺版本、哪些权限过宽、哪些依赖不在。
 */
export function auditSkills(skillDir, { availableTools = [] } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(skillDir, { withFileTypes: true });
  } catch {
    return { skills: [], error: `读不了目录：${skillDir}` };
  }
  const names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const skills = [];
  for (const name of names) {
    const file = path.join(skillDir, name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    let meta;
    try {
      meta = readMeta(file);
    } catch (error) {
      skills.push({ name, ok: false, errors: [`读不了：${error.message}`], warnings: [] });
      continue;
    }
    const v = validateMeta(meta);
    const deps = resolveDependencies(meta, { availableSkills: names, availableTools });
    skills.push({
      name,
      meta,
      ...v,
      errors: [...v.errors, ...deps.missing.map((m) => `缺依赖：${m}`)],
      ok: v.ok && deps.ok,
    });
  }
  return { skills };
}

/**
 * 技能健康度：基于使用记录判断是否该降级。
 *
 * Phase 4 要求「active 技能失败率升高时自动降级/撤销并通知」。
 * 这里只做判定，不做动作——撤销/降级由调用方决定，避免自动改动。
 *
 * @param {object} stats  {uses, failures}
 * @param {object} opts   minUses=5, failRatio=0.4
 */
export function healthVerdict(stats, { minUses = 5, failRatio = 0.4 } = {}) {
  const uses = Number(stats?.uses) || 0;
  const failures = Number(stats?.failures) || 0;
  if (uses < minUses) {
    return { verdict: 'insufficient-data', reason: `只有 ${uses} 次使用，至少需要 ${minUses} 次` };
  }
  const ratio = failures / uses;
  if (ratio >= failRatio) {
    return {
      verdict: 'degrade',
      reason: `失败率 ${(ratio * 100).toFixed(0)}%（${failures}/${uses}）超过 ${failRatio * 100}%`,
      ratio,
    };
  }
  return { verdict: 'ok', ratio };
}
