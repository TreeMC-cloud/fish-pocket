#!/usr/bin/env node
/**
 * win-pc —— 连用户自己的 Windows 电脑。
 *
 * 设计取舍：
 *   1. **配置存文件**（默认 `$DSH_IOS_DATA/win-pc.json`），不存记忆库。
 *      令牌是凭据，不该进会每轮注入的上下文。
 *   2. **只用 Node 内置模块**。这个脚本要在 iPhone 的引擎里跑，
 *      多引一个包就多一份装不上的风险。
 *   3. **超时短**（5s 连接 / 30s 请求）。局域网里慢到几十秒，
 *      基本就是不在同一网段，等下去只会让用户以为卡死。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import process from 'node:process';

const DATA = process.env.DSH_IOS_DATA || path.join(os.homedir(), '.ios');
const CFG = process.env.DSH_WIN_PC_CONFIG || path.join(DATA, 'win-pc.json');

function load() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { return null; }
}
function save(cfg) {
  fs.mkdirSync(path.dirname(CFG), { recursive: true });
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** 统一的请求封装：带令牌、限时、错误说人话。 */
async function call(cfg, route, body) {
  const url = cfg.url.replace(/\/+$/, '') + '/' + route;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${cfg.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json.data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('请求超时：电脑没响应，确认客户端还开着、且在同一网络');
    if (String(error.message).includes('fetch failed')) {
      throw new Error(`连不上 ${cfg.url}：可能不在同一 Wi-Fi，或 Windows 防火墙拦了`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 局域网广播扫描：客户端每 3 秒往 x.y.z.255:8099 发一次 JSON。 */
function scan(ms = 5000) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (buf, rinfo) => {
      try {
        const m = JSON.parse(buf.toString('utf8'));
        if (m.service !== 'sigma-win') return;
        found.set(`${rinfo.address}:${m.port}`, { ...m, address: rinfo.address });
      } catch { /* 不是我们的包 */ }
    });
    sock.on('error', () => {});
    sock.bind(8099, () => {
      try { sock.setBroadcast(true); } catch { /* 某些网卡不支持 */ }
    });
    setTimeout(() => {
      try { sock.close(); } catch { /* 已关 */ }
      resolve([...found.values()]);
    }, ms);
  });
}

function readStdin() {
  return new Promise((r) => {
    let s = '';
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => r(s.trim()));
    setTimeout(() => r(s.trim()), 500);
  });
}

const [cmd, ...rest] = process.argv.slice(2);
const arg = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const pos = rest.filter((x) => !x.startsWith('--'));

function need() {
  const cfg = load();
  if (!cfg?.url || !cfg?.token) {
    console.error('还没连过电脑。先运行：pc.mjs connect --url <地址> --token <令牌>');
    process.exit(2);
  }
  return cfg;
}

try {
  if (cmd === 'connect') {
    // 两种模式：--url 直连，--code 走中继
    const code = arg('--code');
    const relay = arg('--relay') || 'http://202.189.51.44:8791';
    let url = arg('--url');
    const token = arg('--token');
    if (code) url = relay.replace(/\/+$/, '') + '/c/' + String(code).toUpperCase();
    if (!url || !token) throw new Error('用法：connect --url <地址> --token <令牌>  或  connect --code <配对码> --token <令牌>');
    const cfg = { url: url.replace(/\/+$/, ''), token, connectedAt: Date.now() };
    // 先验证再存：存下一个连不上的地址，后面每次都要重来。
    const info = await call(cfg, 'info');
    save(cfg);
    console.log(`已连接：${info.name}（${info.platform} ${info.arch}，${info.cpus} 核 / ${info.memGB}GB）`);
  } else if (cmd === 'status') {
    const cfg = load();
    if (!cfg) { console.log('未连接'); process.exit(0); }
    console.log(`地址 ${cfg.url}`);
    console.log(`令牌 ${String(cfg.token).slice(0, 6)}…（其余已隐藏）`);
    try {
      const info = await call(cfg, 'info');
      console.log(`状态 在线 · ${info.name} · ${info.platform} ${info.arch} · ${info.cpus} 核 / ${info.memGB}GB`);
    } catch (e) { console.log(`状态 离线（${e.message}）`); }
  } else if (cmd === 'scan') {
    const list = await scan();
    if (list.length === 0) console.log('局域网里没找到客户端（确认它开着，且在同一个 Wi-Fi）');
    else for (const d of list) console.log(`http://${d.address}:${d.port}  ${d.name}  ${d.platform}`);
  } else if (cmd === 'info') {
    console.log(JSON.stringify(await call(need(), 'info'), null, 2));
  } else if (cmd === 'ls') {
    const p = pos[0] || '.';
    const d = await call(need(), 'list', { path: p });
    console.log(`${d.path}（${d.count} 项）`);
    for (const it of d.items) {
      console.log(`${it.dir ? 'DIR ' : '    '} ${String(it.size).padStart(10)}  ${it.name}`);
    }
  } else if (cmd === 'read') {
    const d = await call(need(), 'read', { path: pos[0] });
    console.log(d.truncated ? `（已截断，完整 ${d.size} 字节）` : `（${d.size} 字节）`);
    console.log(d.content);
  } else if (cmd === 'write') {
    const p = pos[0];
    let content = arg('--content');
    const from = arg('--from');
    if (from) content = fs.readFileSync(from, 'utf8');
    if (content === undefined) throw new Error('用法：write <路径> --content "内容" 或 --from <本地文件>');
    const d = await call(need(), 'write', { path: p, content });
    console.log(`已写入 ${d.path}（${d.bytes} 字节）`);
  } else if (cmd === 'run') {
    // 执行任意命令（走 shell，支持管道/重定向）
    const command = pos.join(' ') || arg('--command');
    if (!command) throw new Error('用法：run "命令"');
    const d = await call(need(), 'exec', { command, timeoutMs: Number(arg('--timeout')) || 60000 });
    if (d.stdout) process.stdout.write(d.stdout);
    if (d.stderr) process.stderr.write(d.stderr);
    console.error(`（${d.ok ? 'ok' : '失败'} · 退出码 ${d.code} · ${d.ms}ms）`);
    if (!d.ok) process.exit(1);
  } else if (cmd === 'ps') {
    // 直接跑 PowerShell 脚本：能碰 WMI / 注册表 / COM / .NET
    const script = pos.join(' ') || arg('--script') || (await readStdin());
    if (!script) throw new Error('用法：ps "PowerShell 脚本" 或 echo "脚本" | pc.mjs ps');
    const d = await call(need(), 'ps', { script });
    if (d.stdout) process.stdout.write(d.stdout);
    if (d.stderr) process.stderr.write(d.stderr);
    if (!d.ok) process.exit(1);
  } else if (cmd === 'batch') {
    const cmds = pos.length ? pos : (arg('--commands') || '').split('|').filter(Boolean);
    if (!cmds.length) throw new Error('用法：batch "命令1" "命令2" ...');
    const d = await call(need(), 'batch', { commands: cmds });
    for (const r of d.results) {
      console.log(`${r.ok ? '✓' : '✗'} ${r.command}`);
      if (r.stdout) console.log(r.stdout.trimEnd());
      if (r.stderr) console.error(r.stderr.trimEnd());
    }
    if (!d.ok) process.exit(1);
  } else if (cmd === 'mouse') {
    // mouse move 800 600 / mouse click left / mouse scroll -3
    const sub = pos[0];
    const args = { action: sub };
    if (sub === 'move' || sub === 'click' || sub === 'dblclick') {
      args.x = Number(pos[1]);
      args.y = Number(pos[2]);
    }
    if (sub === 'click' && pos[3]) args.button = pos[3];
    if (sub === 'scroll') args.delta = Number(pos[1]);
    const d = await call(need(), 'input', args);
    console.log(JSON.stringify(d));
  } else if (cmd === 'key') {
    // key "CTRL+V"
    if (!pos[0]) throw new Error('用法：key "CTRL+V"');
    const d = await call(need(), 'input', { action: 'key', keys: pos[0] });
    console.log(JSON.stringify(d));
  } else if (cmd === 'type') {
    const text = pos.join(' ');
    if (!text) throw new Error('用法：type "要打的字"');
    const d = await call(need(), 'input', { action: 'type', text });
    console.log(JSON.stringify(d));
  } else if (cmd === 'audit') {
    const cfg = need();
    const url = cfg.url.replace(/\/+$/, '') + '/audit?n=' + (arg('--n') || 20);
    const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.token}` } });
    const j = await res.json();
    for (const e of (j.data?.entries || []).reverse()) {
      console.log(`${e.at} ${e.kind} ${e.command || e.action || ''} ${e.ok === false ? '✗' : '✓'}`);
    }
  } else if (cmd === 'caps') {
    const cfg = need();
    const res = await fetch(cfg.url.replace(/\/+$/, '') + '/caps', { headers: { authorization: `Bearer ${cfg.token}` } });
    console.log(JSON.stringify(await res.json(), null, 2));
  } else if (cmd === 'exec') {
    const command = pos.join(' ') || arg('--command');
    if (!command) throw new Error('用法：exec "命令"');
    const d = await call(need(), 'exec', { command });
    if (d.stdout) process.stdout.write(d.stdout);
    if (d.stderr) process.stderr.write(d.stderr);
    if (!d.ok) { console.error(`（退出码 ${d.code}）`); process.exit(1); }
  } else {
    console.log(`用法：
  pc.mjs connect --url <地址> --token <令牌>   连接并验证
  pc.mjs status                                看是否连着、在不在线
  pc.mjs scan                                  在局域网里找客户端
  pc.mjs info                                  系统信息
  pc.mjs ls <路径>                             列目录
  pc.mjs read <路径>                           读文件
  pc.mjs write <路径> --content "..."          写文件
  pc.mjs exec "<命令>"                         跑白名单内的命令`);
    process.exit(cmd ? 1 : 0);
  }
} catch (error) {
  console.error(String(error?.message || error));
  process.exit(1);
}
