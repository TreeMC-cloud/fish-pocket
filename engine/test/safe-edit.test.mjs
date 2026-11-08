import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeEdit, countOccurrences, lintFile, CHECKABLE } from '../runtime/safe-edit.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'se-'));
const mk = (dir, name, content) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, content);
  return f;
};

test('正常编辑：改成功且内容正确', () => {
  const d = tmp();
  const f = mk(d, 'a.mjs', 'const a = 1;\nexport default a;\n');
  const r = safeEdit(f, 'const a = 1;', 'const a = 2;');
  assert.equal(r.ok, true);
  assert.match(fs.readFileSync(f, 'utf8'), /const a = 2;/);
});

test('ESM 临时文件不能被当成 CommonJS（保留扩展名）', () => {
  // 回归：临时文件曾命名为 xxx.mjs.safe-edit.PID.tmp，
  // node --check 按 CJS 解析，一行 export 就报错，把正常编辑也拦掉。
  const d = tmp();
  const f = mk(d, 'esm.mjs', 'import fs from "node:fs";\nexport const x = 1;\n');
  const r = safeEdit(f, 'export const x = 1;', 'export const x = 2;');
  assert.equal(r.ok, true, `正常 ESM 不该被拦：${r.message ?? ''}`);
});

test('改出语法错误时拦住，文件不变', () => {
  const d = tmp();
  const f = mk(d, 'b.mjs', 'const b = 1;\n');
  const r = safeEdit(f, 'const b = 1;', 'const b = ;');
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'lint');
  assert.equal(fs.readFileSync(f, 'utf8'), 'const b = 1;\n');
});

test('oldStr 出现多次时拒绝（不猜改哪一处）', () => {
  const d = tmp();
  const f = mk(d, 'c.mjs', 'let x=1;\nlet x=1;\n');
  const r = safeEdit(f, 'let x=1;', 'let x=2;');
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'unique');
});

test('oldStr 不存在时也拒绝', () => {
  const d = tmp();
  const f = mk(d, 'c2.mjs', 'const a=1;\n');
  const r = safeEdit(f, '不存在的内容', 'x');
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'unique');
});

test('原文件本来就坏时仍可编辑（否则坏文件永远修不了）', () => {
  const d = tmp();
  const f = mk(d, 'd.mjs', 'const d = ;\n');
  const r = safeEdit(f, 'const d = ;', 'const d = 1;');
  assert.equal(r.ok, true, '修复坏文件必须放行');
  assert.match(fs.readFileSync(f, 'utf8'), /const d = 1;/);
});

test('wasValid=false 时不额外跑一次检查（省时间）', () => {
  const d = tmp();
  const f = mk(d, 'e.mjs', 'const e = ;\n');
  const r = safeEdit(f, 'const e = ;', 'const e = 2;', { wasValid: false });
  assert.equal(r.ok, true);
});

test('非 JS 文件跳过语法检查，不假装检查过', () => {
  const d = tmp();
  const f = mk(d, 'note.md', '# 标题\n正文\n');
  const r = safeEdit(f, '正文', '新正文');
  assert.equal(r.ok, true);
  assert.equal(lintFile(f).skipped, true);
});

test('skipLint 显式跳过', () => {
  const d = tmp();
  const f = mk(d, 'f.mjs', 'const f = 1;\n');
  const r = safeEdit(f, 'const f = 1;', 'const f = ;', { skipLint: true });
  assert.equal(r.ok, true, '显式跳过时不检查');
});

test('成功后不留临时文件', () => {
  const d = tmp();
  const f = mk(d, 'g.mjs', 'const g = 1;\n');
  safeEdit(f, 'const g = 1;', 'const g = 2;');
  const left = fs.readdirSync(d).filter((x) => x.includes('safe-edit'));
  assert.deepEqual(left, []);
});

test('失败后也不留临时文件', () => {
  const d = tmp();
  const f = mk(d, 'h.mjs', 'const h = 1;\n');
  safeEdit(f, 'const h = 1;', 'const h = ;');
  const left = fs.readdirSync(d).filter((x) => x.includes('safe-edit'));
  assert.deepEqual(left, []);
});

test('countOccurrences 按不重叠计数', () => {
  assert.equal(countOccurrences('aaa', 'aa'), 1, '不重叠：aaa 里只有一个 aa');
  assert.equal(countOccurrences('abab', 'ab'), 2);
  assert.equal(countOccurrences('abc', ''), 0);
});

test('CHECKABLE 只认 JS 系扩展名', () => {
  assert.equal(CHECKABLE.has('.mjs'), true);
  assert.equal(CHECKABLE.has('.js'), true);
  assert.equal(CHECKABLE.has('.swift'), false);
});

test('参数非法时返回 precheck 失败，不抛', () => {
  assert.equal(safeEdit('', 'a', 'b').stage, 'precheck');
  assert.equal(safeEdit('/tmp/x.mjs', '', 'b').stage, 'precheck');
  assert.equal(safeEdit('/tmp/x.mjs', 'a', null).stage, 'precheck');
});
