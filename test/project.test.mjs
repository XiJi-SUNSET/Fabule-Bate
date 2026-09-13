/* projectModel.cjs 单元测试：出厂结构 / 归一化修复 / 非法输入回退 / 去重。
   纯 node:test，零依赖（与 main/projectModel.cjs 同源直测）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../main/projectModel.cjs');

test('newProjectModel 出厂结构完整', () => {
  const p = M.newProjectModel('测试工程');
  assert.equal(p.version, M.FORMAT_VERSION);
  assert.equal(p.name, '测试工程');
  assert.equal(p.fps, 24);
  assert.equal(p.boardW, 1280);
  assert.equal(p.boardH, 720);
  assert.deepEqual(p.shots, []);
  assert.deepEqual(p.groups, []);
  assert.deepEqual(p.assets, []);
  assert.ok(Array.isArray(p.tagOptions.size) && p.tagOptions.size.length > 0);
  assert.equal(M.newProjectModel('').name, '未命名工程');
});

test('normalizeProject：修 id / 修时长 / 剔非法字段', () => {
  const p = M.normalizeProject({
    name: 'x',
    shots: [{ id: 'bad id', duration: -3, description: { content: 123, notes: 'ok' }, image: '../evil.png' }],
    assets: [{ id: 'nope', kind: 'video', path: 'assets/image/a.png' }],
  });
  assert.equal(p.shots.length, 1);
  assert.match(p.shots[0].id, M.SHOT_ID_RE);
  assert.equal(p.shots[0].duration, 3);               // 非法时长回退默认
  assert.equal(p.shots[0].description.content, '');   // 非字符串字段归零
  assert.equal(p.shots[0].description.notes, 'ok');   // 合法字段保留
  assert.equal(p.shots[0].image, null);               // 穿越路径拒收
  assert.equal(p.assets.length, 0);                   // 非法 kind 拒收
});

test('normalizeProject：损坏输入不抛异常，永远返回完整结构', () => {
  for (const bad of [null, undefined, 42, 'x', true, []]) {
    const p = M.normalizeProject(bad);
    assert.ok(p && typeof p === 'object');
    assert.ok(Array.isArray(p.shots) && Array.isArray(p.groups) && Array.isArray(p.assets));
  }
});

test('normalizeProject：shot id 冲突自动去重', () => {
  const id = 'sh_00000001';
  const p = M.normalizeProject({ shots: [{ id }, { id }, { id }] });
  assert.equal(new Set(p.shots.map((s) => s.id)).size, 3);
});

test('sanitizeAsset：kind 与路径前缀必须一致', () => {
  assert.ok(M.sanitizeAsset({ kind: 'image', path: 'assets/image/a.png' }));
  assert.equal(M.sanitizeAsset({ kind: 'image', path: 'assets/audio/a.mp3' }), null);
  assert.equal(M.sanitizeAsset({ kind: 'image', path: 'assets/image/../x.png' }), null);
  assert.equal(M.sanitizeAsset({ kind: 'image', path: 'assets/image/a.png', group: 'g1' }).group, 'g1');
});

test('normalizeProject：悬空分组引用归零', () => {
  const p = M.normalizeProject({
    groups: [{ id: 'g1', name: '组一' }],
    assets: [{ kind: 'image', path: 'assets/image/a.png', group: 'ghost' }],
  });
  assert.equal(p.assets[0].group, null);
});

test('normalizeProject：来自未来版本的文件抛 E_VERSION（L-16）', () => {
  try {
    M.normalizeProject({ version: M.FORMAT_VERSION + 1, name: 'future' });
    assert.fail('未来版本应抛错而不是静默降级');
  } catch (e) {
    assert.equal(e.code, 'E_VERSION');
  }
  /* 当前版本与旧版本照常归一 */
  assert.equal(M.normalizeProject({ version: M.FORMAT_VERSION }).version, M.FORMAT_VERSION);
  assert.equal(M.normalizeProject({ version: 1 }).version, M.FORMAT_VERSION);
});

test('sanitizeShot：合法 id 保持不变，image 仅收 shots/*.png', () => {
  const id = 'sh_1234abcd';
  assert.equal(M.sanitizeShot({ id }).id, id);
  assert.equal(M.sanitizeShot({ image: 'shots/sh_1234abcd.png' }).image, 'shots/sh_1234abcd.png');
  assert.equal(M.sanitizeShot({ image: 'boards/x.png' }).image, null);
  assert.equal(M.sanitizeShot({ image: 'shots/x.jpg' }).image, null);
});
