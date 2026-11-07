/**
 * 工作台 MCP 服务器 —— 把 sigma-agent 工作台的能力暴露给 Fish Pocket 手机端。
 *
 * 传输：Streamable HTTP（iOS 无法 spawn 子进程，只能用这一种）。
 * 鉴权：Bearer token，默认读 /opt/wb/data/.access.key，可用环境变量覆盖。
 *
 * 独立运行，不依赖工作台内部模块，只走它已有的 HTTP API：
 *   node mcp_server.mjs            # 默认 0.0.0.0:8092
 *   PORT=9000 node mcp_server.mjs
 *   WB_URL=http://127.0.0.1:8000 WB_KEY=xxx node mcp_server.mjs
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

const PORT = Number(process.env.PORT || 8092);
const HOST = process.env.HOST || '0.0.0.0';
const WB_URL = (process.env.WB_URL || 'http://127.0.0.1:8091').replace(/\/+$/, '');
const KEY_FILE = process.env.WB_KEY_FILE || '/opt/wb/data/.access.key';

function readKey() {
  if (process.env.WB_KEY) return process.env.WB_KEY.trim();
  try {
    return fs.readFileSync(KEY_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}
const WB_KEY = readKey();

// ---------- 工具定义 ----------
// 每个工具只是把调用转成工作台的一个 HTTP 请求；协议细节留在工作台里，
// 这样工作台内部怎么改，MCP 层都不用跟着动。

const TOOLS = [
  {
    name: 'wb_submit_task',
    description:
      '提交开发需求给远程工作台，异步返回任务 id。用 wb_task_status 查结果。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        desc: { type: 'string' },
        project: { type: 'string' },
      },
      required: ['title'],
    },
    run: async ({ title, desc, project }) => {
      const body = { title, desc: desc || '', project: project || undefined };
      return wb('POST', '/api/tasks', body);
    },
  },
  {
    name: 'wb_list_tasks',
    description: '列出工作台任务，可按 state 过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    run: async ({ state, limit }) => {
      const data = await wb('GET', '/api/tasks');
      let tasks = Array.isArray(data.tasks) ? data.tasks : [];
      if (state) tasks = tasks.filter((t) => t.state === state);
      tasks = tasks.slice(0, Math.max(1, Math.min(200, Number(limit) || 20)));
      return {
        total: data.tasks?.length ?? 0,
        returned: tasks.length,
        tasks: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          state: t.state,
          gate: t.gate ? { passed: !!t.gate.passed, checks: t.gate.checks } : null,
          outputs: t.meta?.outputs || [],
          updatedAt: t.updatedAt,
        })),
      };
    },
  },
  {
    name: 'wb_task_status',
    description: '查任务详情：阶段、门禁结果、产物路径。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    run: async ({ id }) => {
      const data = await wb('GET', '/api/tasks');
      const task = (data.tasks || []).find((t) => t.id === id);
      if (!task) return { found: false, id, note: '任务不存在' };
      return {
        found: true,
        id: task.id,
        title: task.title,
        state: task.state,
        gate: task.gate,
        result: task.meta?.result ?? null,
        outputs: task.meta?.outputs ?? [],
        history: task.history ?? [],
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      };
    },
  },
  {
    name: 'wb_move_task',
    description: '移动任务看板状态。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        state: { type: 'string', enum: ['triage','todo','doing','review','done','blocked'] },
        reason: { type: 'string' },
      },
      required: ['id', 'state'],
    },
    run: async ({ id, state, reason }) =>
      wb('POST', `/api/tasks/${encodeURIComponent(id)}/move`, { state, reason }),
  },
  {
    name: 'wb_memory_search',
    description: '搜索长期记忆。动手前先搜，避免重复踩坑。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    run: async ({ q, limit }) => {
      const qs = new URLSearchParams();
      if (q) qs.set('q', q);
      if (limit) qs.set('limit', String(limit));
      const data = await wb('GET', `/api/memory${qs.toString() ? '?' + qs : ''}`);
      return {
        total: data.total ?? 0,
        returned: data.returned ?? 0,
        results: (data.results || []).map((m) => ({
          id: m.id,
          content: m.content,
          project: m.project,
          tags: m.tags,
          iso: m.iso,
        })),
      };
    },
  },
  {
    name: 'wb_memory_save',
    description: '存一条经验结论到长期记忆。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        project: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['content'],
    },
    run: async ({ content, project, tags }) =>
      wb('POST', '/api/memory', { content, project, tags: tags || [] }),
  },
  {
    name: 'wb_list_skills',
    description: '列出已沉淀的技能模板。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const data = await wb('GET', '/api/skills');
      const skills = (data.skills || []).filter((s) => !String(s.name).includes('.bak'));
      return { total: skills.length, skills: skills.slice(0, 50) };
    },
  },
  {
    name: 'wb_stats',
    description: '工作台状态：任务/记忆/技能数、今日消耗。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => wb('GET', '/api/stats'),
  },
  {
    name: 'wb_health',
    description: '探测工作台是否可达。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => ({ ...(await wb('GET', '/api/health')), endpoint: WB_URL }),
  },
  {
    name: 'wb_evolve_advice',
    description: '工作台自评的改进方向与短板。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => wb('GET', '/api/evolve/advice'),
  },
];

// ---------- 调用工作台 ----------
async function wb(method, path, body) {
  const url = `${WB_URL}${path}${path.includes('?') ? '&' : '?'}k=${encodeURIComponent(WB_KEY)}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(WB_KEY ? { authorization: `Bearer ${WB_KEY}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (cause) {
    // 网络层失败（DNS 错、拒绝连接、超时）。原始错误里带着内网 URL 和端口，
    // 直接抛出去会把部署细节泄露给模型和用户，换成可行动的一句话。
    const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
    const err = new Error(timedOut
      ? '工作台响应超时（120 秒），任务可能仍在服务器上跑，稍后查状态'
      : '连不上工作台，检查服务器地址、端口是否放行，以及服务是否在运行');
    err.code = timedOut ? 504 : 502;
    throw err;
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 2000) };
  }
  if (!res.ok) {
    const err = new Error(`工作台返回 ${res.status}: ${(data.error || data.raw || '').toString().slice(0, 300)}`);
    err.code = res.status;
    throw err;
  }
  return data;
}

// ---------- MCP 协议（Streamable HTTP, JSON-RPC 2.0）----------
// 只实现客户端真正会用到的部分：initialize / tools/list / tools/call / ping。
// 无状态：不保存 session，每个请求自带上下文，服务器重启不影响客户端。

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'sigma-workbench', version: '1.0.0' };

/// 定长时间字符串比较。长度不同直接 false，否则逐字节异或累加，
/// 耗时与是否提前匹配无关——避免通过响应时间猜口令。
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i += 1) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

async function handleRpc(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        '这是 sigma-agent 远程工作台。它有完整的开发交付链：提交需求后会自动规划、执行、验收并交付可用成品。' +
        '重活（生成项目、跑测试、处理批量文件）优先用 wb_submit_task 交给它，手机上只下指令和看结果。',
    });
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return null;
  }

  if (method === 'ping') return rpcResult(id, {});

  if (method === 'tools/list') {
    return rpcResult(id, {
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcError(id, -32602, `未知工具: ${name}`);
    try {
      const out = await tool.run(params?.arguments || {});
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        isError: false,
      });
    } catch (e) {
      return rpcResult(id, {
        content: [{ type: 'text', text: `调用失败：${e.message}` }],
        isError: true,
      });
    }
  }

  return rpcError(id, -32601, `未实现的方法: ${method}`);
}

const server = createServer(async (req, res) => {
  // CORS：手机端可能从不同 origin 发起
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization, mcp-protocol-version, mcp-session-id');
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  // 健康检查：不需要鉴权，部署后先探这个
  if (req.method === 'GET' && (req.url === '/health' || req.url.startsWith('/health?'))) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ ok: true, server: SERVER_INFO, workbench: WB_URL, tools: TOOLS.length })
    );
    return;
  }

  if (!req.url.startsWith('/mcp')) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
    return;
  }

  // Bearer 鉴权：工作台配了口令就必须带对。
  // 用定长时间比较而不是 ===，避免按字符逐个试探口令（服务可能暴露在公网）。
  if (WB_KEY) {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (!timingSafeEqual(token, WB_KEY)) {
      res.writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: '未授权：Bearer token 不正确' }, id: null }));
      return;
    }
  }

  if (req.method === 'GET') {
    // Streamable HTTP 的可选 SSE 通道；本服务无状态，明确说明不支持
    res.writeHead(405, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: 'use POST for JSON-RPC' }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }

  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4 * 1024 * 1024) {
      res.writeHead(413).end();
      return;
    }
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' })
      .end(JSON.stringify(rpcError(null, -32700, 'JSON 解析失败')));
    return;
  }

  // 支持批量
  const batch = Array.isArray(payload);
  const msgs = batch ? payload : [payload];
  const results = [];
  for (const msg of msgs) {
    const r = await handleRpc(msg);
    if (r) results.push(r);
  }

  if (results.length === 0) {
    // 全是通知：按规范返回 202
    res.writeHead(202).end();
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': randomUUID() })
    .end(JSON.stringify(batch ? results : results[0]));
});

server.listen(PORT, HOST, () => {
  console.log(`[mcp] sigma-workbench MCP 服务器已启动`);
  console.log(`[mcp]   监听:      http://${HOST}:${PORT}/mcp`);
  console.log(`[mcp]   健康检查:  http://${HOST}:${PORT}/health`);
  console.log(`[mcp]   工作台:    ${WB_URL}`);
  console.log(`[mcp]   工具数:    ${TOOLS.length}`);
  console.log(`[mcp]   鉴权:      ${WB_KEY ? '已启用（Bearer）' : '未设置（工作台没配口令）'}`);
});
