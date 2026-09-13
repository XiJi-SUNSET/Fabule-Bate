/* 偏好桥契约测试（源码级）：引擎读取的键必须在设置 DEFAULTS 有定义，
   防「引擎读 penPMin / DEFAULTS 没有 → 被静默丢弃」类断链（L-26）回归。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('引擎 applyPenPrefs 读取的每个键都能被偏好桥提供', () => {
  const paint = read('src/engine/paint.js');
  const settings = read('src/js/settings.js');
  const keys = ['penCurve', 'penSmooth', 'penPMin', 'penPMax', 'penSpeedRef'];
  for (const k of keys) {
    assert.ok(paint.includes("p.get('" + k + "')"), '引擎应读取 ' + k);
  }
  /* 同名直通的三个键：DEFAULTS 必须有定义（否则 +undefined = NaN 被丢弃） */
  for (const k of ['penPMin', 'penPMax', 'penSpeedRef']) {
    assert.ok(new RegExp('\\b' + k + '\\s*:').test(settings), 'DEFAULTS 应定义 ' + k);
  }
  /* 翻译键：偏好桥必须有对应的换算实现 */
  assert.ok(settings.includes('penCurve'), 'prefs 桥应实现 penCurve 翻译');
  assert.ok(settings.includes('penSmooth'), 'prefs 桥应实现 penSmooth 翻译');
});

test('审计清理掉的死设置不再出现在设置面板', () => {
  const settings = read('src/js/settings.js');
  for (const k of ['showRing', 'showRingNum', 'invertWheel', 'gpuEffect', 'paperTex', 'smoothing', 'paper']) {
    assert.ok(!new RegExp('data-k="' + k + '"').test(settings), '死设置不应有 UI 行：' + k);
  }
});

test('默认快捷键无重复占用', () => {
  const settings = read('src/js/settings.js');
  /* 动作项格式：['id', '标签', 'combo', ...] —— 抓第三个字符串即默认键 */
  const defs = [...settings.matchAll(/\['([\w.]+)',\s*'[^']*',\s*'([^']*)'/g)];
  const used = new Map();
  for (const [, id, combo] of defs) {
    if (!combo) continue;
    const key = combo.toUpperCase();
    assert.ok(!used.has(key), '快捷键冲突：' + combo + ' 同时被 ' + used.get(key) + ' 与 ' + id + ' 占用');
    used.set(key, id);
  }
});
