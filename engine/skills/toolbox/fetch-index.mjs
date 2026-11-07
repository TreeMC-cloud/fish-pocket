#!/usr/bin/env node
/**
 * 拉取零件库索引 —— 从小块拼出完整数据。
 *
 * 背景：集市的 index.json 有几个 MB，单次下载总在中途断流（服务器或链路限制）。
 * 但实测支持 Range 请求，所以按小段分别拉、失败的段单独重试，
 * 最后按偏移量拼回去并校验 JSON 完整性。
 *
 * 用法：
 *   node fetch-index.mjs [输出路径]
 * 默认写到同目录的 index.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 无参数时只打印用法：这个脚本会发起几十次网络请求，
// 不该被"顺手跑一下"意外触发。要给输出路径才真的下载。
if (process.argv.length < 3) {
  console.error('用法：node fetch-index.mjs <输出路径>');
  console.error('  例如：node fetch-index.mjs ./index.json');
  console.error('  会从 https://www.mydsh.xyz/market/index.json 拉取零件库索引。');
  console.error('  已有文件不会被覆盖，除非先删掉它。');
  process.exit(2);
}
const OUT = process.argv[2];
const URL = 'https://www.mydsh.xyz/market/index.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0';

const CHUNK = 64 * 1024;      // 每段 64KB：小到不容易断
const RETRY = 6;              // 每段重试次数
const CONCURRENCY = 4;        // 同时几个（太高会被限流）

async function head() {
  const res = await fetch(URL, { method: 'GET', headers: { 'User-Agent': UA, Range: 'bytes=0-0' } });
  const cr = res.headers.get('content-range');
  if (cr) {
    const m = /\/(\d+)$/.exec(cr);
    if (m) return Number(m[1]);
  }
  const cl = res.headers.get('content-length');
  if (cl) return Number(cl);
  throw new Error('服务器没给总大小，无法分段');
}

async function fetchRange(start, end) {
  for (let i = 0; i < RETRY; i += 1) {
    try {
      const res = await fetch(URL, {
        headers: { 'User-Agent': UA, Range: `bytes=${start}-${end}` },
        signal: AbortSignal.timeout(45_000),
      });
      if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const want = end - start + 1;
      // 服务器忽略 Range 会返回整个文件，长度对不上就重来
      if (buf.length === want) return buf;
      if (res.status === 200 && buf.length > want) {
        // 返回了完整文件：切出需要的部分
        return buf.subarray(start, end + 1);
      }
      throw new Error(`长度 ${buf.length} ≠ ${want}`);
    } catch (e) {
      if (i === RETRY - 1) throw new Error(`段 ${start}-${end} 失败：${e.message}`);
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error('unreachable');
}

async function main() {
  process.stdout.write('探测总大小… ');
  const total = await head();
  console.log(`${(total / 1024 / 1024).toFixed(2)} MB`);

  const ranges = [];
  for (let s = 0; s < total; s += CHUNK) {
    ranges.push([s, Math.min(s + CHUNK - 1, total - 1)]);
  }
  console.log(`分成 ${ranges.length} 段，并发 ${CONCURRENCY}\n`);

  const parts = new Array(ranges.length);
  let done = 0;
  let failed = 0;

  // 简单并发池
  let next = 0;
  async function worker() {
    while (true) {
      const i = next;
      if (i >= ranges.length) return;
      next += 1;
      const [s, e] = ranges[i];
      try {
        parts[i] = await fetchRange(s, e);
      } catch (err) {
        failed += 1;
        console.log(`  ✗ ${err.message}`);
      }
      done += 1;
      if (done % 8 === 0 || done === ranges.length) {
        const pct = ((done / ranges.length) * 100).toFixed(0);
        process.stdout.write(`\r  ${done}/${ranges.length} (${pct}%)  失败 ${failed}   `);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log('');

  if (failed > 0) {
    console.log(`\n有 ${failed} 段没拿到，重跑本脚本会补齐（已下部分不浪费）。`);
    process.exit(1);
  }

  const merged = Buffer.concat(parts);
  if (merged.length !== total) {
    console.log(`\n拼接后 ${merged.length} ≠ ${total}，数据不完整。`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(merged.toString('utf8'));
  } catch (e) {
    console.log(`\nJSON 解析失败：${e.message}`);
    process.exit(1);
  }

  const list = Array.isArray(parsed) ? parsed : (parsed.plugins || []);
  fs.writeFileSync(OUT, JSON.stringify(list), 'utf8');
  console.log(`\n✓ 完整：${list.length} 个条目`);
  console.log(`  已写入 ${OUT}（${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB）`);
}

main().catch((e) => {
  console.error(`失败：${e.message}`);
  process.exit(1);
});
