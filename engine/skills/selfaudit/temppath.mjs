#!/usr/bin/env node
/**
 * 临时文件落点 —— 把「只准放三个地方」从规矩变成会失败的工具。
 *
 * 为什么要有它：Agent 干活会不断掉出临时文件（构建物、证据、一次性中间物）。
 * 靠自觉分类，三个月后工作区一定退化成垃圾堆；所以这里不写建议，
 * 而是「算出唯一落点 + 建好目录 + 能 exit 非 0 地判违规」。
 *
 * 三类落点（判据只在这一个文件里定义，避免两处判据给出两份结论）：
 *   大体积（>10MB 产物/缓存/构建物） → <工作区>/_临时/            用完就清
 *   留存（证据/日志/快照）           → <DSH根>/workspace/_临时/<会话-时间>/  能追溯
 *   一次性（编译中间物/下载的包）     → 系统临时目录                 重启就没了
 *
 * 诚实说明（必须出现在输出里）：这套判定只看名字和后缀，
 * 叫 abc 的垃圾它看不见。不写清这一点，使用者会误以为「扫干净 = 真干净」。
 *
 * 用法：
 *   node temppath.mjs --big                 打印并创建大体积目录
 *   node temppath.mjs --keep --name 构建日志 打印并创建留存目录
 *   node temppath.mjs --name 中间结果       打印并创建一次性目录（默认模式）
 *   node temppath.mjs --check /path/to/file 判路径是否落在允许区
 *   node temppath.mjs --scan ./            扫描允许区之外的疑似临时文件
 *
 * 退出码：0 没问题 / 1 发现违规 / 2 用法错误（含前置环境变量缺失）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 盲区只留一处文案，保证每种输出说法一致，不会哪次调用忘了写。
// 为什么必须写进输出：机制要诚实，隐瞒盲区比没有机制更危险。
const 盲区说明 = '这条规则只看名字和后缀，叫 abc 的垃圾看不见。';
const 退出 = { 没问题: 0, 违规: 1, 用法: 2 };

// 判据唯一出处：一条规则 = 一个判定 + 一个给人看的原因。
// 为什么用数组而不是散落的 if：--scan 和 --check 要共用同一份判据，
// 否则「扫出来的」和「判合规的」会慢慢长成两套标准。
const 嫌疑规则 = [
  // .tar.gz 必须单独列在前面：extname() 只认最后的 .gz，双后缀会被漏看。
  { 命中: (n) => n.toLowerCase().endsWith('.tar.gz'), 原因: () => '后缀 .tar.gz' },
  ...['.bak', '.tmp', '.orig', '.log', '.zip'].map((ext) => ({
    命中: (n) => n.toLowerCase().endsWith(ext),
    原因: () => `后缀 ${ext}`,
  })),
  { 命中: (n) => n.endsWith('~'), 原因: () => '~ 结尾' },
  // 关键词刻意用最朴素的「包含」判断：这正是盲区的来源，不做聪明修正，
  // 免得使用者以为它能看懂语义。
  ...['副本', '备份', '临时', 'test', 'debug'].map((词) => ({
    命中: (n) => n.toLowerCase().includes(词.toLowerCase()),
    原因: () => `名字含「${词}」`,
  })),
];

// 返回第一个命中原因，没命中返回 null。只报文件、不报目录名：
// 需求是「临时文件」，目录名带「备份」这种先不判，避免把整个证据目录误杀。
function 判嫌疑(文件名) {
  for (const r of 嫌疑规则) if (r.命中(文件名)) return r.原因();
  return null;
}

function 用法(错因) {
  // 用法错误打到 stderr：让调用方一眼分清「我写错了」和「规矩没守住」。
  // 说明文案复用 --help 那一份，避免两处说明慢慢长成两个版本。
  if (错因) console.error(`✗ 用法错误：${错因}\n`);
  console.error(用法说明());
  process.exit(退出.用法);
}

// 参数解析：一个调用只能有一个模式，混用就是用法错误而不是「猜一个」。
// 为什么严格：两个模式同时给还装作能跑，输出就没法被脚本信任。
function 解析参数(argv) {
  const 选项 = { big: false, keep: false, check: null, scan: null, name: null, session: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      const 文本 = 用法说明();
      console.log(文本);
      process.exit(退出.没问题);
    }
    if (['--big', '--keep'].includes(a)) {
      选项[a === '--big' ? 'big' : 'keep'] = true;
      continue;
    }
    if (['--check', '--scan', '--name', '--session'].includes(a)) {
      const 值 = argv[++i];
      // 缺值、或下一个还是开关，都算用法错误；不然会把开关名当文件名用。
      if (值 === undefined || 值.startsWith('--')) 用法(`「${a}」后面要跟一个值`);
      const 键 = a.slice(2);
      选项[键] = 值;
      continue;
    }
    用法(`不认识的参数：${a}`);
  }

  const 模式数 = ['big', 'keep', 'check', 'scan'].filter((k) => 选项[k]).length;
  if (模式数 > 1) 用法('--big / --keep / --check / --scan 一次只能用一个');
  // --name / --session 只服务于「算落点」，跟检查/扫描混用没有意义，直接拒绝。
  if ((选项.check || 选项.scan) && (选项.name || 选项.session)) {
    用法('--name / --session 不能和 --check / --scan 一起用');
  }
  return 选项;
}

// --help 走 stdout、exit 0，和用法错误（stderr、exit 2）分开。
function 用法说明() {
  return [
    '临时文件落点 —— 用法',
    '',
    '  --big                 大体积目录（>10MB 产物，用完就清）',
    '  --keep                留存目录（证据/日志/快照，按会话分层）',
    '  （不给模式）          一次性目录（系统临时目录）',
    '  --name <名>           给落点加一段可读名字',
    '  --session <id>        --keep 时指定会话 id',
    '  --check <路径>        判路径是否合规：0 合规 / 1 不合规',
    '  --scan <目录>         扫允许区外的疑似临时文件',
    '',
    '  环境变量：DSH_IOS_DATA 指向 App 数据目录（如 /home/dsh/.ios），--keep 必需；',
    '            DSH_HOME 指向引擎 home，本工具不依赖它。',
    '',
    '  退出码：0 没问题 / 1 发现违规 / 2 用法错误。',
    '',
    `  → 注意：${盲区说明}`,
  ].join('\n');
}

// ---------- 三个允许区：所有路径判定只从这里取 ----------

// 为什么单独封一层函数：--check 和 --scan 必须共用同一份「哪里算合规」，
// 否则两份判定迟早给出相反结论，工具就没人敢信。

// 缺环境变量时统一在这里喊一次：stdout 的输出可以给人看，但 stderr 必须
// 明确报错说出「需要什么」，否则「没静默用错路径」这件事只有读输出的眼睛才知道，
// 日志和自动化拿不到信号。DSH_HOME 一并列出，免得用户只补一半。
function 警告缺环境(大, 用途) {
  if (!大.退化) return;
  console.error(`⚠ 环境变量缺失：需要 DSH_IOS_DATA（指向 App 数据目录，如 /home/dsh/.ios）；${用途}要靠它算真实落点。`);
  console.error('  另外 DSH_HOME 指向引擎 home（本工具不依赖它），DSH_SESSION_ID 可指定会话 id。');
  console.error('  本次不会静默换成 iOS 真实路径，下面给出的是退化后的判定结果。');
}

/**
 * 大体积区。约定是 $DSH_IOS_DATA/../workspace/_临时。
 * 题目允许「拿不到就退到当前目录的 _临时」——但退化必须喊出来，
 * 静默换个根会让脚本以为东西存进了 iOS 数据区，实际落在别处。
 */
function 大体积区() {
  const 数据目录 = process.env.DSH_IOS_DATA;
  if (数据目录) {
    return { 根: path.resolve(数据目录, '..', 'workspace', '_临时'), 退化: null };
  }
  return {
    根: path.resolve(process.cwd(), '_临时'),
    退化: '没拿到 DSH_IOS_DATA（应指向 App 数据目录，如 /home/dsh/.ios），已退化到当前目录的 _临时/。要真实 iOS 路径请设置它。',
  };
}

// 时间戳本地生成，不引第三方库：本机没有 npm，也不该为格式化一个目录名装东西。
function 时间戳() {
  const d = new Date();
  const 二 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${二(d.getMonth() + 1)}${二(d.getDate())}-${二(d.getHours())}${二(d.getMinutes())}${二(d.getSeconds())}`;
}

// 会话名要拼进路径，先掐掉路径分隔符和控制字符：
// 否则 --session ../../etc 能把文件写到允许区外面去。
function 清洗名字(名) {
  return String(名).replace(/[\/\\\0-\x1f]/g, '_').replace(/^\.+$/, '_').slice(0, 60) || '未命名';
}

function 会话戳(选项) {
  const 会话 = 选项.session || process.env.DSH_SESSION_ID || process.env.DSH_SESSION || '会话';
  return `${清洗名字(会话)}-${时间戳()}`;
}

/** 留存区：大体积区下面再按「会话-时间」分层，带上下文才追溯得到。 */
function 留存区(选项, 大) {
  return path.join(大.根, 会话戳(选项));
}

/**
 * 一次性根目录。用 realpath 是因为 /tmp 常是符号链接（macOS 尤甚）。
 * 注意：/tmp 是「一次性文件该放哪」这个目的地，不是「/tmp 下任意后代都合规」的豁免区；
 * 合规判定由下面的 属于允许区() 统一负责，避免 /tmp 下的工作区整片被放过。
 */
function 一次性根() {
  const t = os.tmpdir();
  try { return fs.realpathSync(t); } catch { return path.resolve(t); }
}

// realpath 失败（路径还不存在）时退回规范化绝对路径，保证包含判断仍能做。
function 实路径(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function 在区内(目标, 根) {
  const 相对 = path.relative(实路径(根), 实路径(目标));
  // .. 开头或绝对路径 = 不在根下；其余（含相等）算在区内。
  return 相对 === '' || (!相对.startsWith('..' + path.sep) && 相对 !== '..' && !path.isAbsolute(相对));
}

// evidence/ 是项目既有规矩（selfaudit.mjs 的 R3 就写「要留证据就改名放 evidence/」）。
// 不承认它，两个工具会给出互相矛盾的指令；所以把它视作留存区在工作目录里的等价物。
function 在证据区内(目标) {
  const 段 = 实路径(目标).split(path.sep);
  return 段.some((s) => s.toLowerCase() === 'evidence');
}

/** 一次性落点：就是系统临时目录本身，由 mkdtemp 在其中造专用随机目录。 */
function 一次性区() { return 一次性根(); }

/**
 * 合规判定：路径是否落在三个允许区里。--check 和 --scan 共用这一份判据，
 * 不各写一套 —— 两处判据 = 两份结论 = 早晚打架。
 */
function 属于允许区(目标, 大, 工作区根 = process.cwd()) {
  // ① 大体积/留存区：$DSH_IOS_DATA/../workspace/_临时/ 的整棵子树；
  //    退化时它就是 <当前工作区>/_临时/，仍算同一个区。
  if (在区内(目标, 大.根)) return true;
  // ② <工作区>/_临时/ 与 ./evidence/：题目输出示例里的两个本地允许区。
  //    evidence/ 也是 selfaudit.mjs R3 写的「要留证据就改名放 evidence/」，
  //    不承认它，两个工具会给出互相矛盾的指令。
  if (在区内(目标, path.join(工作区根, '_临时'))) return true;
  if (在区内(目标, path.join(工作区根, 'evidence'))) return true;
  if (在证据区内(目标)) return true;
  // ③ 一次性区：/tmp 的直接子项（一次性文件本来就放这儿），以及 mkdtemp
  //    造的专用临时目录（fp-xxx / tmpXXXXXX 这类随机名）。
  //    为什么不给 /tmp 整片豁免：mktemp -d /tmp/xxx 建出来的工作区也在 /tmp 下，
  //    若按前缀放行，--check 会把「工作区里的 .bak」判成合规、--scan 会整棵跳过，
  //    检查就永远 exit 0 —— 正好退化成「不会失败的检查 = 一句口号」。
  const t = 一次性根();
  const 实 = 实路径(目标);
  if (!在区内(实, t)) return false;
  const 相对 = path.relative(t, 实);
  if (!相对 || 相对 === '..' || 相对.startsWith('..' + path.sep)) return false;
  if (!相对.includes(path.sep)) return true; // /tmp 的直接子项：一次性文件本来就放这儿
  const 首 = 相对.split(path.sep)[0];
  // 再往里只认 mkdtemp 造的专用临时目录。
  //
  // 这里原来还放行了 /^tmp[a-zA-Z0-9._-]*$/i —— 相当于「凡是以 tmp 开头的目录
  // 整棵子树都算合规」。实测 mktemp -d 造的 /tmp/tmp.bjoMkK 正好命中这条，
  // 于是它下面的 src/app.mjs.bak 被判成合规、--check 返回 0。
  // 那正好是「不会失败的检查 = 一句口号」。
  // 现在只认 fp- 前缀（本工具自己 mkdtempSync 造的），其余一律按工作区对待。
  return /^fp-/.test(首);
}

// ---------- 落点模式：算出来 + 真的建好 ----------

function 建目录(p) {
  // recursive: true 是必须的：留存区有多层（会话/时间/名字），父目录未必存在。
  fs.mkdirSync(p, { recursive: true });
}

function 落点规则(类型) {
  if (类型 === '大体积') return [
    '放这里的规则：',
    '  · 用完就清，不要留超过一天',
    '  · 命名带上是什么：build-20261108.zip 而不是 a.zip',
    '  · 只放大体积产物/缓存/构建物，证据别混进来',
  ];
  if (类型 === '留存') return [
    '放这里的规则：',
    '  · 一层会话-时间就是一个上下文，别把不同会话的证据混在一起',
    '  · 命名带上是什么和什么时候：构建日志-20261108.log 而不是 a.log',
    '  · 要留就留能追溯的：原始输出、快照、日志；不要放可直接重建的中间物',
  ];
  return [
    '放这里的规则：',
    '  · 编译中间物、下载的包这类一次性东西放这儿',
    '  · 系统临时目录会被清理，别把要留的证据放这儿',
    '  · 用完不用手动删，但别在这一层之上再堆长期文件',
  ];
}

// 所有正常输出都带这一行盲区说明：不写出来，使用者会误以为「扫干净 = 真干净」。
function 打盲区() {
  console.log(`  → 注意：${盲区说明}`);
}

function 出落点(选项) {
  const 类型 = 选项.keep ? '留存' : (选项.big ? '大体积' : '一次性');
  const 大 = 大体积区();

  // --keep 明确要求 iOS 真实路径：没有 DSH_IOS_DATA 就报错，绝不静默退化。
  // 为什么单独卡这一条：留存目录要靠会话层追溯，退化到 cwd 会让「哪个 App 数据区」
  // 这个信息永久丢失，比大体积文件的退化危险得多。
  if (选项.keep && 大.退化) {
    console.error('✗ 缺少环境变量：需要 DSH_IOS_DATA（指向 App 数据目录，如 /home/dsh/.ios）。');
    console.error('  --keep 要往 $DSH_IOS_DATA/../workspace/_临时/<会话-时间>/ 写，没有它就算不出真实落点；');
    console.error('  本工具不会静默换成别的路径。另外 DSH_HOME 指向引擎 home（本工具不依赖它），');
    console.error('  DSH_SESSION_ID 可指定会话 id。请设置 DSH_IOS_DATA 后重试。');
    process.exit(退出.用法);
  }

  let 目标;
  if (类型 === '大体积') 目标 = 大.根;
  else if (类型 === '留存') 目标 = 留存区(选项, 大);
  else 目标 = null; // 一次性目录在下面用 mkdtemp 单独生成

  // --name 的两种用法：留存/大体积把它拼成一层可读子目录（workspace 下能建中文名）；
  // 一次性只当标签打印——系统临时目录下中文/特殊字符目录名不保证能建（题目特别提醒过），
  // 所以那里改用 mkdtemp 的随机 ASCII 目录，名字只出现在输出里不进路径。
  if (选项.name && 类型 !== '一次性') 目标 = path.join(目标, 清洗名字(选项.name));

  if (类型 === '一次性') {
    const 临时根 = 一次性区();
    // mkdtempSync 自带随机后缀：同一秒跑十次也不会互相覆盖，且天然「重启就没了」。
    目标 = fs.mkdtempSync(path.join(临时根, 'fp-'));
  } else {
    建目录(目标);
  }

  console.log(`临时路径 —— ${类型}${选项.name ? `（${选项.name}）` : ''}`);
  console.log(`  目标：${目标}${path.sep}`);
  if (类型 === '一次性') console.log('  ✓ 已创建（系统临时目录，重启就没了）');
  else console.log('  ✓ 已创建');

  // 退化必须显眼，不能藏在一行长输出里让人扫过去。
  if (大.退化 && 类型 !== '一次性') {
    警告缺环境(大, '大体积/留存落点');
    console.log('');
    console.log(`  ⚠ ${大.退化}`);
  }
  console.log('');
  for (const 行 of 落点规则(类型)) console.log(行);
  console.log('');
  console.log(`  三个允许区：${大.根}${path.sep}（大体积/留存） , ${一次性区()}${path.sep}（一次性）`);
  打盲区();
  process.exit(退出.没问题);
}

// ---------- --check：判一个路径是否合规 ----------

function 建议落点(文件) {
  const n = path.basename(文件).toLowerCase();
  // 只是启发式建议，不是判据：判据只有「在不在允许区」这一条。
  if (/\.(log|zip|tar\.gz)$/.test(n) || /副本|备份|快照|证据/.test(n)) return '留存/大体积区';
  if (/\.(tmp|bak|orig)$/.test(n) || /临时|test|debug/.test(n)) return '系统临时目录';
  return '系统临时目录（一次性）或大体积区（产物）';
}

function 出检查(路径参数) {
  const 目标 = path.resolve(路径参数);
  const 大 = 大体积区();
  const 临 = 一次性区();
  const 命中 = [];
  if (属于允许区(目标, 大)) {
    // 差异集合要能定位：说出命中的是哪一条允许区，而不是只给 0/1。
    if (在区内(目标, 大.根)) 命中.push(`大体积/留存区 ${大.根}${path.sep}`);
    if (在区内(目标, path.join(process.cwd(), '_临时')) || 在区内(目标, path.join(process.cwd(), 'evidence')) || 在证据区内(目标)) 命中.push('本地允许区 ./_临时/ 或 ./evidence/');
    if (!命中.length) 命中.push(`一次性区 ${临}${path.sep} 的直接子项/专用临时目录`);
  }

  console.log(`临时路径 —— 检查 ${路径参数}`);
  if (大.退化) 警告缺环境(大, '合规判定');
  console.log(`  允许区：${大.根}${path.sep} , evidence/（留存证据） , ${临}${path.sep}`);

  if (命中.length) {
    console.log(`  ✓ 合规：落在 ${命中.join('；')}`);
    打盲区();
    process.exit(退出.没问题);
  }

  console.log(`  ✗ 不合规：不在任何一个允许区里`);
  console.log('');
  console.log('  该放哪：');
  console.log(`  · 大体积产物/缓存/构建物 → ${大.根}${path.sep}（用完就清）`);
  console.log(`  · 有价值的证据/日志/快照 → ${大.根}${path.sep}<会话-时间>/（带上下文，能追溯）`);
  console.log(`  · 一次性中间物/下载的包   → ${临}${path.sep}（重启就没了）`);
  console.log(`  · 按名字粗判，这份东西更像该放：${建议落点(目标)}`);
  打盲区();
  process.exit(退出.违规);
}

// ---------- --scan：扫允许区之外的疑似临时文件 ----------

// 只报文件不报目录；跳过版本库和依赖目录，避免扫出成百上千条无关条目，
// 把真正的违规淹掉（输出要说「差异集合」，不是倒一车垃圾）。
const 跳过目录 = new Set(['.git', 'node_modules', '.svn', '.hg']);

function 收集违规(根, 大, 剪枝集合) {
  const 结果 = [];
  function 走(目录) {
    let 条目;
    try { 条目 = fs.readdirSync(目录, { withFileTypes: true }); }
    catch { return; } // 没权限的子目录跳过比中断好：扫描要给出能看的差异集合
    for (const e of 条目) {
      const 全 = path.join(目录, e.name);
      // 只有「扫描根内部的允许子目录」才整棵剪掉；/tmp 下的普通工作区
      // 不剪 —— 否则任何 mktemp -d 工作区都会让扫描永远 exit 0。
      if (剪枝集合.some((r) => 在区内(全, r))) continue;
      if (e.isDirectory()) {
        if (跳过目录.has(e.name)) continue;
        走(全);
      } else if (e.isFile()) {
        // 允许区里的文件即使名字可疑也不算违规：它已经放对地方了。
        // 这里和 --check 共用 属于允许区()，不另写一套标准。
        if (属于允许区(全, 大, 根)) continue;
        const 原因 = 判嫌疑(e.name);
        if (!原因) continue;
        结果.push({ 相对: path.relative(根, 全), 原因 });
      }
    }
  }
  走(根);
  return 结果;
}

function 出扫描(目录参数) {
  const 根 = path.resolve(目录参数);
  try {
    if (!fs.statSync(根).isDirectory()) { console.error(`✗ 不是目录：${根}`); process.exit(退出.用法); }
  } catch { console.error(`✗ 路径不存在：${根}`); process.exit(退出.用法); }

  const 大 = 大体积区();
  const 临 = 一次性区();
  // 允许区按「扫描根的工作区」来算，而不是按扫描根本身：
  // 扫描 `_临时` 时，工作区是它的父目录，不是 `_临时/_临时`。
  const 根名 = path.basename(根).toLowerCase();
  const 工作区根 = (根名 === '_临时' || 根名 === 'evidence') ? path.dirname(根) : 根;
  const 本地区 = path.join(工作区根, '_临时');
  const 证据区 = path.join(工作区根, 'evidence');

  const 剪枝集合 = [实路径(本地区), 实路径(证据区), 实路径(大.根)];
  // 只有当扫描根【就是】允许区本身（或整个落在里面）时才跳过：
  //   ① 系统临时目录本身
  //   ② iOS 大体积/留存区
  //   ③ <工作区>/_临时 或 <工作区>/evidence —— 原来漏了这两条，
  //      于是 `--scan _临时` 会拿 `_临时/_临时` 当允许区，把里面的文件全判违规。
  const 本地区自身 = 实路径(根) === 实路径(本地区) || 实路径(根) === 实路径(证据区);
  // 整个允许区被当成扫描目标时，直接说"这里本来就是允许区"，
  // 不去扫它内部 —— 否则里面每个文件都会按"允许区外"判违规。
  if (实路径(根) === 实路径(临) || 在区内(根, 大.根) || 本地区自身) {
    console.log(`临时路径 —— 扫描 ${目录参数}`);
    console.log('  ✓ 整个目录就在允许区里，跳过扫描');
    打盲区();
    process.exit(退出.没问题);
  }
  const 违规 = 收集违规(根, 大, 剪枝集合);

  // 允许区的打印跟着扫描目录走（示例里的 ./_临时/ ./evidence/），
  // 绝对路径的 iOS 落点单独列一行，免得两处路径看着打架。
  console.log(`临时路径 —— 扫描 ${目录参数}`);
  console.log(`  允许区：./_临时/ , ./evidence/ , ${临}${path.sep}`);
  console.log(`  iOS 落点：${大.根}${path.sep}（大体积/留存）`);
  if (大.退化) 警告缺环境(大, '扫描的允许区');

  if (违规.length) {
    console.log(`  ⚠ ${违规.length} 个疑似临时文件在允许区外：`);
    // 差异集合要给全，但排个序让人能按目录定位，不要靠运气翻。
    for (const v of 违规.sort((a, b) => a.相对.localeCompare(b.相对))) {
      console.log(`     ${v.相对.padEnd(36)} (${v.原因})`);
    }
    console.log(`  → 有价值的挪进 ./evidence/ 或 ${大.根}${path.sep}<会话-时间>/，没价值的删掉。`);
    打盲区();
    process.exit(退出.违规);
  }

  console.log('  ✓ 没有发现违规的临时文件');
  打盲区();
  process.exit(退出.没问题);
}

// ---------- 入口 ----------
const 选项 = 解析参数(process.argv.slice(2));
if (选项.check) 出检查(选项.check);
else if (选项.scan) 出扫描(选项.scan);
else 出落点(选项);
