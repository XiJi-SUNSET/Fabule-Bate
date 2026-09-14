/* 主进程 IPC 结构测试（专杀 N-A2 类"接缝伤"）：
   1) 每个 ipcMain.handle 必须位于模块顶层（深度 0），不能在某个回调体内；
   2) preload 调用的通道必须在 main.js 中已注册（防死通道/拼写漂移）；
   3) 清洗器自检（R3 D-1）：行数守恒 + handle 命中数与原文一致。
   纯静态源码分析，零依赖。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSrc = fs.readFileSync(path.join(root, 'main/main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(root, 'main/preload.js'), 'utf8');

/* ── 逐字符状态机（R3 D-1）──
   旧实现是正则链"先剥行注释、再剥字符串"，main.js:141 `'fabula://app'` 里 URL 的
   `//` 被当成行注释剥掉 → 残留未闭合单引号 → 引号正则跨行吞并后续代码
   （实测复现：615 行塌缩为 522 行、ipcMain.handle 命中 16→15、
   漏检 app:close-ready、失败行号最多偏移 93 行）。
   状态机与输入保持同构：**换行原样保留**（行号一一对应），注释与字符串内容
   替换为空格；字符串/模板串内部不识别注释；正则字面量用"前一有效字符或
   关键字"判定起始（除号不会误入正则态），字符类里的 `/` 不结束正则。 */

/* /x/ 的合法起始判定：前一有效字符属于运算符/分隔符集合，或前一单词是关键字 */
function isRegexStart(src, i) {
  let j = i - 1;
  while (j >= 0) {
    const ch = src[j];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { j--; continue; }
    if ('([{,;=:!&|?+-*%^~<>'.includes(ch)) return true;
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
    const word = src.slice(k + 1, j + 1);
    return /^(return|typeof|case|in|of|new|delete|void|instanceof|do|else|yield|await)$/.test(word);
  }
  return true;   // 文件开头
}

function sanitize(src) {
  const out = new Array(src.length);
  let i = 0;
  const n = src.length;
  const put = (j) => { out[j] = src[j] === '\n' ? '\n' : ' '; };
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (c === '/' && c2 === '/') {                       // 行注释
      while (i < n && src[i] !== '\n') put(i++);
      continue;
    }
    if (c === '/' && c2 === '*') {                       // 块注释
      put(i++); put(i++);
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) put(i++);
      if (i < n) { put(i++); put(i++); }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {           // 字符串 / 模板串
      const q = c;
      put(i++);
      while (i < n) {
        if (src[i] === '\\') { put(i++); if (i < n) put(i++); continue; }
        if (src[i] === q) { put(i++); break; }
        put(i++);
      }
      continue;
    }
    if (c === '/' && isRegexStart(src, i)) {             // 正则字面量
      put(i++);
      let inClass = false;
      while (i < n) {
        const d = src[i];
        if (d === '\\') { put(i++); if (i < n) put(i++); continue; }
        if (d === '\n') break;                           // 未闭合：截断防吞代码
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { put(i++); break; }
        put(i++);
      }
      continue;                                          // flags（g/m/i…）按普通代码保留
    }
    out[i] = c;                                          // 普通代码原样保留
    i++;
  }
  return out.join('');
}

test('清洗器自检（R3 D-1）：行数守恒 + handle 命中数与原文一致', () => {
  const clean = sanitize(mainSrc);
  assert.equal(clean.split('\n').length, mainSrc.split('\n').length,
    '清洗必须行数守恒（断言失败的行号才可定位）');
  const cnt = (s) => [...s.matchAll(/ipcMain\.handle\(/g)].length;
  assert.equal(cnt(clean), cnt(mainSrc),
    '清洗后 handle 命中数必须与原文一致（字符串/注释误剥会静默漏检）');
  assert.ok(cnt(clean) >= 16, 'handler 数量异常：' + cnt(clean));
});

test('main.js：ipcMain.handle 全部位于模块顶层（N-A2 类回归）', () => {
  const clean = sanitize(mainSrc);
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
