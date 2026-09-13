/* 主进程 IPC 结构测试（专杀 N-A2 类"接缝伤"）：
   1) 每个 ipcMain.handle 必须位于模块顶层（深度 0），不能在某个回调体内；
   2) preload 调用的通道必须在 main.js 中已注册（防死通道/拼写漂移）。
   纯静态源码分析，零依赖。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSrc = fs.readFileSync(path.join(root, 'main/main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(root, 'main/preload.js'), 'utf8');

test('main.js：ipcMain.handle 全部位于模块顶层（N-A2 类回归）', () => {
  /* 去注释与字符串字面量后按行扫描，维护花括号深度 */
  const clean = mainSrc
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
  let depth = 0;
  clean.split('\n').forEach((ln, i) => {
    if (ln.indexOf('ipcMain.handle(') >= 0) {
      assert.equal(depth, 0, '第 ' + (i + 1) + ' 行 ipcMain.handle 处于嵌套作用域（深度 ' + depth + '）');
    }
    for (const ch of ln) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
  });
});

test('preload 调用的通道全部已在 main 注册（防死通道）', () => {
  const pre = [...preloadSrc.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]);
  const main = new Set([...mainSrc.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]));
  assert.ok(pre.length >= 14, 'preload 通道数量异常：' + pre.length);
  for (const c of pre) assert.ok(main.has(c), 'preload 调用的通道未注册：' + c);
});
