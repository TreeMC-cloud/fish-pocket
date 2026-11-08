// 引擎树冒烟：确认最终要打进 .app 的那棵树上，关键包真的能加载。
//
// 由 build-engine.sh 在「剪枝之后」调用，cwd 是 nodejs-project，本文件也在树根，
// 所以直接 import 就按树内 node_modules 解析——不需要 createRequire 或
// import.meta.resolve 那些绕法（它们要么基准不对，要么 Node 版本不支持）。
//
// 为什么必须在剪枝之后：CI 里装出来的树不等于打进 .app 的树，真机跑的是后者。
// 剪枝规则删错文件（src/ 里的运行时入口、skills/*.md、openai、pnpm、debug…）
// 只有在这里才拦得住——这类错误在构建期不报，真机才炸。

const failures = [];

async function must(label, spec) {
  try {
    await import(spec);
  } catch (error) {
    failures.push(`${label}: ${error?.message ?? error}`);
  }
}

// 1. dsh-llm 的形状：dsh-web 等几十个插件从它 import HarnessError。
//    用最小 shim 的时代就是这里先炸，所以先验形状再验别的。
try {
  const llm = await import('@deepseek-ai/dsh-llm');
  if (typeof llm.HarnessError !== 'function') failures.push('dsh-llm: 缺少 HarnessError 导出');
} catch (error) {
  failures.push(`dsh-llm: ${error?.message ?? error}`);
}

// 2. 核心运行时链
for (const spec of [
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-spill-local',
  'meow-memory',
]) {
  await must(spec, spec);
}

// 3. 剪枝误伤过的包：它们的 main 就在 src/ 下，曾被「删 src 目录」的规则误删，
//    真机日志里表现为 Cannot find module .../src/index.js（23 处）。
for (const spec of ['debug', 'human-signals', '@opentelemetry/api-logs']) {
  await must(spec, spec);
}

// 4. pi-ai 是 LLM 供应商底座（dsh-llm-deepseek 靠它），它静态 import openai。
//    曾因为「只扫 @deepseek-ai 命名空间」误判零引用而把这几个包删掉。
await must('@earendil-works/pi-ai', '@earendil-works/pi-ai');
for (const spec of ['openai', '@anthropic-ai/sdk', '@google/genai']) {
  await must(spec, spec);
}

// 5. pnpm：App 内装插件的唯一通道（dsh plugin add → pnpm add）。
//    被剪掉时真机报的是装插件 MODULE_NOT_FOUND，构建期不报错，所以必须挡。
//    不能 import('pnpm')：它不是 ESM 模块，会解析到 package.json 并抛
//    ERR_IMPORT_ATTRIBUTE_MISSING；它的 exports 也不开放 ./bin/pnpm.cjs。
try {
  const { createRequire } = await import('node:module');
  const { existsSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const require = createRequire(join(process.cwd(), 'noop.cjs'));
  const root = dirname(require.resolve('pnpm/package.json'));
  if (!['bin/pnpm.cjs', 'bin/pnpm.mjs'].some((rel) => existsSync(join(root, rel)))) {
    throw new Error('包里没有 bin/pnpm.cjs 或 .mjs');
  }
} catch (error) {
  failures.push(`pnpm: ${error?.message ?? error}`);
}

if (failures.length > 0) {
  console.error(`✗ 冒烟失败 ${failures.length} 项：`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log('✓ 引擎冒烟通过（dsh-llm / 核心链 / 剪枝误伤包 / pi-ai 供应商 / pnpm）');
