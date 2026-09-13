/* 动作表 ↔ 执行器对齐测试（源码级）：
   settings.js 里定义的动作必须能在 app.js 找到执行器（防"定义了没实现"的断链）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const settings = read('src/js/settings.js');
const app = read('src/js/app.js');

test('CMD_ACTS 全部有执行器', () => {
  const ids = [...settings.matchAll(/\['(cmd\.[\w]+)'\s*,/g)].map((m) => m[1]);
  assert.ok(ids.length >= 15, '命令动作数量异常：' + ids.length);
  for (const id of ids) assert.ok(app.includes("'" + id + "'"), 'app.js 缺少执行器：' + id);
});

test('TOOL_ACTS 全部有执行器（app.js 的工具执行器生成表）', () => {
  const ids = [...settings.matchAll(/\['tool\.(\w+)'\s*,/g)].map((m) => m[1]);
  assert.ok(ids.length >= 8, '工具动作数量异常：' + ids.length);
  const gen = app.match(/\[([^\]]*'brush'[^\]]*)\]\s*\.forEach/);
  assert.ok(gen, 'app.js 的工具执行器生成表应存在');
  for (const t of ids) assert.ok(gen[1].includes("'" + t + "'"), '工具执行器表缺少：' + t);
});

test('轮盘默认项都在动作表里（非笔刷项）', () => {
  const radial = settings.match(/radial:\s*\[([^\]]+)\]/);
  assert.ok(radial, 'DEFAULTS.radial 应存在');
  const ids = [...radial[1].matchAll(/'([\w.]+)'/g)].map((m) => m[1]);
  assert.equal(ids.length, 8, '轮盘应为 8 格');
  const all = new Set([...settings.matchAll(/\['([\w.]+)'\s*,/g)].map((m) => m[1]));
  for (const id of ids) {
    if (id.startsWith('brush.')) continue;      // 笔刷动作由 brushes.list 动态生成
    assert.ok(all.has(id), '轮盘项应有对应动作定义：' + id);
  }
});
