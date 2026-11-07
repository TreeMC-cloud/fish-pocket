#!/usr/bin/env node
/**
 * 场景身份注入 —— 让 Agent 开场就知道「我在哪个场景、我负责什么」。
 *
 * 一位实践者的原话：
 *   「不是因为把会话命名成场景名，就自动按场景输出东西。会话开场第一件事
 *     是先认身份——拿自己的会话 ID 去对场景表，对号入座。这不是什么神奇的
 *     自启动，是一条写进每轮必读宪法里的规矩。」
 *
 * 所以这里做的事就是「把身份写进每轮必读的地方」：读工作区的 .scene.json，
 * 生成一段简短的身份说明，追加到 $DSH_HOME/AGENTS.md 的场景段里。
 * 引擎每轮都会注入 AGENTS.md，Agent 就永远知道自己是谁。
 *
 * 用法：
 *   scene.mjs sync  [工作区目录]   生成/刷新场景身份段
 *   scene.mjs init  [目录]         建一个 .scene.json 模板
 *   scene.mjs show  [目录]         看当前场景配置
 *   scene.mjs list                 列出所有工作区的场景
 *
 * 退出码：0 成功 / 1 没有场景配置 / 2 用法错误
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARK_START = '<!-- SCENE:BEGIN -->';
const MARK_END = '<!-- SCENE:END -->';
// 偏好段单独一对标记：它跨场景共用，和场景身份的生命周期不同——
// 场景换了要重写场景段，但偏好不该跟着重写（那样会丢用户刚加的）。
const PREF_START = '<!-- PREFS:BEGIN -->';
const PREF_END = '<!-- PREFS:END -->';

// 空跑开关：默认只打印计划，加 --go 才真执行。
const GO = process.argv.includes('--go');

function fail(msg) {
  console.error(`错误：${msg}`);
  process.exit(2);
}

/** AGENTS.md 在哪：引擎每轮注入的就是这个文件。 */
function agentsFile() {
  const home = process.env.DSH_HOME;
  if (home) return path.join(home, 'AGENTS.md');
  // 兜底：iOS 上是 $DSH_IOS_DATA/dsh/AGENTS.md
  const data = process.env.DSH_IOS_DATA;
  if (data) return path.join(data, 'dsh', 'AGENTS.md');
  return path.join(os.homedir(), '.dsh', 'AGENTS.md');
}

function readScene(dir) {
  const f = path.join(dir, '.scene.json');
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    return { __error: e.message };
  }
}

/** 把场景渲染成一段注入文本。 */
function render(scene, dir) {
  const lines = [];
  lines.push(MARK_START);
  lines.push('## 当前场景');
  lines.push('');
  lines.push(`你在 **${scene.name || path.basename(dir)}** 这个场景里。`);
  lines.push('');

  // 地盘：具体到路径，说清"我拥有哪些目录"。
  // 缺这一层的后果：和别人抢同一个文件，或者该改的不敢改。
  if (Array.isArray(scene.territory) && scene.territory.length) {
    lines.push('**你拥有这些路径：**');
    for (const t of scene.territory) lines.push(`- \`${t}\``);
    lines.push('');
  }

  if (Array.isArray(scene.duty) && scene.duty.length) {
    lines.push('**你负责：**');
    for (const d of scene.duty) lines.push(`- ${d}`);
    lines.push('');
  }

  if (Array.isArray(scene.avoid) && scene.avoid.length) {
    lines.push('**你不碰：**');
    for (const d of scene.avoid) lines.push(`- ${d}`);
    lines.push('');
    lines.push('上面这几条不做。用户要求你做的时候，先说一句「这属于 X 场景的范围」，让他确认。');
    lines.push('');
  }

  if (scene.skill) {
    lines.push(`专属技能：\`${scene.skill}\``);
    lines.push('');
  }

  lines.push(`工作目录：\`${dir}\``);
  lines.push('');
  lines.push('**开场先确认身份**：如果这是新会话，先读一遍 `HANDOFF.md` 看上次做到哪。');
  lines.push(MARK_END);

  // 偏好：跨场景共用，从 preferences.json 读。
  // 读不到就跳过（用户还没记过偏好是常态，不能因此报错）。
  try {
    const prefsFile = process.env.DSH_HOME
      ? path.join(process.env.DSH_HOME, 'preferences.json')
      : (process.env.DSH_IOS_DATA ? path.join(process.env.DSH_IOS_DATA, 'dsh', 'preferences.json') : null);
    if (prefsFile && fs.existsSync(prefsFile)) {
      const prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
      if (Array.isArray(prefs) && prefs.length) {
        const LABELS = { interaction: '交互', tool: '工具', file: '文件',
                         writing: '写作', safety: '安全', memory: '记忆' };
        const byKind = {};
        for (const p of prefs) (byKind[p.kind] ||= []).push(p.text);
        const body = [];
        for (const [k, label] of Object.entries(LABELS)) {
          if (byKind[k]?.length) body.push(`- ${label}：${byKind[k].join('；')}`);
        }
        if (body.length) {
          lines.push('');
          lines.push(PREF_START);
          lines.push('## 你的偏好');
          lines.push('');
          lines.push(...body);
          lines.push(PREF_END);
        }
      }
    }
  } catch {
    // 偏好文件坏了不该让场景注入失败——那是两件事。
  }

  return lines.join('\n');
}

function writeInto(file, block) {
  let text = '';
  if (fs.existsSync(file)) {
    text = fs.readFileSync(file, 'utf8');
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  // 已有段就替换，没有就追加。不做"先删后加"的粗暴操作：
  // 用户可能在标记之外还写了别的东西。
  const replaceBlock = (src, start, end, newBlock) => {
    const i = src.indexOf(start);
    const j = src.indexOf(end);
    if (i >= 0 && j > i) {
      return src.slice(0, i) + newBlock + src.slice(j + end.length);
    }
    return null;
  };

  // 场景段和偏好段分开替换：偏好段在 block 里但标记不同，
  // 一起替换会出问题（两次 sync 之间用户可能只改了偏好）。
  const scenePart = block.includes(PREF_START) ? block.slice(0, block.indexOf(PREF_START)) : block;
  const prefPart = block.includes(PREF_START) ? block.slice(block.indexOf(PREF_START)) : '';

  let out = replaceBlock(text, MARK_START, MARK_END, scenePart.trimEnd());
  if (out === null) {
    const sep = text && !text.endsWith('\n') ? '\n\n' : (text ? '\n' : '');
    out = text + sep + scenePart.trimEnd() + '\n';
  }
  if (prefPart) {
    const withPref = replaceBlock(out, PREF_START, PREF_END, prefPart.trimEnd());
    out = withPref === null ? out.trimEnd() + '\n\n' + prefPart.trimEnd() + '\n' : withPref;
  }
  // 空跑：场景身份会进每轮注入的 AGENTS.md，写错影响所有后续对话。
  if (!GO) { console.log('   [空跑] 将写入 ' + file); console.log('   加 --go 才会真执行。'); return; }
  fs.writeFileSync(file, out, 'utf8');
}

const argv = process.argv.slice(2).filter(a => a !== '--go');
const cmd = argv[0];

if (!cmd || cmd === 'help') {
  console.log(`用法：
  scene.mjs init   [目录]     建 .scene.json 模板
  scene.mjs sync   [目录]     把场景身份写进 AGENTS.md
  scene.mjs show   [目录]     看当前场景
  scene.mjs list              列出所有场景`);
  process.exit(2);
}

const dir = path.resolve(argv[1] && !argv[1].startsWith('-') ? argv[1] : process.cwd());

if (cmd === 'init') {
  const f = path.join(dir, '.scene.json');
  if (fs.existsSync(f)) {
    console.log(`已有场景配置：${f}`);
    process.exit(0);
  }
  const template = {
    name: path.basename(dir),
    duty: ['（这个场景负责什么？写可执行的动作，不要写"管理"这种空话）'],
    territory: ['（你拥有哪些路径？写到目录级，例如 src/ 、docs/）'],
    avoid: ['（明确不碰什么？这条最重要，边界靠它）'],
    skill: '',
  };
  fs.writeFileSync(f, JSON.stringify(template, null, 2) + '\n', 'utf8');
  console.log(`已创建 ${f}`);
  console.log('填好 duty 和 avoid 之后跑：scene.mjs sync');
  process.exit(0);
}

if (cmd === 'show') {
  const scene = readScene(dir);
  if (!scene) {
    console.error(`这个目录没有场景配置：${dir}`);
    process.exit(1);
  }
  if (scene.__error) fail(`.scene.json 解析失败：${scene.__error}`);
  console.log(JSON.stringify(scene, null, 2));
  process.exit(0);
}

if (cmd === 'list') {
  // 找 $DSH_HOME/workspaces 或 $DSH_IOS_DATA 下的工作区
  const roots = [];
  if (process.env.DSH_IOS_DATA) roots.push(path.join(process.env.DSH_IOS_DATA, 'workspace'));
  if (process.env.DSH_HOME) roots.push(path.join(process.env.DSH_HOME, '..', 'workspace'));
  roots.push(process.cwd());

  let found = 0;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const d = path.join(root, name);
      if (!fs.statSync(d).isDirectory()) continue;
      const scene = readScene(d);
      if (scene) {
        console.log(`  ${name.padEnd(24)} ${scene.name || '(无名)'}`);
        found += 1;
      }
    }
  }
  if (!found) console.log('（没找到带 .scene.json 的目录）');
  process.exit(found ? 0 : 1);
}

if (cmd === 'sync') {
  const scene = readScene(dir);
  if (!scene) {
    console.error(`这个目录没有场景配置：${dir}`);
    console.error('先跑：scene.mjs init ' + dir);
    process.exit(1);
  }
  if (scene.__error) fail(`.scene.json 解析失败：${scene.__error}`);

  const target = agentsFile();
  const block = render(scene, dir);
  writeInto(target, block);

  console.log(`✓ 场景身份已写入 ${target}`);
  console.log(`  场景：${scene.name}`);
  console.log(`  负责：${(scene.duty || []).length} 条`);
  console.log(`  不碰：${(scene.avoid || []).length} 条`);
  if (scene.territory) console.log(`  地盘：${scene.territory.length} 条路径`);
  console.log('');
  console.log('下次会话开始时，这段会自动出现在 Agent 每轮读到的内容里。');
  process.exit(0);
}

fail(`不认识的命令「${cmd}」。跑 scene.mjs help`);
