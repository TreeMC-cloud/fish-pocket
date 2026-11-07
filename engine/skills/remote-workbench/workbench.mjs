#!/usr/bin/env node
/**
 * 远程工作台配置器 —— 让 Agent 在对话里直接连服务器，不用人跑去设置里翻。
 *
 * 用户说「连上我的服务器去干活」，Agent 就用这个工具：
 *   workbench.mjs probe  --url <地址> [--token <口令>]   先探活，确认连得上
 *   workbench.mjs set    --url <地址> [--token <口令>]   写进配置，下次重启生效
 *   workbench.mjs show                                   看当前配了什么
 *   workbench.mjs clear                                  退回纯本地
 *
 * 为什么要做成工具而不是让人去设置：
 *   用户不知道什么 MCP、什么端口、什么 user.patch.yml。
 *   让 Agent 问一句「你的服务器地址是多少」，比让人找设置页靠谱得多。
 *
 * 写在哪：$DSH_IOS_DATA/user.patch.yml，引擎启动时作为第二个 --patch 加载。
 * 为什么改完要重启：patch 只在启动时读一次，dsh 没有热加载 MCP 条目的机制。
 * 这一点必须让 Agent 如实告诉用户，不能假装"已经生效"。
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA = process.env.DSH_IOS_DATA;
if (!DATA) {
  console.error('找不到 DSH_IOS_DATA：这个工具只能在 App 的引擎里跑');
  process.exit(2);
}
const PATCH = path.join(DATA, 'user.patch.yml');
const HEALTH_TIMEOUT_MS = 12_000;

// 空跑开关：默认只打印计划，加 --go 才真执行。
const GO = process.argv.includes('--go');

function fail(msg) {
  console.error(`错误：${msg}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail(`--${k} 需要一个值`);
      out[k] = v;
      i += 1;
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** 补协议、去尾斜杠；不是合法 http(s) 就报错。 */
function normalize(raw) {
  let text = String(raw || '').trim();
  if (!text) fail('--url 不能为空：要给服务器地址，例如 https://wb.example.com:8092');
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  while (text.endsWith('/')) text = text.slice(0, -1);
  try {
    const u = new URL(text);
    if (!u.host) throw new Error('no host');
  } catch {
    fail(`地址解析失败：${raw}。要给完整地址，例如 http://1.2.3.4:8092 或 https://wb.example.com`);
  }
  return text;
}

/** 读现有的 url / 口令，用于 show 和"只改一项"的场景。 */
function current() {
  if (!fs.existsSync(PATCH)) return { url: null, token: null };
  const text = fs.readFileSync(PATCH, 'utf8');
  let url = null;
  let token = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('url:')) {
      url = t.slice(4).trim().replace(/^["']|["']$/g, '').replace(/\/mcp$/, '');
    } else if (t.startsWith('Authorization:')) {
      token = t.slice(14).trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '');
    }
  }
  return { url, token };
}

/** YAML 双引号标量转义。换行必须转义，否则读回来会变。 */
function scalar(v) {
  let out = '';
  for (const ch of String(v)) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return `"${out}"`;
}

function render(url, token) {
  let yaml = `# 由远程工作台工具维护。要在对话里改，让 Agent 调 workbench.mjs。
# 这一层叠在 app 自带的 ios.patch.yml 之后（见 engine/boot.mjs）。
- insert:
    - id: mcp-workbench
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: workbench
        transport: streamable-http
        url: ${scalar(url + '/mcp')}
        failOnStartupError: false
        toolCallTimeoutMs: 120000
`;
  if (token) {
    yaml += `        headers:
          Authorization: ${scalar('Bearer ' + token)}
`;
  }
  return yaml;
}

async function probe(url, token) {
  // 先打 /health 拿服务名和工具数（它不鉴权，用来确认"这是个工作台、地址对"），
  // 再打一次 /mcp 的 tools/list 验口令——只查 /health 的话，口令填错了也会
  // 显示"连上了"，等到真正用的时候才报 401，人会以为配好了。
  const healthUrl = `${url}/health`;
  const mcpUrl = `${url}/mcp`;
  let res;
  try {
    res = await fetch(healthUrl, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return {
      ok: false,
      reason: timedOut
        ? `连上了但 ${HEALTH_TIMEOUT_MS / 1000} 秒没有响应。检查服务器是否在运行、端口是否被防火墙挡住。`
        : '连不上。常见原因：地址写错、端口没放行、服务没启动、手机不在能访问那个地址的网络里。',
    };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: `服务器返回 ${res.status}：口令不对，或者服务器没配这个口令。` };
  }
  if (!res.ok) {
    return { ok: false, reason: `服务器返回 ${res.status}：地址可能指错了（要指向 MCP 端口，不是网页端口）。` };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: '服务器有响应但不是 JSON：这个地址可能是别的服务。' };
  }
  // 口令验证：拿 tools/list 打一次。不带口令能过 = 服务器没设口令；
  // 带了却 401 = 口令错。两种都要如实说明，不能含糊成"连上了"。
  let authOk = true;
  let authNote = '';
  try {
    const rpc = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (rpc.status === 401 || rpc.status === 403) {
      authOk = false;
      authNote = token
        ? '口令不对：服务器拒绝了这个 Bearer token。口令在服务器的 /opt/wb/data/.access.key 里。'
        : '服务器要求口令，但没给 --token。口令在服务器的 /opt/wb/data/.access.key 里。';
    }
  } catch {
    // tools/list 打不通但 health 通了：可能是路由只对 GET 开放。
    // 不把它当成失败，但要说出来，避免"以为验过了"。
    authNote = '口令没能验证（服务器不接受 tools/list 探测），实际用的时候可能报 401。';
  }

  if (!authOk) {
    return { ok: false, reason: authNote };
  }

  return {
    ok: true,
    server: body?.server?.name ?? '未知服务',
    tools: body?.tools ?? 0,
    authNote,
  };
}

const args = parseArgs(process.argv.slice(2).filter(a => a !== '--go'));
const cmd = args._[0];

if (!cmd || cmd === 'help') {
  console.log(`用法：
  workbench.mjs probe  --url <地址> [--token <口令>]   探活
  workbench.mjs set    --url <地址> [--token <口令>]   写入配置
  workbench.mjs show                                   看当前配置
  workbench.mjs clear                                  退回纯本地`);
  process.exit(0);
}

if (cmd === 'show') {
  const c = current();
  if (!c.url) {
    console.log('当前：纯本地（没有配置服务器）');
    console.log('要在对话里连服务器，让 Agent 跑：workbench.mjs set --url <地址> --token <口令>');
    process.exit(0);
  }
  console.log(`当前已配置：${c.url}`);
  console.log(`口令：${c.token ? '已设置' : '未设置'}`);
  console.log('（改完配置要重启 App 才生效）');
  process.exit(0);
}

if (cmd === 'clear') {
  if (fs.existsSync(PATCH)) {
    fs.unlinkSync(PATCH);
    console.log('已删除配置，下次启动回到纯本地。');
  } else {
    console.log('本来就是纯本地，没有配置可删。');
  }
  process.exit(0);
}

if (cmd === 'probe' || cmd === 'set') {
  const url = normalize(args.url);
  const prev = current();
  // 只给 url 不给 token 时，沿用之前存的口令——换地址但口令没变是常见情况。
  const token = args.token !== undefined ? args.token : (prev.token ?? '');
  const target = url + '/mcp';

  const result = await probe(url, token);
  if (!result.ok) {
    console.log(`✗ 连不上 ${url}`);
    console.log(`  ${result.reason}`);
    if (cmd === 'set') {
      console.log('');
      console.log('  没有写入配置。先解决连接问题再试。');
    }
    process.exit(1);
  }

  console.log(`✓ 连上了 ${url}`);
  console.log(`  服务：${result.server}`);
  console.log(`  工具：${result.tools} 个`);
  if (result.authNote) console.log(`  注意：${result.authNote}`);

  if (cmd === 'probe') {
    console.log('');
    console.log('这只是探活，还没写配置。要真正启用，跑：');
    console.log(`  workbench.mjs set --url ${url}${token ? ' --token <口令>' : ''}`);
    process.exit(0);
  }

  // 空跑：写的是 MCP 配置，写错会让引擎起来后连不上。
  if (!GO) { console.log('   [空跑] 将写入 ' + PATCH); console.log('   url: ' + url); console.log('   加 --go 才会真执行。'); process.exit(0); }
  fs.mkdirSync(path.dirname(PATCH), { recursive: true });
  fs.writeFileSync(PATCH, render(url, token), 'utf8');
  console.log('');
  console.log('✓ 配置已写入');
  console.log(`  ${PATCH}`);
  console.log('');
  console.log('⚠ 要重启 App 才生效：从后台划掉本 App 再重新打开。');
  console.log('  引擎只在启动时读这份配置，dsh 没有热加载 MCP 条目的机制。');
  process.exit(0);
}

fail(`不认识的命令「${cmd}」。跑 workbench.mjs help 看用法`);
