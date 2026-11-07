#!/usr/bin/env node
/**
 * 网络重试配置 —— 改模型请求失败时重试几次、等多久。
 *
 * 为什么需要这个：
 *   手机网络会抖，代理会断，模型服务会限流。默认不重试的话，
 *   一次抖动就整个会话中断，用户看到的是"突然报错"。
 *
 * 引擎本身有重试（llm-retry 插件），默认参数是：
 *   5 次重试 · 针对 EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT
 *   退避 500ms → 10s · 抖动 10%
 *
 * 这个工具让你改成适合手机网络的参数，并写进 DSH 的设置文档。
 *
 * 用法：
 *   node netretry.mjs show                  看当前配置
 *   node netretry.mjs apply --profile mobile 套用预设（默认空跑）
 *   node netretry.mjs apply --profile mobile --go
 *   node netretry.mjs apply --max-attempts 8 --initial 800 --max 20000 --go
 *
 * 退出码：0 正常 / 1 有问题 / 2 用法错误
 */

import fs from 'node:fs';
import path from 'node:path';

// 空跑开关：默认只打印计划，加 --go 才真执行。
const GO = process.argv.includes('--go');
const argv = process.argv.slice(2).filter((a) => a !== '--go');

// 预设：不同网络环境下合理的参数。
//
// mobile 为什么这么设：手机网络切换（WiFi ↔ 4G）会短暂断流，
// 退避太长会让用户干等，太短会连续撞上同一波抖动。
// 1.2 秒起步、最多 8 次、上限 15 秒，实测能盖住大多数移动网络抖动。
const PROFILES = {
  default: {
    note: '引擎默认值，桌面网络够用',
    policy: null, // null = 不写配置，用引擎默认
  },
  mobile: {
    note: '手机网络：多试几次，退避从 1.2 秒起',
    policy: {
      mode: 'normal',
      maxAttempts: 8,
      backoff: { initialDelayMs: 1200, maxDelayMs: 15000, jitterRatio: 0.25 },
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    },
  },
  aggressive: {
    note: '不稳定网络：上限 12 次，退避拉长到 30 秒',
    policy: {
      mode: 'normal',
      maxAttempts: 12,
      backoff: { initialDelayMs: 1500, maxDelayMs: 30000, jitterRatio: 0.3 },
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    },
  },
  never: {
    note: '不重试：失败就立刻报错，适合调试',
    policy: {
      mode: 'never',
    },
  },
};

function usage() {
  console.error(`网络重试配置

用法：
  netretry.mjs show                          看当前配置和引擎默认值
  netretry.mjs apply --profile <名>          套用预设（默认空跑）
  netretry.mjs apply --profile <名> --go     真写入
  netretry.mjs apply --max-attempts N --initial MS --max MS --go  自定义

预设：
${Object.entries(PROFILES).map(([k, v]) => `  ${k.padEnd(12)} ${v.note}`).join('\n')}

退出码：0 正常 / 1 有问题 / 2 用法错误`);
  process.exit(2);
}

// 设置文档在哪：DSH 把用户设置写在 $DSH_HOME 下。
// 具体文件名要探测——不同版本可能叫 settings.yml / config.yml。
function findSettings() {
  const home = process.env.DSH_HOME;
  if (!home) {
    console.error('✗ 缺 DSH_HOME：它是引擎 home（通常 $DSH_IOS_DATA/../dsh）。');
    console.error('  没有它算不出设置文件在哪。不会静默猜一个路径。');
    process.exit(2);
  }
  const candidates = ['settings.yml', 'settings.yaml', 'config.yml', 'config.yaml', 'cordis.patch.yml'];
  for (const c of candidates) {
    const p = path.join(home, c);
    if (fs.existsSync(p)) return { path: p, name: c };
  }
  // 都没有 → 返回第一个候选作为待创建目标
  return { path: path.join(home, 'settings.yml'), name: 'settings.yml', create: true };
}

function show() {
  const s = findSettings();
  console.log('网络重试配置\n');
  console.log(`设置文件：${s.path}`);
  console.log(`  ${fs.existsSync(s.path) ? '存在' : '不存在（第一次写入时会创建）'}\n`);

  console.log('引擎默认（不写配置时）：');
  console.log('  重试次数    5');
  console.log('  可重试错误  EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT');
  console.log('  退避        500ms → 10s（指数）');
  console.log('  抖动        10%\n');

  if (fs.existsSync(s.path)) {
    const txt = fs.readFileSync(s.path, 'utf8');
    const m = txt.match(/retryPolicy:[\s\S]{0,400}/);
    if (m) {
      console.log('当前文件里的配置：');
      console.log('  ' + m[0].split('\n').slice(0, 10).join('\n  '));
    } else {
      console.log('当前文件里没有 retryPolicy → 用的是引擎默认值。');
    }
  }
  console.log('\n预设可选：' + Object.keys(PROFILES).join(' / '));
  process.exit(0);
}

function apply(opts) {
  let policy;
  let label;

  if (opts.profile) {
    const p = PROFILES[opts.profile];
    if (!p) {
      console.error(`✗ 没有这个预设：${opts.profile}`);
      console.error('  可选：' + Object.keys(PROFILES).join(' / '));
      process.exit(2);
    }
    policy = p.policy;
    label = `预设 ${opts.profile}（${p.note}）`;
  } else {
    // 自定义
    const maxAttempts = opts.maxAttempts ? parseInt(opts.maxAttempts, 10) : null;
    const initial = opts.initial ? parseInt(opts.initial, 10) : null;
    const max = opts.max ? parseInt(opts.max, 10) : null;
    if (!maxAttempts && !initial && !max) {
      console.error('✗ 要么给 --profile，要么至少给一个参数（--max-attempts / --initial / --max）');
      process.exit(2);
    }
    policy = {
      mode: 'normal',
      ...(maxAttempts ? { maxAttempts } : {}),
      ...(initial || max ? {
        backoff: {
          ...(initial ? { initialDelayMs: initial } : {}),
          ...(max ? { maxDelayMs: max } : {}),
          jitterRatio: 0.2,
        },
      } : {}),
    };
    label = '自定义';
  }

  if (policy === null) {
    console.log(`${label}：使用引擎默认值，不需要写配置。`);
    console.log('（想改成别的就用 --profile mobile / aggressive）');
    process.exit(0);
  }

  const s = findSettings();
  console.log(`网络重试 —— ${label}\n`);
  console.log(`  设置文件：${s.path}`);
  console.log(`  配置内容：`);
  console.log('    retryPolicy:');
  for (const [k, v] of Object.entries(policy)) {
    if (k === 'backoff') {
      console.log('      backoff:');
      for (const [bk, bv] of Object.entries(v)) console.log(`        ${bk}: ${bv}`);
    } else if (Array.isArray(v)) {
      console.log(`      ${k}:`);
      for (const c of v) console.log(`        - ${c}`);
    } else {
      console.log(`      ${k}: ${v}`);
    }
  }

  if (!GO) {
    console.log('\n   [空跑] 没有写入任何文件。');
    console.log('   加 --go 才会真执行。');
    process.exit(0);
  }

  // 真写：设置文件是 YAML，但要改的是 llm-pi-ai 段里的 retryPolicy。
  // 直接整文件重写风险太大（会冲掉用户的模型配置），
  // 所以这里只做「追加/替换 retryPolicy 块」这一件小事。
  let txt = fs.existsSync(s.path) ? fs.readFileSync(s.path, 'utf8') : '';

  // 缩进基准 2 空格：retryPolicy 是 llm-pi-ai 的直接子项。
  const block = [
    '  retryPolicy:',
    ...Object.entries(policy).flatMap(([k, v]) => {
      if (k === 'backoff') {
        return ['    backoff:', ...Object.entries(v).map(([bk, bv]) => `      ${bk}: ${bv}`)];
      }
      if (Array.isArray(v)) return [`    ${k}:`, ...v.map((c) => `      - ${c}`)];
      return [`    ${k}: ${v}`];
    }),
  ].join('\n');

  if (/retryPolicy:[\s\S]*?(?=\n\s{0,4}\S|\n*$)/.test(txt)) {
    txt = txt.replace(/retryPolicy:[\s\S]*?(?=\n\s{0,4}\S|\n*$)/, block);
    console.log('\n✓ 已替换现有的 retryPolicy');
  } else if (/llm-pi-ai:/.test(txt)) {
    txt = txt.replace(/(llm-pi-ai:\s*\n)/, `$1${block}\n`);
    console.log('\n✓ 已加进 llm-pi-ai 段');
  } else {
    // 新建时只写 retryPolicy，不自己造 providers 段。
    // 原来写了 `providers: {}` 再加 retryPolicy，缩进会变成
    //   llm-pi-ai:
    //     providers: {}
    //       retryPolicy:     ← 成了 providers 的子级，无效 YAML
    // 交给 DSH 自己的设置页去建 providers 更安全。
    txt += `\nllm-pi-ai:\n${block}\n`;
    console.log('\n✓ 已新建 llm-pi-ai 段');
  }

  fs.mkdirSync(path.dirname(s.path), { recursive: true });
  fs.writeFileSync(s.path, txt, 'utf8');
  console.log(`   写入：${s.path}`);
  console.log('\n⚠ 要重启 App 才生效（引擎只在启动时读设置）。');
  process.exit(0);
}

// ---------- 入口 ----------
const cmd = argv[0];
if (!cmd || cmd === '--help' || cmd === '-h') usage();

if (cmd === 'show') show();

if (cmd === 'apply') {
  const opts = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') opts.profile = argv[++i];
    else if (a === '--max-attempts') opts.maxAttempts = argv[++i];
    else if (a === '--initial') opts.initial = argv[++i];
    else if (a === '--max') opts.max = argv[++i];
    else {
      console.error(`✗ 不认识的参数：${a}`);
      usage();
    }
  }
  apply(opts);
}

console.error(`✗ 不认识的命令：${cmd}`);
usage();
