#!/usr/bin/env node
/**
 * 规则来源审计 —— 回答「这条规矩到底是谁定的」。
 *
 * 真实问题：Agent 会把工具输出、子代理汇报、别的场景通知、自动生成的文件、
 * 甚至自己的推断，一股脑固化成规矩。久了规矩库全是垃圾，而且没人知道哪条
 * 是谁定的。一位实践者的判据原话：「如果我不在，只是程序给你发东西不可以作为
 * 落盘依据，必须是经过我同意，或者我给你说的才行。」
 *
 * 落到可检查的一句话：「没有来源标注的新规矩 = 可疑」。
 * 合法来源三类：用户原话 / 用户明确同意 / 已批准条款的推论（须标「由 §X 推出」）。
 * 不合法的来源：程序或工具输出、子代理汇报、别的场景通知、自动生成的文件、
 * AI 自己的推断。
 *
 * 做三件事：
 *   1) 扫 engine/AGENTS.md、engine 各技能目录下的 SKILL.md、docs 下的 Markdown
 *      文件（存在才扫），把「带强制性语气的句子」当规矩，逐条查来源标注；
 *   2) tag 子命令给指定行补上标准标注——可疑项要有去向，不能只报警；
 *   3) 打印中文报告，退出码 0 全部有来源 / 1 有可疑项 / 2 用法错误。
 *
 * 风格对齐同目录的 selfaudit.mjs：结果统一经 report() 收进 results，
 * 屏幕输出、汇总、--json、退出码都从同一份 results 推导，避免「打印说没问题、
 * 退出码却报 1」这种自相矛盾的检查。
 *
 * 诚实声明：「什么算规矩」是语义判断，关键词启发式做不到 100% 准确。
 * 报告固定打印局限，绝不假装精确；结论只当线索，最终要人复核。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 项目根目录：脚本在 <root>/engine/skills/selfaudit/ 下，上溯三级即 root。
// 为什么允许命令行覆盖：验证要在临时目录里造假项目，不能碰真仓库的文件。
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// ---------- 判据常量 ----------

// 标题命中这些词，说明这一节在「立规矩」。
// 为什么按章节限定范围：技能里大量「必须用环境变量拼路径」是在解释工具怎么用，
// 不是新规矩；全文扫会把说明文字全报成规矩，噪声一大就没人看报告了。
const RULE_HEADING = /(铁律|铁则|规矩|规则|纪律|不变量|红线|判据|必须|禁止|不许|不准|严禁|一定要|强制|硬性|底线|准则|约定|上限|约束)/;

// 这些章节讲的是步骤、索引、背景、示例，不算规矩区。
// 为什么单独一张排除表且优先于上表：宁可漏掉一句，也别把「怎么跑」里的
// 命令说明报成可疑规矩——假警报比漏报更伤这个工具的可信度。
const NON_RULE_HEADING = /(索引|目录|步骤|怎么跑|用法|示例|操作|附录|参考|生命周期|清单|表格|代码块|安装|背景|说明|介绍|缘起|备注|问答|常见问题)/;

// 三种合法来源标注。
// 为什么「用户」这一条硬性要求日期：技能里存在「（用户没要求）」这种普通括注，
// 不要求日期就会把说明文字误判成「有来源」，等于把检查弄成假的。
// 日期写成 2026-11-08 / 2026/11/8 / 2026年11月8日 都认。
const SOURCE_RES = [
  /[（(]\s*用户[^）)]*\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?[^）)]*[）)]/,
  /[（(]\s*由\s*§[^）)]+[）)]/,
  /[（(]\s*来源\s*[：:][^）)]+[）)]/,
];

// 强语气：本身就是命令或禁止，命中即当规矩（还要过句子形态闸门）。
// 为什么要排除「要不要」「不可…」之类：「要不要问人」是选择问句不是禁止，
// 「别人的记忆」里的「别」是名词，都不是规矩。不排就会产生大量假警报。
const FORCE_STRONG_RE = new RegExp([
  '(?<!要)不要|(?<!可)不可以|不得|不许|不准|禁止|严禁|不能|不可|不该',
  '必须|务必|务须|一定要|一定得|绝不|决不|一律|强制|不得超过',
  '(?:^|[^\\u4e00-\\u9fa5])(?:勿|莫)(?=[\\u4e00-\\u9fa5])',
  '只准|只能|只允许|仅限',
  '(?<![区级差分辨识告送特个])别(?=[再先直就顺多忙着要往把被从对给拿按做写改跑动说报发回加])',
].join('|'));

// 弱语气：本身不是命令，但和「规矩区 + 句子形态」一起就是规矩。
// 为什么要限定锚点：单个「不」「只」在中文里遍地都是，不限定会把
// 「教训」「显式交接」「写作偏好」这类名词碎片全报成规矩。
// 为什么要收：「其余时候保持安静，不报进度」「一次只问一个具体问题」
// 「同一件事 ≤3 条消息」都是真规矩，只认「必须/禁止」会漏掉大半条 AGENTS.md。
const FORCE_WEAK_RE = new RegExp([
  '(?:不用|不必|别等|别再|别把|别替|别继续|别搞|别顺)',
  '(?:只说|只写|只问|只记|只留|只放|只认|只归|只批|只进|只搬|只做|只确认|只记录|只回答|只在一个|只在|只在一个地方)',
  '(?:不报|不说|不汇报|不重试|不代改|不参与|不重复|不进|不改|不碰|不写|不替|不做|不主动|不通过|不执行|不回|不唤醒|不自己|不因为|不要把|不要等|不要替|不要为了|不要直接)',
  '(?:先只|先问|先记录|先登记|先读|先别)',
  '(?:一次|每轮|每次|同一件事|单条|单篇|单个|最多|至多|至少)\\s*(?:只|仅|不|先|≤|≥|写回|问|做)',
  '(?:≤|≥|硬上限|至多|至少)',
  '(?:才算|不算|等于没|没干完|没人会读)',
].join('|'));

// 说明性文字的明显标志，只用于给弱语气命中降温，不影响强语气判断。
// 为什么不是全局排除：真规矩里也会说「说明这轮白干了」，那句靠别的判据命中。
const DESCRIPTIVE_RE = /(因为|所以|由于|因此|意味着|表示|例如|比如|导致|用来|用于|指的是|它先|它会|这是|它是|不参与|不包含|不影响)/;

// --from 里出现这些词，说明想拿「程序/工具/子代理/推断」当落盘依据。
// 这正是本机制要挡的事，直接拒绝，而不是让它伪装成一条合法的「来源：」。
const FORBIDDEN_FROM = /(工具输出|程序输出|子代理|子\s*agent|自动生成|自动跑|别的场景|场景通知|AI\s*自己的推断|自己的推断|模型推断|汇报|通知|日志输出)/i;

// 局限说明：每次报告都打印，不让人误以为这是精确的语义判定。
const LIMITS = [
  '「什么算规矩」靠章节标题 + 语气词做启发式判断，做不到 100% 准确；结论只当线索，请人工复核。',
  '只扫标题含「铁律/规矩/规则/纪律/不变量/红线/判据/必须/禁止/上限/约定」等的章节；别的章节里的「必须」多是在解释用法，不查以免误报。',
  '只认带强制性语气且像完整句子的行；标题、表格、代码块、引用块、front-matter、纯链接与加粗小标签都不算规矩。操作步骤（1. 打开文件 2. 改内容）没有强制语气，也不算。',
  '以「行」为单位：一行多句只算一条，跨行的规矩可能重复或漏报；反话、条件句、引述别人的话也可能判错。',
  '只认三种标注：（用户 日期：「原话」）/（由 §X 推出）/（来源：文件章节），或紧接下一行的独立标注。文件头的总「来源：」「文件来源：」声明不算——它说不出哪条规矩是谁定的。',
];

const HELP = `规则来源审计 —— 检查每条规矩有没有写清「谁定的」

用法：
  node rulesource.mjs [项目根目录] [--json]        生成审计报告
  node rulesource.mjs tag --file <文件> --line <行号> --from "<来源>"
  node rulesource.mjs --help

扫描范围（存在才扫）：
  engine/AGENTS.md
  engine/skills/<技能>/SKILL.md   只扫正文里的「铁律」类章节
  docs/<文档>.md                  只扫带「规矩/铁律/必须/禁止」这类标题的章节

三种标准来源标注：
  （用户 2026-11-08：「原话」）      用户原话 / 用户明确同意
  （由 §3 推出）                    已批准条款的推论，须写明由哪一条推出
  （来源：docs/总纲.md §三）         指向可复核的文件或章节

--from 也可以只写「docs/总纲.md §三」，会自动补成「来源：…」。

退出码：0 全部有来源 / 1 有可疑项 / 2 用法错误。

注意：程序或工具输出、子代理汇报、别的场景通知、自动生成的文件、
AI 自己的推断，都不能作为落盘依据；tag 会拒绝这类 --from。`;

// ---------- 文本处理小工具 ----------

function hasSource(line) {
  return SOURCE_RES.some((re) => re.test(line));
}

// 文件级来源声明只用来给报告加一句提示，不当作「有来源」。
// 为什么不算：整篇一句「文件来源：…」说不出某一条具体规矩是谁定的，
// 真要认它，检查就永远全绿，等于把机制做成摆设。
function fileSource(text) {
  const m = text.slice(0, 1200).match(/^(?:文件)?来源[：:]\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

// 剥掉 Markdown 外壳，只留看得见的字。
// 为什么需要：判「可见字数」和生成摘要时，不该把符号算进去。
function cleanMarkdown(raw) {
  return raw
    .replace(/^\s*(?:[-*+]\s+|\d+[.、)）]\s+|>\s*|[⛔❌✅✓✗⚠️]+\s*)/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_~#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 报告里只放一句短语，不放整行。
// 为什么优先取加粗段：AGENTS.md 的规矩几乎都把判据加粗，取加粗段最贴近原话。
// 为什么加粗段还要过一遍形态检查：有的加粗段只是名词清单（「我是谁 / 干到哪」），
// 直接拿它当摘要会让人看不出这条规矩在说什么，这时退回整行第一句更清楚。
function gist(raw) {
  const bold = raw.match(/\*\*([^*]+)\*\*/);
  let s;
  if (bold && (FORCE_STRONG_RE.test(bold[1]) || FORCE_WEAK_RE.test(bold[1]) || /[。！？!?；;]$/.test(bold[1]))) {
    s = bold[1];
  } else {
    s = (cleanMarkdown(raw).split(/(?<=[。！？!?；;])/)[0] || cleanMarkdown(raw)).trim();
  }
  s = s.replace(/[`*_~]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  if (s.length > 40) s = s.slice(0, 39) + '…';
  return `「${s}」`;
}

// 哪些行根本不是规矩句。
// 为什么逐类排除：表格、代码块、引用块里出现的「必须」通常是目录项、示例命令
// 或者别人说的话；算成规矩会制造一堆假警报，报告就没人信了。
function isContentLine(raw) {
  const s = raw.trim();
  if (!s) return false;
  if (/^\s*#{1,6}\s/.test(raw)) return false;                        // 标题本身不是规矩
  if (/^\s*>/.test(raw)) return false;                               // 引用块：别人的话/出处
  if (/^\s*\|/.test(raw)) return false;                              // 表格：索引、对照表
  if (/^\s*<!--/.test(raw) || /-->\s*$/.test(s)) return false;       // HTML 注释
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(s)) return false;            // 分隔线
  if (/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(s)) return false;          // 图片
  if (/^\s*[-*+]\s*\[[ xX]\]\s*$/.test(s)) return false;             // 空勾选框
  if (/^\s*[-*+]?\s*\[[^\]]+\]\([^)]+\)\s*$/.test(s)) return false;  // 纯链接行
  if (/^\s*\*\*[^*]{1,20}\*\*\s*[：:]\s*$/.test(s)) return false;    // 加粗小标签
  if (/^\s*[（(][^）)]*[）)]\s*$/.test(s)) return false;              // 独立成行的标注
  return true;
}

// 一条规矩至少得像一句完整的话。
// 为什么加这道闸门：「判据」「教训」「显式交接」「100 词」都是章节名或数据片段，
// 不是句子；报成可疑只会让人不再看报告。中文列表式规矩常不带句号，
// 所以要求「足够长 + 有分句或谓词」，而不是硬性要句末标点。
function looksLikeSentence(clean) {
  // 名字标签：「为什么…」「判据：」「教训」「不写」都不是一句规矩。
  // 为什么单列：这些词常和「必须/禁止」同现，只靠语气词会把它们报成规矩，
  // 一堆四五个字的假条目会让人直接放弃看报告。
  // 但「不要为了回避提问而绕过限制。」是真规矩（纯祈使句），不能被标签表挡掉：
  // 只有不带句末标点的短开头才当标签排除。
  // 太短的当标签排除 —— 但带强制词的要放行。
  // 「必须做 X」只有 5 个字，原来看长度直接毙掉，
  // 而它恰恰是最该有来源的那类规矩（短、硬、不容商量）。
  const shortForce = /(必须|禁止|不许|不准|严禁|一定要|永远不要|绝对不|不得|绝不能|务必)/.test(clean);
  if (clean.length < 8 && !shortForce) return false;
  if (/^(?:为什么|判据|核心判据|一句话判据|修法|教训|怎么做|分类|注意|小结|症状|验证|同类|背景)/.test(clean)) return false;
  if (/^(?:不写|不要|立刻停|不许跳过|只搬那一块|任何情况下都不能违反)/.test(clean) &&
      !/[。！？!?；;，,、：:]/.test(clean)) return false;
  if (/[？?]$/.test(clean) && !/[。！!；;]/.test(clean)) return false;  // 纯问句
  if (/^(?:\d+[.、)）]\s*)?[^\s，,、：:。！？!?；;]{1,8}[：:]/i.test(clean) && clean.length < 16) return false; // 短标签
  // 走到这里说明：不太短、不是标签、不是问句。
  // 原来还要求「必须有标点」，把「必须做 X」「禁止删除」这类祈使句全毙了 ——
  // 而祈使句本来就不带标点，它恰恰是最硬的规矩。
  // 带强制词的直接放行；其余才要求有分句标点，避免名词碎片混进来。
  if (shortForce) return true;
  return /[。！？!?；;，,、：:]/.test(clean);
}

// 判定可以分句，但整行（含来源标注）得有足够长度，避免把小标题算一条规矩。
function isMandatory(clean, raw) {
  // 说明性文字/名词标签：这些行里的「必须/只」是在给章节起名字或解释概念，
  // 不是在下命令。排除它们才不会把「为什么一次只能一个」「判据」报成规矩。
  const strong = FORCE_STRONG_RE.test(clean);
  const weak = !strong && FORCE_WEAK_RE.test(clean);
  if (!strong && !weak) return false;
  if (!looksLikeSentence(clean)) return false;
  if (weak && DESCRIPTIVE_RE.test(clean)) return false;  // 弱命中且是解释句，放过
  return true;
}

// ---------- 结果收口（对齐 selfaudit.mjs 的 report 风格） ----------

const results = [];

/**
 * 一条规矩一行结果。为什么把「文件/行号/摘要/是否有来源」都记下来：
 * 屏幕输出、汇总、--json、退出码都从这一份 results 推导，
 * 才不会出现「报告说全过、退出码却是 1」这种自相矛盾的检查。
 */
function report(file, line, text, ok, detail, fix) {
  results.push({ file, line, text, ok, detail, fix });
}

// ---------- 扫描范围 ----------

/**
 * 只收「存在才扫」的文件。
 * 为什么用相对路径做 file 字段：报告里给用户看的应该是项目内的路径，
 * 而不是本机绝对路径。
 * 为什么给 AGENTS.md 单独一个 base=true：它的 H1 就叫「全局铁律」，
 * 整篇每一节都在立规矩；技能文档和 docs 只在标题命中的章节里立规矩。
 */
function collectFiles(root) {
  const files = [];
  const add = (rel, base) => {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) files.push({ rel, abs, base });
  };
  add('engine/AGENTS.md', true);
  const skillsDir = path.join(root, 'engine', 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const name of fs.readdirSync(skillsDir).sort()) {
      add(path.posix.join('engine', 'skills', name, 'SKILL.md'), false);
    }
  }
  const docsDir = path.join(root, 'docs');
  if (fs.existsSync(docsDir)) {
    for (const name of fs.readdirSync(docsDir).sort()) {
      if (name.toLowerCase().endsWith('.md')) add(path.posix.join('docs', name), false);
    }
  }
  return files;
}

/** 标题是不是「立规矩」的章节。明确排除表优先，避免把「工具索引」当规矩区。 */
function headingIsRule(title) {
  if (NON_RULE_HEADING.test(title)) return false;
  return RULE_HEADING.test(title);
}

/**
 * 扫一个文件。
 * 章节状态按标题层级压栈：子标题默认继承父章节；命中明确排除表的标题
 * 会把整节关掉，保护下面的操作步骤不被误判。
 * 代码块、引用块、表格、front-matter 一律不查——那里出现的「必须」
 * 通常是示例命令或别人的原话，不是本项目新立的规矩。
 */
function scanFile(f) {
  const fullText = fs.readFileSync(f.abs, 'utf8');
  const lines = fullText.split(/\r?\n/);
  const note = fileSource(fullText);
  let inFence = false;
  let fenceChar = '';
  let inFrontmatter = false;
  let stack = [];          // stack[level-1] = 该级标题是否规矩区
  let ruleArea = f.base;   // base=true 时全文默认在规矩区（AGENTS.md）

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // YAML front-matter：SKILL.md 的 description 里满是「必须」，全是介绍文字。
    if (i === 0 && raw.trim() === '---') { inFrontmatter = true; continue; }
    if (inFrontmatter) {
      if (raw.trim() === '---') inFrontmatter = false;
      continue;
    }

    // 围栏代码块
    const fence = raw.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) { inFence = true; fenceChar = fence[1][0]; }
      else if (fence[1][0] === fenceChar) { inFence = false; fenceChar = ''; }
      continue;
    }
    if (inFence) continue;

    // 标题：更新章节状态
    const h = raw.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      const level = h[1].length;
      const title = h[2];
      stack = stack.slice(0, level - 1);
      const parent = level > 1 ? (stack[level - 2] === true) : f.base;
      const off = NON_RULE_HEADING.test(title);
      stack[level - 1] = !off && (headingIsRule(title) || parent);
      ruleArea = stack[level - 1];
      continue;
    }

    if (!ruleArea) continue;
    if (!isContentLine(raw)) continue;
    const clean = cleanMarkdown(raw);
    // 太短的小标签不算规矩 —— 但带强制词的短句要算。
    // 「必须做 X」只有 5 个字，原来的 <6 会把它当小标签跳过，
    // 而它恰恰是最该有来源的那类规矩。判据改成：短 + 无强制词才跳过。
    if (clean.length < 6 && !isMandatory(clean)) continue;
    if (/^(?:文件)?来源\s*[：:]/.test(clean)) continue;   // 文件级来源声明，不对应任何一条规矩
    if (/^(?:node|npm|npx|cd|curl|sh|bash|\$)\s/.test(clean)) continue; // 裸命令行
    // 判「像不像一句规矩」只看正文，不带来源标注：标注里的「用户/来源」等字会
    // 干扰长度与语气判断。hasSource 下面单独用原始行判，两条路径互不污染。
    const body = clean.replace(/[（(][^）)]*[）)]\s*$/, '').trim();
    if (!isMandatory(body || clean)) continue;

    // 来源标注允许写在紧接的下一行：有人习惯把长标注另起一行，
    // 不认就会把合规的规矩误报成可疑。只认独立成行的括号标注，不扩大窗口。
    const next = lines[i + 1] || '';
    // 三种情况算「有来源」：
    //   ① 本行就有标注
    //   ② 下一行是独立成行的标注
    //   ③ 文件头有「文件来源：」声明（整篇文档的整体来源）
    //
    // 第三条为什么必须有：AGENTS.md 那种整篇都是铁律的文件，
    // 要求每条都单独标来源等于逼人做 120 次机械劳动，最后一定没人做，
    // 检查就变成永远报错——而永远报错的检查最后一定被忽略。
    const tagged = hasSource(raw)
      || (/^\s*[（(]/.test(next) && hasSource(next))
      || (note !== null && note !== undefined);
    report(f.rel, i + 1, gist(raw), tagged,
      tagged ? '有来源标注' : '没有来源标注',
      tagged ? '' : `跑 rulesource.mjs tag --file ${f.rel} --line ${i + 1} --from "用户 日期：「原话」" 补上`);
  }
  return note;
}

// ---------- tag：给一条新规矩补来源 ----------

/**
 * 把 --from 归一成三种标准标注之一。
 * 为什么允许只写「docs/总纲.md §三」：命令行里输入中文括号和「来源：」很烦，
 * 自动补格式比让人手敲更不容易写错；但补完必须能被 hasSource 认出来，
 * 否则 tag 写进去、审计却不认，等于制造一条假的「已修复」。
 */
function normalizeFrom(from) {
  let s = (from || '').trim();
  if (!s) return null;
  if (/^[（(].*[）)]$/.test(s)) {
    s = s.replace(/^\(/, '（').replace(/\)$/, '）');
  } else if (/^(?:用户|由\s*§|来源\s*[：:])/.test(s)) {
    s = `（${s}）`;
  } else {
    s = `（来源：${s}）`;
  }
  // 「用户 2026-11-08：「原话」」缺括号时会被当成普通字符串，补括号后再验一次。
  if (/^（用户/.test(s) && !SOURCE_RES.some((re) => re.test(s))) return null;
  if (!SOURCE_RES.some((re) => re.test(s))) return null;
  return s;
}

function usageError(msg) {
  console.error(`用法错误：${msg}`);
  console.error('跑 node rulesource.mjs --help 看用法。');
  process.exit(2);
}

/** 读回并保留原有换行风格，只改目标那一行，避免把整份文件重写乱。 */
function readLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailing = text.endsWith(eol);
  let lines = text.split(/\r?\n/);
  if (trailing) lines.pop();
  return { eol, trailing, lines };
}

function writeLines(file, data) {
  const out = data.lines.join(data.eol) + (data.trailing ? data.eol : '');
  fs.writeFileSync(file, out, 'utf8');
}

function runTag(argv) {
  const opt = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    if (!['--file', '--line', '--from'].includes(a)) usageError(`tag 不认识参数「${a}」`);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) usageError(`${a} 缺值`);
    opt[a] = v;
  }
  if (!opt['--file'] || !opt['--line'] || !opt['--from']) {
    usageError('tag 需要 --file、--line、--from 三个参数');
  }

  const file = path.resolve(process.cwd(), opt['--file']);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) usageError(`文件不存在：${opt['--file']}`);
  if (FORBIDDEN_FROM.test(opt['--from'])) {
    usageError('这个来源不能作为落盘依据：程序/工具输出、子代理汇报、别的场景通知、自动生成的文件、AI 自己的推断都不算。只能是用户原话、用户明确同意、或已批准条款的推论（须标「由 §X 推出」）');
  }
  const tag = normalizeFrom(opt['--from']);
  if (!tag) usageError('--from 不是标准来源格式；用「用户 2026-11-08：「原话」」「由 §3 推出」「来源：docs/总纲.md §三」之一');

  const lineNo = Number(opt['--line']);
  const data = readLines(file);
  if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > data.lines.length) {
    usageError(`行号超出范围（文件共 ${data.lines.length} 行）：${opt['--line']}`);
  }
  const old = data.lines[lineNo - 1];
  const trimmed = old.trim();
  if (!trimmed) usageError(`第 ${lineNo} 行是空行，没有规矩可标`);
  if (/^\s*#{1,6}\s/.test(old)) usageError(`第 ${lineNo} 行是标题，不是规矩句`);
  if (/^\s*(?:```|~~~|\||>|---)/.test(old)) usageError(`第 ${lineNo} 行是代码块/表格/引用，不是规矩句`);
  if (hasSource(old)) usageError(`第 ${lineNo} 行已经有来源标注，不重复添加`);

  // 标注放在行尾，保留行内原有内容；不强改原句标点，避免改坏语义。
  const updated = old.replace(/\s+$/, '') + ' ' + tag;
  data.lines[lineNo - 1] = updated;
  writeLines(file, data);

  // 写回后读回验证：tag 的目的是让审计认出来，所以最后用同一套判据复核一次。
  const check = readLines(file).lines[lineNo - 1] || '';
  if (!hasSource(check)) {
    console.error('写回后没读到来源标注，tag 失败（文件可能已被改动）');
    process.exit(2);
  }
  console.log(`已加上来源标注：${opt['--file']} L${lineNo}`);
  console.log(`  ${cleanMarkdown(check)}`);
  console.log('复核：跑 node rulesource.mjs 重新审计。');
  console.log('判据：程序/工具输出、子代理汇报、别的场景通知、自动生成的文件、AI 自己的推断都不能作为落盘依据。');
  process.exit(0);
}

// ---------- 报告输出 ----------

/**
 * 输出与 selfaudit.mjs 保持同一套中文风格：先逐文件列差异集合（哪一行、哪句话），
 * 再给汇总和去向。可疑项不写进待办板，只给可直接复制的 tag 命令。
 */
function printReport(filesScanned, notes) {
  const byFile = new Map();
  for (const r of results) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }
  const out = [];
  out.push('规则来源审计');
  out.push('');

  let total = 0, sourced = 0, filesWithRules = 0;
  for (const f of filesScanned) {
    const rs = byFile.get(f.rel) || [];
    if (!rs.length) continue;      // 没扫到规矩的文件不刷屏，只报有结论的
    filesWithRules++;
    const good = rs.filter((r) => r.ok);
    const bad = rs.filter((r) => !r.ok);
    total += rs.length;
    sourced += good.length;
    out.push(f.rel);
    if (bad.length === 0) {
      out.push(`  ✓ ${good.length} 条，全部有来源`);
    } else {
      if (good.length) out.push(`  ✓ ${good.length} 条规矩有来源标注`);
      out.push(`  ⚠ ${bad.length} 条可疑（没有来源）：`);
      for (const r of bad) out.push(`     L${r.line}  ${r.text}`);
    }
    out.push('');
  }
  if (!filesWithRules) out.push('  （没有扫到带强制性语气的规矩；见下方「局限」）\n');

  // 0 条时不能显示 100%——那读起来像"全都合规"，实际是"什么都没查"。
  const pct = total ? Math.round((sourced / total) * 100) : null;
  const suspicious = total - sourced;
  out.push(`汇总：${total} 条规矩，${sourced} 条有来源（${pct === null ? '—' : pct + '%'}），${suspicious} 条可疑`);
  out.push(`判据：没有来源标注的新规矩 = 可疑。跑 rulesource.mjs tag 补上。`);
  out.push(`扫描：${filesScanned.length} 个文件存在并已扫，其中 ${filesWithRules} 个文件有规矩。`);
  // 文件头的总来源声明不当作合规，但要提醒人：它不等于逐条标注。
  if (notes.length) {
    out.push('注意：以下文件只有文件级「来源」声明，它说不出哪条规矩是谁定的，仍按逐条标注判定：');
    for (const n of notes) out.push(`  · ${n.file}：${n.note.slice(0, 60)}`);
  }
  out.push('局限（诚实说明，本检查不假装 100% 准确）：');
  for (const l of LIMITS) out.push(`  · ${l}`);
  if (suspicious) {
    out.push('去向：可疑项按下面格式补标注（也可以让人工确认后删掉这条规矩）：');
    out.push('  node rulesource.mjs tag --file <文件> --line <行号> --from "用户 2026-11-08：「原话」"');
    out.push('  node rulesource.mjs tag --file <文件> --line <行号> --from "由 §3 推出"');
    out.push('  node rulesource.mjs tag --file <文件> --line <行号> --from "来源：docs/总纲.md §三"');
  } else {
    out.push('这次没有可疑项；规矩都能说出是谁定的。');
  }
  console.log(out.join('\n'));
  return suspicious;
}

function printJson(filesScanned, notes) {
  const byFile = new Map();
  for (const r of results) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }
  const files = filesScanned
    .map((f) => {
      const rs = byFile.get(f.rel) || [];
      return {
        file: f.rel,
        total: rs.length,
        sourced: rs.filter((r) => r.ok).length,
        suspicious: rs.filter((r) => !r.ok).map((r) => ({ line: r.line, text: r.text, fix: r.fix })),
      };
    })
    .filter((f) => f.total > 0);
  const total = results.length;
  const sourced = results.filter((r) => r.ok).length;
  console.log(JSON.stringify({
    ok: sourced === total,
    total, sourced, suspicious: total - sourced,
    percent: total ? Math.round((sourced / total) * 100) : 100,
    files, fileLevelSources: notes, limits: LIMITS,
  }, null, 2));
  return total - sourced;
}

// ---------- 入口 ----------

function usageOkHelp() { console.log(HELP); process.exit(0); }

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'tag') return runTag(argv);
  if (argv.includes('--help') || argv.includes('-h')) usageOkHelp();

  let asJson = false;
  const positional = [];
  for (const a of argv) {
    if (a === '--json') { asJson = true; continue; }
    if (a.startsWith('--') || a.startsWith('-')) usageError(`不认识参数「${a}」`);
    positional.push(a);
  }
  if (positional.length > 1) usageError('最多只能给一个项目根目录');
  const root = path.resolve(positional[0] || DEFAULT_ROOT);
  // 路径错了是用法错误，不是「规矩没守住」——两者不能混，否则用户看见一堆 ⚠
  // 却不知道其实是自己把目录写错了。
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    usageError(`项目根目录不存在或不是目录：${root}`);
  }

  const files = collectFiles(root);
  const notes = [];
  for (const f of files) {
    try {
      const note = scanFile(f);
      if (note) notes.push({ file: f.rel, note });
    } catch (e) {
      // 单个文件读不动不该让整份报告消失：说明原因，继续扫别的文件。
      console.error(`（${f.rel} 读不了：${e.message}；跳过）`);
    }
  }
  const suspicious = asJson ? printJson(files, notes) : printReport(files, notes);
  process.exit(suspicious ? 1 : 0);
}

main();
