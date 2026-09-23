/* main/recent.cjs 单元测试：去重/置顶/上限/forget/损坏容错/listLive 与安全门 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const recent = require('../main/recent.cjs');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-recent-test-'));
  return path.join(dir, 'recent.json');
}

test('touch：置顶 + 去重（大小写不敏感）+ 名称快照', () => {
  const f = tmpFile();
  recent.touch(f, 'C:\\Work\\ProjA', { name: 'A', shots: 3 }, 1000);
  recent.touch(f, 'C:\\Work\\ProjB', { name: 'B', shots: 5 }, 2000);
  recent.touch(f, 'c:\\work\\proja', { name: 'A2', shots: 4 }, 3000);   // 同路径不同大小写
  const list = recent.load(f);
  assert.equal(list.length, 2, '大小写不同视为同一工程');
  assert.equal(list[0].name, 'A2', '再次打开需置顶且刷新快照');
  assert.equal(list[0].openedAt, 3000);
  assert.equal(list[1].root.endsWith('ProjB'), true);
});

test('touch：上限 12 条，最旧的被挤出', () => {
  const f = tmpFile();
  for (let i = 0; i < 14; i++) recent.touch(f, 'C:\\W\\P' + i, { name: 'P' + i }, 1000 + i);
  const list = recent.load(f);
  assert.equal(list.length, recent.MAX);
  assert.equal(list[0].name, 'P13');
  assert.equal(list.some((e) => e.name === 'P0'), false);
});

test('forget：按路径移除（大小写不敏感）', () => {
  const f = tmpFile();
  recent.touch(f, 'C:\\W\\A', {}, 1);
  recent.touch(f, 'C:\\W\\B', {}, 2);
  recent.forget(f, 'c:\\w\\a');
  const list = recent.load(f);
  assert.equal(list.length, 1);
  assert.equal(list[0].root.endsWith(path.sep + 'B') || list[0].root.endsWith('/B'), true);
});

test('损坏文件与非法条目：容错为空/过滤', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{ not json');
  assert.deepEqual(recent.load(f), []);
  fs.writeFileSync(f, JSON.stringify([null, { name: 'no-root' }, { root: 'C:\\ok', name: 'ok' }]));
  const list = recent.load(f);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'ok');
});

test('listLive：exists 标记 + 从 fabula.json 刷新名称/镜头数', () => {
  const f = tmpFile();
  const proj = path.join(path.dirname(f), 'proj1');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'fabula.json'),
    JSON.stringify({ name: '真名', shots: [{ id: 's1' }, { id: 's2' }] }));
  recent.touch(f, proj, { name: '旧名', shots: 0 }, 9);
  recent.touch(f, path.join(path.dirname(f), 'gone'), { name: '消失' }, 10);
  const live = recent.listLive(f);
  const p1 = live.find((e) => e.root.endsWith('proj1'));
  const gone = live.find((e) => e.root.endsWith('gone'));
  assert.equal(p1.exists, true);
  assert.equal(p1.name, '真名', '应从 fabula.json 刷新名称');
  assert.equal(p1.shots, 2);
  assert.equal(gone.exists, false);
});

test('has：安全门只认列表内路径', () => {
  const f = tmpFile();
  recent.touch(f, 'C:\\W\\A', {}, 1);
  assert.equal(recent.has(f, 'c:\\w\\a'), true);
  assert.equal(recent.has(f, 'C:\\W\\evil'), false);
});
