#!/usr/bin/env node
/**
 * 场景面板 —— 一个场景该长什么样，用 JSON 描述。
 *
 * 为什么需要这个：
 *   现在的界面是写死的（51 个 SwiftUI 文件），改一次要重新编译。
 *   但 App 里已经有 GenUIView —— 它能从 JSON 渲染界面。
 *   所以「这个场景显示什么」可以变成数据，不用改代码。
 *
 * 和别人的差别：
 *   他把 24 种面板类型写进场景配置，每个面板指向一个渲染器。
 *   我们是反过来：场景配置只描述「要显示什么数据」，
 *   具体长什么样由 GenUI 的组件树决定。
 *   少了一层注册表，但换来「不用改代码就能调界面」。
 *
 * 用法：
 *   node panel.mjs show                     看当前场景的面板配置
 *   node panel.mjs init [--template dev]    生成面板配置（默认空跑）
 *   node panel.mjs init --template dev --go
 *   node panel.mjs render                   输出 GenUI 的 JSON（给 App 用）
 *
 * 退出码：0 正常 / 1 有问题 / 2 用法错误
 */

import fs from 'node:fs';
import path from 'node:path';

const GO = process.argv.includes('--go');
const argv = process.argv.slice(2).filter((a) => a !== '--go');

// 面板模板：每种场景该看什么。
//
// 为什么按场景分而不是按类型分：
//   面板类型（网页/文件/预览）是"怎么显示"，
//   场景决定的是"看什么数据"。
//   同一个"文件列表"组件，在开发场景看 src/，在写作场景看 docs/。
const TEMPLATES = {
  dev: {
    name: '程序开发',
    panels: [
      { id: 'status', title: '项目状态', kind: 'kv', source: 'git status --short' },
      { id: 'todos', title: '待办', kind: 'list', source: 'shared.mjs board' },
      { id: 'checks', title: '体检结果', kind: 'status', source: 'selfaudit.mjs' },
      { id: 'recent', title: '最近改动', kind: 'list', source: 'git log --oneline -5' },
    ],
  },
  writing: {
    name: '写作',
    panels: [
      { id: 'todos', title: '待办', kind: 'list', source: 'shared.mjs board' },
      { id: 'docs', title: '文档', kind: 'list', source: 'ls docs/' },
      { id: 'words', title: '字数', kind: 'kv', source: 'wc -w docs/*.md' },
    ],
  },
  ops: {
    name: '服务器运维',
    panels: [
      { id: 'health', title: '服务状态', kind: 'status', source: 'workbench.mjs probe' },
      { id: 'tasks', title: '远程任务', kind: 'list', source: 'wb_list_tasks' },
      { id: 'todos', title: '待办', kind: 'list', source: 'shared.mjs board' },
    ],
  },
  minimal: {
    name: '最小场景',
    panels: [
      { id: 'todos', title: '待办', kind: 'list', source: 'shared.mjs board' },
    ],
  },
};

function usage() {
  console.error(`场景面板

用法：
  panel.mjs show                          看当前配置
  panel.mjs init --template <名>          生成配置（默认空跑）
  panel.mjs init --template <名> --go     真写入
  panel.mjs render                        输出 GenUI JSON

模板：
${Object.entries(TEMPLATES).map(([k, v]) => `  ${k.padEnd(10)} ${v.name}（${v.panels.length} 个面板）`).join('\n')}

退出码：0 正常 / 1 有问题 / 2 用法错误`);
  process.exit(2);
}

// 面板配置放在场景目录里，跟 .scene.json 并列。
// 为什么不塞进 .scene.json：那是"我是谁"，这是"我看什么"。
// 两者的修改频率和修改人都不同（身份很少改，面板常调）。
const PANEL_FILE = 'panels.json';

function sceneDir() {
  const dir = argv[1] && !argv[1].startsWith('--') ? argv[1] : process.cwd();
  return path.resolve(dir);
}

function show() {
  const dir = sceneDir();
  const f = path.join(dir, PANEL_FILE);
  console.log('场景面板\n');
  console.log(`  场景目录：${dir}`);
  if (!fs.existsSync(f)) {
    console.log(`  ${PANEL_FILE}：不存在（用 panel.mjs init --template <名> 生成）`);
    console.log('\n  可选模板：' + Object.keys(TEMPLATES).join(' / '));
    process.exit(0);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.error(`  ✗ ${PANEL_FILE} 解析失败：${e.message}`);
    process.exit(1);
  }
  console.log(`  场景：${cfg.name || '（未命名）'}`);
  console.log(`  面板 ${cfg.panels?.length || 0} 个：\n`);
  for (const p of cfg.panels || []) {
    console.log(`    ${p.id.padEnd(10)} ${p.title.padEnd(12)} [${p.kind}] ← ${p.source}`);
  }
  process.exit(0);
}

function init(opts) {
  const tpl = opts.template || 'minimal';
  const t = TEMPLATES[tpl];
  if (!t) {
    console.error(`✗ 没有这个模板：${tpl}`);
    console.error('  可选：' + Object.keys(TEMPLATES).join(' / '));
    process.exit(2);
  }

  const dir = sceneDir();
  const f = path.join(dir, PANEL_FILE);
  const cfg = {
    name: t.name,
    template: tpl,
    panels: t.panels,
    // 生成时间戳：方便判断这份配置有多旧
    generatedAt: new Date().toISOString(),
  };

  console.log(`场景面板 —— 生成 ${tpl}（${t.name}）\n`);
  console.log(`  目标：${f}`);
  console.log(`  面板 ${t.panels.length} 个：`);
  for (const p of t.panels) console.log(`    ${p.title} ← ${p.source}`);

  if (!GO) {
    console.log('\n   [空跑] 没有写入。加 --go 才真执行。');
    process.exit(0);
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log(`\n✓ 已写入 ${f}`);
  console.log(`  改面板只要编辑这个文件，不用重新编译 App。`);
  process.exit(0);
}

// render：把 panels.json 转成 GenUIView 能吃的 JSON 树。
//
// 这是关键的一步——App 侧的 GenUIView 认 componentsName/props 结构，
// 所以这里要把「面板配置」翻译成「组件树」。
function render() {
  const dir = sceneDir();
  const f = path.join(dir, PANEL_FILE);
  if (!fs.existsSync(f)) {
    console.error(`✗ ${PANEL_FILE} 不存在：先跑 panel.mjs init --template <名>`);
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.error(`✗ 解析失败：${e.message}`);
    process.exit(1);
  }

  // 组装成 GenUI 的 Page → 多个 TinyCard
  const tree = {
    componentName: 'Page',
    props: { title: cfg.name || '场景' },
    children: (cfg.panels || []).map((p) => ({
      componentName: 'TinyCard',
      props: { title: p.title },
      children: [
        // kind 决定用什么组件显示
        ...(p.kind === 'kv'
          ? [{ componentName: 'Text', props: { text: `来源：${p.source}` } }]
          : p.kind === 'status'
            ? [{ componentName: 'Text', props: { text: `检查：${p.source}` } }]
            : [{ componentName: 'Text', props: { text: `列表：${p.source}` } }]),
      ],
    })),
  };

  // 输出纯 JSON，可以直接喂给 GenUIView.parse()
  process.stdout.write(JSON.stringify(tree, null, 2) + '\n');
  process.exit(0);
}

// ---------- 入口 ----------
const cmd = argv[0];
if (!cmd || cmd === '--help' || cmd === '-h') usage();

if (cmd === 'show') show();
if (cmd === 'render') render();

if (cmd === 'init') {
  const opts = {};
  // argv 里第一个非 -- 开头的可能是场景目录
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--template') opts.template = argv[++i];
    else if (!a.startsWith('--') && !opts._dir) opts._dir = a;
    else if (a.startsWith('--')) {
      console.error(`✗ 不认识的参数：${a}`);
      usage();
    }
  }
  init(opts);
}

console.error(`✗ 不认识的命令：${cmd}`);
usage();
