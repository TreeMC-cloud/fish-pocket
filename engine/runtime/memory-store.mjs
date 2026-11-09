// memory-store.mjs —— Dream 产出到 meow-memory 的写入适配器
//
// 为什么需要适配层：Dream 产出的是 `{text, tags, successRate}`，而 meow-memory
// 的 `MemoryDb.insert()` 要的是 `{level, content, keywords, project, ...}`。
// 直接让 Dream 知道记忆库的表结构，会把两个模块焊死——将来换记忆实现就要改 Dream。
//
// 设计要点：
//   1. **同步加载**：meow-memory 是 CommonJS 风格的大包，用 createRequire 按需取，
//      不放进顶层 import（纯 Node 环境跑测试时不需要它）。
//   2. **原子不崩**：记忆库坏了（disk I/O error、schema 不匹配）时，
//      不能让 Dream 整体失败——整理有产出，只是没落库，下次可以再试。
//   3. **verified 不进库**：meow-memory 没有 verified 字段，所以把「未验证」
//      写进 content 前缀而不是 meta——检索到消息的人能直接看到它是不是待确认。

import path from 'node:path';
import { createRequire } from 'node:module';
import { extractEntities, mergeKeywords } from './entities.mjs';

/** 记忆库在该工作区下的相对目录，与 ios.patch.yml 的 projectDir 一致。 */
export const MEMORY_DIR = '.dsh-meow';

/**
 * 建一个可注入 Dream 的 store。
 *
 * @param {string} workspace  工作区绝对路径（记忆库放在它下面）
 * @param {object} [options]
 *   dir        记忆子目录，默认 .dsh-meow
 *   project    写入时的项目标签
 *   require_   （测试用）注入假的 meow-memory
 * @returns {{write: Function, close: Function, available: boolean}}
 */
export function createMemoryStore(workspace, { dir = MEMORY_DIR, project = null, require_ = null } = {}) {
  let db = null;
  let loadError = null;
  let lastError = null;

  const load = () => {
    if (db || loadError) return db;
    try {
      const req = require_ ?? createRequire(import.meta.url);
      // 解析到装在本项目里的那份，而不是全局的
      const mod = req('meow-memory');
      db = mod.getDb(workspace, dir);
      return db;
    } catch (error) {
      loadError = error;
      return null;
    }
  };

  return {
    /** 记忆库能不能用。false 时 Dream 仍会跑，只是不落库。 */
    get available() {
      return load() !== null;
    },

    get error() {
      return loadError?.message ?? lastError ?? null;
    },

    /**
     * 写入一条 Dream 产出。
     *
     * 返回 `{id, deduped}` 与 meow-memory 同形；失败返回 null（不抛）。
     * 不抛的理由：单条写失败不该中断整轮整理——其它簇的产出仍然有价值。
     */
    write(skill) {
      const database = load();
      if (!database) return null;
      try {
        // ⚠ 层级必须是 meow-memory 真实的七张表之一：
        //   soul / user / project / fact / lesson / topic / rules
        // 早先写 'procedural' 是错的——那张表不存在，insert 抛错后
        // 被 catch 吞掉，表现为「整理成功但落库 0 条」，非常难查。
        // 技能记忆归 lesson（教训与规则，就是"怎么做"这一层）。
        const prefix = skill.verified === true ? '' : '［未验证］';
        const row = database.insert({
          level: 'lesson',
          title: `技能[${skill.key ?? (skill.tags || []).join('+')}]`,
          content: `${prefix}${skill.text}`,
          // 关键词 = 聚类标签 + 从正文里抽出的实体。
          //
          // 为什么要加实体：标签回答「这件事属于哪个话题」，实体回答
          // 「它涉及哪个文件/模块/错误码」。后者是稳定字符串，用户下次
          // 按路径或错误码找记忆时才搜得到——只靠话题标签基本搜不中。
          keywords: mergeKeywords(skill.tags ?? [], extractEntities(`${skill.text ?? ''} ${skill.key ?? ''}`)),
          importance: 2,              // 技能比一次性事实重要，但还没到人格级
          project: project ?? undefined,
          source_session: 'dream',
        });
        return { id: row?.id, deduped: false };
      } catch (error) {
        // 不静默：写成可查的状态，否则又会出现"落库 0 但不知道为什么"
        lastError = error?.message ?? String(error);
        return null;
      }
    },

    /** 关掉连接。App 退出或测试结束时调，避免句柄泄漏。 */
    close() {
      try { db?.close?.(); } catch { /* 关不掉不影响进程退出 */ }
      db = null;
    },
  };
}

/**
 * 从 env 推断工作区路径。
 *
 * iOS 上工作区固定在 Documents 下；桌面/测试时退回 cwd。
 * 单独抽出来是为了让调用方不用关心平台差异。
 */
export function workspaceFromEnv(env = process.env) {
  return env.DSH_IOS_WORKSPACE
    || env.DSH_WORKSPACE
    || env.DSH_IOS_DATA
    || process.cwd();
}
