#!/usr/bin/env node
// 让 AI 做好的网页/图片在 App 里直接弹出来，不用用户自己复制地址去开。
//
// 为什么需要它：AI 生成一个 html 之后，此前唯一的呈现方式是「把源码贴在回复里」，
// 用户还得复制、存文件、找浏览器。App 里本来就有 WebView 和文件预览，
// 缺的只是「引擎能主动叫 App 打开」这一条线。
//
// 用法：
//   node preview.mjs open <文件路径> [--title "标题"]
//   node preview.mjs list                 列出工作区里可预览的网页
//
// 默认空跑（只打印会做什么），加 --go 才真的发给 App。
// 退出码：0 正常 / 1 有问题 / 2 用法错误

import fs from 'node:fs';
import path from 'node:path';

const GO = process.argv.includes('--go');
const argv = process.argv.slice(2).filter((a) => a !== '--go');
const [command, ...rest] = argv;

/// 可以预览的扩展名。和 App 侧 FileRenderer.candidates 对齐。
const PREVIEWABLE = new Set(['.html', '.htm', '.xhtml', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.md']);

function usage() {
  console.log(`用法：
  node preview.mjs open <文件路径> [--title "标题"] [--go]
  node preview.mjs list [目录]

默认空跑：只打印会做什么，不加 --go 不会真的弹。`);
  process.exit(2);
}

/// 把用户/模型给的路径解析成绝对路径。相对路径按当前工作目录算。
function resolveTarget(input) {
  const absolute = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
  if (!fs.existsSync(absolute)) return { error: `文件不存在：${input}` };
  const stat = fs.statSync(absolute);
  if (stat.isDirectory()) return { error: `这是一整个目录，请给具体文件：${input}` };
  const ext = path.extname(absolute).toLowerCase();
  if (!PREVIEWABLE.has(ext)) {
    return { error: `${ext || '（无扩展名）'} 不能预览。能预览的：${[...PREVIEWABLE].join(' ')}` };
  }
  return { absolute, size: stat.size };
}

/// 发给 App。走 parentPort —— 和 auto-guard 的提醒同一条通道。
function notify({ absolute, title }) {
  const message = { type: 'dsh-ios/preview', path: absolute, title: title ?? path.basename(absolute) };
  try {
    if (typeof process !== 'undefined' && process.parentPort) {
      process.parentPort.postMessage(message);
      return true;
    }
  } catch { /* 桌面/CLI 跑时没有 parentPort */ }
  return false;
}

function open(args) {
  const titleIndex = args.indexOf('--title');
  const title = titleIndex >= 0 ? args[titleIndex + 1] : undefined;
  const target = args.find((a, i) => !a.startsWith('--') && (titleIndex < 0 || i !== titleIndex + 1));
  if (!target) usage();

  const resolved = resolveTarget(target);
  if (resolved.error) {
    console.error(`✗ ${resolved.error}`);
    process.exit(1);
  }

  const name = title ?? path.basename(resolved.absolute);
  const size = (resolved.size / 1024).toFixed(1);
  console.log(`将打开：${resolved.absolute}`);
  console.log(`  标题：${name}`);
  console.log(`  大小：${size} KB`);

  if (!GO) {
    console.log('\n（空跑。加 --go 才会真的在 App 里弹出预览。）');
    return;
  }

  if (notify({ absolute: resolved.absolute, title: name })) {
    console.log('\n✓ 已发送给 App，预览应该马上弹出来。');
  } else {
    // 不在 App 里跑（桌面 dsh、CI）：给一条能手动执行的替代路径，
    // 不然调用方会以为「没输出=失败了」。
    console.log('\n○ 当前不在 App 里运行（没有 parentPort），没法弹预览。');
    console.log(`  手动打开：file://${resolved.absolute}`);
  }
}

function list(args) {
  const dir = path.resolve(args[0] ?? process.cwd());
  if (!fs.existsSync(dir)) {
    console.error(`✗ 目录不存在：${dir}`);
    process.exit(1);
  }
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!PREVIEWABLE.has(ext)) continue;
    const full = path.join(dir, entry.name);
    found.push({ name: entry.name, size: fs.statSync(full).size });
  }
  if (found.length === 0) {
    console.log(`${dir} 里没有可预览的文件。`);
    return;
  }
  console.log(`${dir} 里可预览的 ${found.length} 个：`);
  for (const file of found.sort((a, b) => b.size - a.size)) {
    console.log(`  ${(file.size / 1024).toFixed(1).padStart(8)} KB  ${file.name}`);
  }
}

switch (command) {
  case 'open':
    open(rest);
    break;
  case 'list':
    list(rest);
    break;
  default:
    usage();
}
