#!/usr/bin/env node
/**
 * 规矩体检 —— 把「规矩」变成「机制」。
 *
 * 核心理念来自 luanyujia-workbench：「没有会失败的检查的规矩 = 一句口号。」
 * 规矩写在文档里靠自觉；机制跑在代码里靠机器。一份只有规矩的系统，
 * 三个月后一定退化成「看心情」。
 *
 * 这个工具检查 App 工作环境里几条最容易退化的规矩：
 *
 *   R1 交接文件存在且合格（会话随时会没，进度必须在文件里）
 *   R2 交接体量 ≤4KB（超了就是在写周报，没人会读）
 *   R3 技能索引体量可控（技能太多会撑爆上下文）
 *   R4 项目目录没有堆积的临时文件
 *
 * 用法：
 *   node selfaudit.mjs [工作目录]
 *   node selfaudit.mjs --json [工作目录]
 *   node selfaudit.mjs --no-board [工作目录]   # 只看结果，不写待办
 *   node selfaudit.mjs --json --no-board [工作目录]
 *
 * 退出码：0 全部通过；1 有问题；2 用法错误。
 *
 * 每条检查都遵守五步法：违规可判定 / 判据唯一 / 输出差异集合 /
 * 能证明会失败 / 有去向（失败项列出该做什么）。
 *
 * 但「打印到屏幕」这一步其实还没有去向：下次开工没人记得上次查出什么，
 * 同样的坑会反复踩。所以失败项默认自动写进共享层的待办板，
 * 变成下次一开工就能看见的「还欠着这几件事」。
 * 待办只是提醒，写不进去不该让体检报错——体检的输出和退出码只由八类检查决定。
 * --no-board 用于只想看结果、不想污染待办的场景。
 *
 * 八类检查统一调用 report() 收进 results，这就是可复用的结构化结果：
 * 屏幕输出、退出码、进待办三件事都从同一份 results 推导，避免改坏原检查。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KB = 1024;
const results = [];

function report(id, name, ok, detail, fix) {
  results.push({ id, name, ok, detail, fix });
}

// ---------- R1 / R2 交接文件 ----------
function checkHandoff(dir) {
  const candidates = ['HANDOFF.md', 'handoff.md'].map((n) => path.join(dir, n));
  const file = candidates.find((p) => fs.existsSync(p));

  if (!file) {
    report('R1', '交接文件存在', false,
      '没有找到 HANDOFF.md',
      '多步骤任务需要交接文件才能跨会话续上。写一份，五小节：上次交接/当前项目/变更记录/下一步卡点/关键文件。');
    return;
  }

  const text = fs.readFileSync(file, 'utf8');
  const bytes = Buffer.byteLength(text, 'utf8');

  // 五小节
  const sections = [
    [/^#{2,3}\s*1[)）.、]\s*上次交接/m, '1) 上次交接'],
    [/^#{2,3}\s*2[)）.、]\s*当前项目/m, '2) 当前项目'],
    [/^#{2,3}\s*3[)）.、]\s*变更记录/m, '3) 变更记录'],
    [/^#{2,3}\s*4[)）.、]\s*下一步/m, '4) 下一步 / 卡点'],
    [/^#{2,3}\s*5[)）.、]\s*关键文件/m, '5) 关键文件位置'],
  ];
  const missing = sections.filter(([re]) => !re.test(text)).map(([, n]) => n);

  if (missing.length) {
    report('R1', '交接文件合格', false,
      `缺小节：${missing.join('、')}`,
      '交接只回答四个问题：我是谁 / 干到哪 / 下一步 / 卡在哪。补齐缺的小节。');
    return;
  }

  // 下一步不能虚
  const next = (text.match(/下一步[：:]\s*(.+)/) || [])[1]?.trim() || '';
  const vague = ['继续开发', '继续做', '继续完善', '继续优化', '接着做', '待定', '再说', '暂无'];
  const isVague = !next || (vague.some((v) => next.includes(v)) && next.length < 20);

  if (isVague) {
    report('R1', '交接文件合格', false,
      `「下一步」太虚：${next || '（空）'}`,
      '写不出具体的下一步，说明这轮白干了。要具体到可直接动手，例如"补 src/a.mjs 第 3 个引用错误"。');
  } else {
    report('R1', '交接文件合格', true, `下一步：${next.slice(0, 60)}`);
  }

  // 体量
  if (bytes > 4 * KB) {
    report('R2', '交接体量 ≤4KB', false,
      `${(bytes / KB).toFixed(1)} KB 超红线`,
      '这是在写周报。把旧轮次搬进归档，只留最新一份 + 指针。历史上限 4KB 是有原因的：超了没人读。');
  } else {
    report('R2', '交接体量 ≤4KB', true, `${(bytes / KB).toFixed(1)} KB`);
  }
}

// ---------- R3 项目目录卫生 ----------
function checkTempJunk(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    report('R3', '目录卫生', false, '读不了目录', '确认路径存在且有读权限');
    return;
  }

  const junk = [];
  for (const e of entries) {
    const n = e.name;
    // 常见临时残留：*.bak / *.tmp / *.orig / *~ / .DS_Store / 复制粘贴的 .bak-xxx
    if (/\.(bak|tmp|orig|swp)$/i.test(n) ||
        /\.bak[-.]/i.test(n) ||
        /~$/.test(n) ||
        n === '.DS_Store' ||
        /^untitled/i.test(n) ||
        /^(copy|副本)/i.test(n)) {
      junk.push(n);
    }
  }

  if (junk.length) {
    report('R3', '目录卫生', false,
      `${junk.length} 个临时残留：${junk.slice(0, 8).join(', ')}${junk.length > 8 ? ' …' : ''}`,
      '临时文件和备份不该留在工作目录。要留证据就改名放 evidence/，不要留在入口。');
  } else {
    report('R3', '目录卫生', true, '没有临时残留');
  }
}

// ---------- R4 技能体量 ----------
function checkSkills(dir) {
  // 在 App 环境里是 ../skills，在工作目录里可能不存在——不存在就跳过
  const skillDir = path.join(dir, 'skills');
  if (!fs.existsSync(skillDir)) {
    report('R4', '技能体量', true, '（无 skills 目录，跳过）');
    return;
  }
  const oversized = [];
  for (const name of fs.readdirSync(skillDir)) {
    const f = path.join(skillDir, name, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    const bytes = fs.statSync(f).size;
    // 单篇技能红线 12KB：超了应该拆成主文件 + reference
    if (bytes > 12 * KB) oversized.push(`${name} ${(bytes / KB).toFixed(0)}KB`);
  }
  if (oversized.length) {
    report('R4', '技能体量', false,
      `超 12KB：${oversized.join(', ')}`,
      '拆成"主文件 + reference 子文件"，主文件只留索引与判据。');
  } else {
    report('R4', '技能体量', true, '全部在红线内');
  }
}

// ---------- R5 场景配置 ----------
function checkScene(dir) {
  const f = path.join(dir, '.scene.json');
  if (!fs.existsSync(f)) {
    // 没有场景配置不算错——大多数目录不需要。只在有 HANDOFF 却没场景时提示。
    const hasHandoff = fs.existsSync(path.join(dir, 'HANDOFF.md'));
    if (hasHandoff) {
      report('R5', '场景配置', false,
        '有交接文件但没有 .scene.json',
        '跑 scene.mjs init 建一个，写明这个场景负责什么、不碰什么。否则 Agent 不知道自己是谁。');
    } else {
      report('R5', '场景配置', true, '（无需场景配置）');
    }
    return;
  }
  let scene;
  try {
    scene = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    report('R5', '场景配置', false, `.scene.json 解析失败：${e.message}`,
      '修好 JSON 语法。');
    return;
  }
  const missing = [];
  if (!scene.name) missing.push('name');
  if (!Array.isArray(scene.duty) || !scene.duty.length) missing.push('duty');
  // avoid 是最重要的字段：说不清不碰什么，就说不清边界
  if (!Array.isArray(scene.avoid) || !scene.avoid.length) missing.push('avoid');
  if (missing.length) {
    report('R5', '场景配置', false, `缺字段：${missing.join(', ')}`,
      '尤其 avoid 不能空——说不清「不碰什么」就等于没有边界。');
  } else {
    report('R5', '场景配置', true, `${scene.name}（负责 ${scene.duty.length} 条，不碰 ${scene.avoid.length} 条）`);
  }
}

// ---------- R6 偏好冲突 ----------
function checkPrefs() {
  const home = process.env.DSH_HOME;
  const file = home ? path.join(home, 'preferences.json') : null;
  if (!file || !fs.existsSync(file)) {
    report('R6', '偏好', true, '（未设置偏好）');
    return;
  }
  let prefs;
  try {
    prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    report('R6', '偏好', false, 'preferences.json 解析失败', '修好 JSON。');
    return;
  }
  // 检查同类里有没有明显矛盾的（简单启发：同一类里出现"不"字的相反说法）
  const byKind = {};
  for (const p of prefs) (byKind[p.kind] ||= []).push(p.text);
  const conflicts = [];
  for (const [k, texts] of Object.entries(byKind)) {
    if (texts.length < 2) continue;
    // 粗糙但有效的检查：一条说"用X"，一条说"不用X"
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i], b = texts[j];
        if (b.startsWith('不') && a.includes(b.slice(1))) conflicts.push(`${k}: 「${a}」vs「${b}」`);
        if (a.startsWith('不') && b.includes(a.slice(1))) conflicts.push(`${k}: 「${a}」vs「${b}」`);
      }
    }
  }
  if (conflicts.length) {
    report('R6', '偏好', false, `${conflicts.length} 处可能冲突：${conflicts.slice(0,3).join('；')}`,
      '同一条偏好出现相反说法。跑 prefs.mjs list 看，删掉不要的那条。');
  } else {
    report('R6', '偏好', true, `${prefs.length} 条，无明显冲突`);
  }
}

// ---------- R7 共享层卫生 ----------
function checkShared() {
  const home = process.env.DSH_HOME;
  if (!home) { report('R7', '共享层', true, '（未启用）'); return; }
  const boardFile = path.join(home, 'shared', 'board.json');
  if (!fs.existsSync(boardFile)) {
    report('R7', '共享层', true, '（还没有待办）');
    return;
  }
  let board;
  try { board = JSON.parse(fs.readFileSync(boardFile, 'utf8')); }
  catch { report('R7', '共享层', false, '待办文件解析失败', '修好 JSON。'); return; }

  const open = board.filter((x) => !x.done);
  const now = Date.now();
  // 超过 14 天没动的待办：要么做，要么删。长期挂着等于没有待办板。
  const stale = open.filter((x) => {
    const t = Date.parse((x.at || '').replace(' ', 'T'));
    return Number.isFinite(t) && now - t > 14 * 86400_000;
  });
  if (stale.length) {
    report('R7', '共享层', false,
      `${stale.length} 条待办挂了超过 14 天：${stale.slice(0,3).map((x)=>x.text.slice(0,20)).join('、')}`,
      '要么做掉，要么删掉。长期挂着的待办会让人不再看这块板。');
  } else {
    report('R7', '共享层', true, `${open.length} 条待办，无长期积压`);
  }
}

// ---------- R8 交接新鲜度 ----------
function checkFreshness(dir) {
  for (const name of ['HANDOFF.md', 'handoff.md']) {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) continue;
    const st = fs.statSync(f);
    const days = (Date.now() - st.mtimeMs) / 86400_000;
    if (days > 30) {
      report('R8', '交接新鲜度', false,
        `${name} 已经 ${days.toFixed(0)} 天没更新`,
        '要么项目已经结束（删了或归档），要么交接没跟上实际进度——后者更危险。');
    } else if (days > 7) {
      report('R8', '交接新鲜度', false,
        `${name} ${days.toFixed(0)} 天没更新`,
        '如果还在做这个项目，交接该更新了。');
    } else {
      report('R8', '交接新鲜度', true, `${days < 1 ? '今天更新过' : days.toFixed(0) + ' 天前更新'}`);
    }
    return;
  }
  report('R8', '交接新鲜度', true, '（无交接文件）');
}

// ---------- 失败项 → 待办板 ----------
/**
 * 把一条失败结果翻成「能直接动手」的待办文字。
 * 为什么不写「R1 失败」：那只是给机器看的编号，人看见编号还得回头查一遍
 * 体检输出才知道要干嘛；闭环的意义就是下次开工不必再查。
 * 所以每条都带具体动作 + 本次查到的差异集合（几个残留、哪两条偏好打架、
 * 超了多少 KB），让待办单独拿出来就能执行。
 * 判重的坑在 shared.mjs 这一侧：它是拿整段文字做等值比较的，所以只要
 * 待办文字里混进每次都会变的东西（R8 的「31 天」、R7 的过期条数、
 * readdir 的顺序、JSON 报错里的行列号），同一个坑第二天就会再加一行。
 * 因此先把 detail 归一化成「稳定的问题特征」：数字抹平、文件名排序、
 * 只保留冲突主体；文字和 key 都只由这份特征推导，两者一起稳定。
 */
function boardTodo(r) {
  const d = (r.detail || '').trim();
  let stamp = d;
  if (r.id === 'R8') stamp = d.replace(/\d+\s*天/g, 'N 天').replace(/\d+/g, 'N');
  if (r.id === 'R1' && d.includes('太虚')) stamp = '「下一步」太虚';
  if (r.id === 'R2') stamp = d.replace(/^[\d.]+\s*KB/, 'N KB');
  if (r.id === 'R7') stamp = d.replace(/^\d+ 条/, 'N 条').replace(/\d+\s*天/g, 'N 天');
  if (r.id === 'R5' && d.includes('解析失败')) stamp = '.scene.json 解析失败';
  if (r.id === 'R3') {
    // 残留清单要进待办（人得知道删哪些），但顺序不能左右判重。
    const m = d.match(/^(\d+)\s*个临时残留：(.*)$/);
    stamp = m ? `${m[1]} 个临时残留：${m[2].split(/,\s*/).map((s) => s.trim()).filter(Boolean).sort().join(', ')}` : d;
  }
  // R9 是并行的另一项改动加进来的检查，失败项同样要能进待办；
  // 重叠处数抹平，避免场景增减让同一个冲突反复开新条目。
  if (r.id === 'R9') stamp = d.replace(/^\d+ 处/, 'N 处');
  // 稳定标记：同一类 + 同一现象 → 同一 hash；现象变了（比如残留从 3 个变 4 个）
  // 才算一件新事，值得新开一行提醒。
  const key = crypto.createHash('sha1').update(`${r.id}\n${stamp}`).digest('hex').slice(0, 8);
  let action;
  switch (r.id) {
    case 'R1':
      // 缺文件 / 缺小节 / 「下一步」太虚是三种不同的活，不能挤成一句「补交接」。
      action = d.includes('没有找到')
        ? '补一份 HANDOFF.md（上次交接/当前项目/变更记录/下一步卡点/关键文件五小节，「下一步」写成具体动作，不要「继续开发」）'
        : d.includes('太虚')
          ? '补 HANDOFF.md 的「下一步」（写成具体动作，不要「继续开发」这种空话）'
          : `补齐 HANDOFF.md 缺的小节：${d.replace(/^缺小节：/, '')}`;
      break;
    case 'R2':
      action = '把 HANDOFF.md 压回 4KB 以内：旧轮次搬进归档，只留最新一份 + 指针';
      break;
    case 'R3': {
      // detail 形如「3 个临时残留：a.bak, b.tmp」，把清单原样带进待办，
      // 免得下次还得重跑体检才知道要删哪些文件。
      const list = stamp.split('：').slice(1).join('：').trim();
      action = `清掉 ${list ? `${stamp.split('：')[0]}：${list}` : `临时残留（${d}）`}`;
      break;
    }
    case 'R4':
      action = `给超限技能拆文件：${d.replace(/^超 12KB：/, '')}；拆成「主文件 + reference 子文件」，主文件只留索引与判据`;
      break;
    case 'R5':
      action = d.includes('解析失败')
        ? '修好 .scene.json 的 JSON 语法'
        : d.includes('没有 .scene.json')
          ? '跑 scene.mjs init 建 .scene.json，写明这个场景负责什么、不碰什么'
          : `补齐 .scene.json 的字段：${d.replace(/^缺字段：/, '')}（avoid 尤其不能空）`;
      break;
    case 'R6':
      // 冲突明细里有类别和互相打架的两句话，直接写「删掉哪一条」。
      action = d.includes('解析失败')
        ? '修好 preferences.json 的 JSON 语法'
        : `删掉冲突的偏好：${d.replace(/^\d+ 处可能冲突：/, '')}（跑 prefs.mjs list 看，删掉不要的那条）`;
      break;
    case 'R7':
      action = d.includes('解析失败')
        ? '修好共享层 board.json 的 JSON 语法'
        : '清理挂了超过 14 天的待办：要么做掉要么删掉';
      break;
    case 'R8':
      action = '更新或归档超过 7 天没动的交接文件：要么项目结束了删掉，要么把进度写进 HANDOFF.md';
      break;
    case 'R9':
      // 地盘重叠是 R9 检查的失败项：写清楚按仲裁表定归属，或把路径收窄。
      action = `处理重叠的场景地盘：${d.replace(/^\d+ 处重叠：/, '').replace(/^N 处重叠：/, '')}；按仲裁表确认听谁的，或把 territory 收窄到不重叠`;
      break;
    default:
      action = `${r.name}：${d}`;
  }
  // 标记放末尾：人眼读的是前面的动作，机器判重靠的是这段不变的尾巴。
  return { key, text: `${action} 〔体检${r.id}·${key}〕` };
}

/**
 * 找到 shared.mjs 的绝对路径。
 * 脚本和 shared.mjs 都在只读的 app bundle 里，工作目录里没有副本，
 * 所以优先用 $DSH_TOOLS 拼；没设这个变量时退回「与本脚本同级的 ../shared」，
 * 保证在开发机上直接跑也不会找不到工具。
 */
function sharedTool() {
  const tools = process.env.DSH_TOOLS;
  const candidates = tools
    ? [path.join(tools, 'shared', 'shared.mjs')]
    : [];
  candidates.push(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shared', 'shared.mjs'));
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * 体检失败 → 写待办。
 * 为什么整段包在 try/catch 里且从不改退出码：待办只是「下次开工的提醒」，
 * 不是体检结论。目录不可写、shared.mjs 不在、JSON 坏了，都只该少一个提醒，
 * 不该让本来能正常报出 3 个失败项的体检反而报错退出。
 */
function pushToBoard(failed) {
  const out = { written: [], skipped: 0, reason: '' };
  if (!failed.length) return out;

  const tool = sharedTool();
  if (!tool) { out.reason = '找不到 shared.mjs'; return out; }

  for (const r of failed) {
    const { key, text } = boardTodo(r);
    try {
      // 不经过 shell：node 在 iOS 上由 worker 线程代跑，路径和中文参数
      // 交给 shell 解析容易被改写；spawnSync 直接传参数最稳，也拿得到 id。
      // --go 必须带：shared.mjs 的写操作默认空跑（只打印「会加」不落盘），
      // 体检要的是真闭环，得显式放行；该标志被它自己从 argv 里过滤掉，
      // 不会混进待办文字。老版本没有空跑开关时会把它当未知参数忽略，兼容。
      const res = spawnSync(process.execPath, [tool, 'board', 'add', text, '--go'], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout = res.stdout || '';
      const stderr = res.stderr || '';
      // 判重分支要先认：shared.mjs 遇到同义条目时只打印「已经在待办里了」，
      // 不会回显待办文字，所以不能拿标记去验这一路。
      if (!res.error && res.status === 0 && stdout.includes('这条已经在待办里了')) {
        out.skipped += 1;
        continue;
      }
      // 校验「已加」+ 回显里的标记，而不是只看退出码：空跑、或将来
      // shared.mjs 改了输出格式，都不能误报「已写进待办」。
      if (res.error || res.status !== 0 || !stdout.includes('已加：') ||
          !stdout.includes(`〔体检${r.id}·${key}〕`) || stdout.includes('空跑')) {
        // 写不进去不能静默：说一句「待办没写成」即可，不影响体检输出与退出码。
        out.reason = (stderr.trim() || (res.error && res.error.message) || 'board add 没返回成功').split('\n')[0];
        continue;
      }
      const id = (stdout.match(/^\s*id:\s*(\S+)/m) || [])[1] || '';
      // 拿到 id 才算真的新增——输出里要给人一个能 board done 划掉的把手。
      if (id) out.written.push({ id, text });
      else out.skipped += 1;
    } catch (e) {
      // 子进程崩了 / 超时也照常往下跑，理由最后统一提示一次。
      out.reason = (e && e.message) || '待办写入异常';
    }
  }
  return out;
}

// ---------- 入口 ----------
const args = process.argv.slice(2);
const asJson = args.includes('--json');
// 默认自动进待办；只想看结果时用 --no-board 关掉，避免污染待办板。
const noBoard = args.includes('--no-board');
const dir = path.resolve(args.find((a) => !a.startsWith('--')) || '.');

// 路径本身不合法是用法错误，不是"规矩没守住"——两者要分开报，
// 否则用户看到一堆 ✗ 却不知道是自己路径写错了。
try {
  if (!fs.statSync(dir).isDirectory()) {
    console.error(`不是目录：${dir}`);
    process.exit(2);
  }
} catch {
  console.error(`路径不存在：${dir}`);
  process.exit(2);
}

checkHandoff(dir);
// R9：地盘重叠检测 —— 两个场景的 territory 有包含关系就是冲突。
// 他那边靠人工看，我们做成自动的。判据：A 是 B 的前缀或反过来。
function checkTerritory(dir) {
  const scenes = [];
  // 找当前目录和兄弟目录里的 .scene.json（最多两层）
  const roots = [dir, path.join(dir, '..')];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const f = path.join(root, e.name, '.scene.json');
      try {
        const sc = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (sc.name && Array.isArray(sc.territory)) {
          scenes.push({ name: sc.name, territory: sc.territory, at: f });
        }
      } catch {}
    }
  }
  if (scenes.length < 2) {
    report('R9', '地盘重叠', true, `（只有 ${scenes.length} 个场景，不足两个不检查）`);
    return;
  }
  const conflicts = [];
  for (let i = 0; i < scenes.length; i++) {
    for (let j = i + 1; j < scenes.length; j++) {
      const a = scenes[i], b = scenes[j];
      for (const pa of a.territory) {
        for (const pb of b.territory) {
          // 一个路径是另一个的前缀 → 重叠（含相等）
          const norm = (x) => x.replace(/\/+$/, '');
          const na = norm(pa), nb = norm(pb);
          if (na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/')) {
            conflicts.push(`${a.name}(${pa}) 与 ${b.name}(${pb})`);
          }
        }
      }
    }
  }
  if (conflicts.length) {
    report('R9', '地盘重叠', false,
      `${conflicts.length} 处重叠：${conflicts.slice(0,3).join('；')}`,
      '按 docs/场景地盘与仲裁.md 的仲裁表确认听谁的，或者把地盘收窄到不重叠');
  } else {
    report('R9', '地盘重叠', true, `${scenes.length} 个场景，无路径重叠`);
  }
}
checkTerritory(dir);
// R10：文档状态 —— docs/ 下的文档必须标状态，否则会越堆越多没人知道该信哪个。
// 判据：每个 .md 开头 10 行内要有「状态：活/常备/留档/待清」之一。
// 状态格必须精确等于四个词之一，写「留档（2026-10-18 归档）」会被解析器当"未登记"。
function checkDocStatus(dir) {
  const docsDir = path.join(dir, 'docs');
  if (!fs.existsSync(docsDir)) {
    report('R10', '文档状态', true, '（无 docs 目录，跳过）');
    return;
  }
  const STATES = ['活', '常备', '留档', '待清'];
  const files = [];
  // 只检查**我们自己写的**文档，不检查上游带来的。
  // 上游文档（docs/design、docs/promo、docs/webui）是别人维护的，
  // 我们改不了也不该改；把它们算进检查会让这个检查永远报错，
  // 而永远报错的检查最后一定被忽略。
  const SKIP = new Set(['design', 'promo', 'webui', 'assets']);
  function walk(d) {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(full);
      } else if (e.name.endsWith('.md')) files.push(full);
    }
  }
  walk(docsDir);
  if (!files.length) {
    report('R10', '文档状态', true, '（docs 里没有 md）');
    return;
  }
  const missing = [];
  for (const f of files) {
    let head = '';
    try { head = fs.readFileSync(f, 'utf8').slice(0, 600); } catch { continue; }
    const m = head.match(/状态[：:]\s*(\S+)/);
    if (!m || !STATES.includes(m[1])) {
      missing.push(path.relative(dir, f) + (m ? `（写了「${m[1]}」，不是四词之一）` : ''));
    }
  }
  if (missing.length) {
    report('R10', '文档状态', false,
      `${missing.length}/${files.length} 份没标状态或状态不合法`,
      `在文档开头加「状态：活」（可选值：${STATES.join(' / ')}）；明细：${missing.slice(0,3).join('、')}`);
  } else {
    report('R10', '文档状态', true, `${files.length} 份全部有合法状态`);
  }
}
checkDocStatus(dir);
checkTempJunk(dir);
checkSkills(dir);
checkScene(dir);
checkPrefs();
checkShared();
checkFreshness(dir);

const failed = results.filter((r) => !r.ok);
const okCount = results.length - failed.length;

// 先写待办再打印：待办是「体检的后续动作」，结论行必须留在最后说清楚
// 这次到底欠了几件事、id 是什么。任何写入异常都被 pushToBoard 吞掉，
// 不会改变下面原有的输出，也不会改变退出码。
const board = noBoard ? { written: [], skipped: 0, reason: '', off: true } : pushToBoard(failed);

if (asJson) {
  // --json 的 stdout 必须仍是纯 JSON，否则调用方解析不了；待办照写不误，
  // 需要看结果的场景用 --no-board 关闭写入。
  console.log(JSON.stringify({ ok: failed.length === 0, total: results.length, passed: okCount, results }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} [${r.id}] ${r.name}  ${r.detail}`);
    if (!r.ok && r.fix) console.log(`     → ${r.fix}`);
  }
  console.log('');
  console.log(`${okCount}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项已列出处理办法。没修的不要假装通过。');
  } else {
    console.log('规矩都在跑，不是口号。');
  }

// 闭环的落点要放在最后：一眼看见通过/失败统计、这次新写进去的 id，
  // 以及下次开工怎么把欠账调出来。用 results.length 而不是写死 8：
  // 并行的 R9 等新检查加进来时，统计行不会说谎。
  console.log('');
  console.log(`${results.length} 类体检：${okCount} 通过，${failed.length} 失败`);
  if (board.off) {
    console.log('本次用了 --no-board，没有写进待办板。');
  } else if (board.written.length) {
    console.log(`已把 ${board.written.length} 条失败项写进待办板：`);
    for (const w of board.written) {
      console.log(`  ${w.id}  ${w.text}`);
    }
    console.log('下次开工跑 shared.mjs board 就能看到。');
  } else if (board.skipped) {
    // 旧待办即使问题已修好也留着：修好了 ≠ 我知道修好了，得人工 board done 划掉。
    console.log(`这 ${board.skipped} 条失败项待办里已经有了，没有重复添加。`);
    console.log('修好了记得用 shared.mjs board done <id> 划掉，跑 shared.mjs board 能看到。');
  } else if (!failed.length) {
    console.log('没有失败项，不需要进待办。');
  }
  if (board.reason) {
    // 待办目录不可写等故障只提示，不改变体检结论和退出码。
    console.log(`（待办没写成：${board.reason}；体检结果不受影响）`);
  }
}
process.exit(failed.length === 0 ? 0 : 1);
