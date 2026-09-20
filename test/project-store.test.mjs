/* projectStore 变更判定测试（H-1/H-2/N-A5/N-B20 的战场）：
   直接驱动 notifyChanged（__test 探针），不经真实 fs.watch —— 避免挂住测试进程。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const store = require('../main/projectStore.js');
const M = require('../main/projectModel.cjs');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-store-'));
  const events = [];
  const st = store.__test.state;
  st.root = dir;
  st.win = { webContents: { send: (_ch, info) => events.push(info) } };
  st.lastMontage = null;
  st.mediaFiles = new Set();        /* N-A5 采集集：跨用例隔离（原 st.mediaDirty 是幽灵字段，R3 B-20） */
  store.__test.selfMedia.clear();   /* 自写登记表：跨用例隔离 */
  const fab = path.join(dir, 'fabula.json');
  fs.writeFileSync(fab, JSON.stringify(M.newProjectModel('t'), null, 2));
  st.lastJson = JSON.stringify(M.normalizeProject(JSON.parse(fs.readFileSync(fab, 'utf8'))), null, 2);
  return { dir, events };
}

test('watch 媒体采集：tmp 中间态不误报、正式名照常（误报根因回归）', () => {
  const { events } = setup();
  const st = store.__test.state;
  const T = store.__test;
  st.mediaFiles = new Set();
  /* 1) 原子写中间态（writeAtomic 的 tmp 名）→ 不采集（此前每次保存都被误报"外部更新"） */
  T.noteWatchName('boards/a.png.tmp-123-456');
  assert.equal(st.mediaFiles.size, 0, 'tmp 中间态不得计入媒体变更');
  /* 2) 正式名 + 自己登记过 → 吞掉 */
  T.selfMedia.clear();
  store.markSelfMedia('boards/a.png');
  T.noteWatchName('boards/a.png');
  assert.equal(st.mediaFiles.size, 0, '自写登记的正式名应被吞');
  /* 3) 正式名 + 未登记（外部直写，如 MCP set_shot_image）→ 必须采集 */
  T.selfMedia.clear();
  T.noteWatchName('boards/ext.png');
  assert.equal(st.mediaFiles.size, 1, '外部直写正式名必须采集');
  st.mediaFiles.clear();
});

test('montage.json：基线缺失首现广播 / 不变不广播 / 变化广播后收敛（N-B20）', () => {
  const { dir, events } = setup();
  const file = path.join(dir, 'montage.json');
  /* 1) 基线 null + 文件出现 → 广播（新建工程时外部先写的场景） */
  fs.writeFileSync(file, JSON.stringify({ version: 4, name: 'a' }, null, 2));
  store.__test.notifyChanged();
  assert.deepEqual(events.at(-1).sources, ['montage']);
  /* 2) 文本不变 → sources 为空（广播仍在，但无 external 内容） */
  store.__test.notifyChanged();
  assert.deepEqual(events.at(-1).sources, [], '文本未变不应报 montage');
  assert.equal(events.at(-1).external, false);
  /* 3) 外部改动 → sources 含 montage */
  fs.writeFileSync(file, JSON.stringify({ version: 4, name: 'b' }, null, 2));
  store.__test.notifyChanged();
  assert.deepEqual(events.at(-1).sources, ['montage']);
  /* 4) 收敛：立即再调 sources 为空 */
  store.__test.notifyChanged();
  assert.deepEqual(events.at(-1).sources, [], '广播后应收敛为已知');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('媒体信号：boards 变化标记 → 一次性广播 media 并复位（N-A5）', () => {
  const { dir, events } = setup();
  fs.writeFileSync(path.join(dir, 'montage.json'), JSON.stringify({ version: 4, name: 'x' }, null, 2));
  store.__test.notifyChanged();                     // 首现广播（建立基线）
  store.__test.state.mediaFiles.add('boards/x.png'); // 模拟 watch 对 boards/ 的标记
  store.__test.notifyChanged();
  assert.deepEqual(events.at(-1).sources, ['media']);
  assert.equal(store.__test.state.mediaFiles.size, 0, '清单应被消费清空');
  store.__test.notifyChanged();
  assert.deepEqual(events.at(-1).sources, [], 'media 应只广播一次');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('自写媒体抑制 + files 清单（N-A5 修订：自己的保存不打断作画）', () => {
  const { dir, events } = setup();
  fs.writeFileSync(path.join(dir, 'montage.json'), JSON.stringify({ version: 4, name: 'x' }, null, 2));
  store.__test.notifyChanged();

  /* 自写：登记后消费为 true（watch 里会被吞） */
  store.markSelfMedia('boards/bd_a.png');
  assert.equal(store.__test.consumeSelfMedia('boards/bd_a.png'), true);
  /* 窗口期内多次消费仍为 true：Windows 一次写入会产生多个 watch 事件 */
  assert.equal(store.__test.consumeSelfMedia('boards/bd_a.png'), true);
  /* 未登记的（外部写入）：消费为 false */
  assert.equal(store.__test.consumeSelfMedia('boards/bd_ext.png'), false);

  /* 外部改动清单随广播带出，且只广播一次 */
  store.__test.state.mediaFiles.add('boards/bd_ext.png');
  store.__test.notifyChanged();
  assert.deepEqual(events.at(-1).sources, ['media']);
  assert.deepEqual(events.at(-1).files, ['boards/bd_ext.png']);
  store.__test.notifyChanged();
  assert.deepEqual(events.at(-1).files, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fabula.json 外部变更：sources 含 fabula（且不误报 montage）', () => {
  const { dir, events } = setup();
  fs.writeFileSync(path.join(dir, 'montage.json'), JSON.stringify({ version: 4, name: 'x' }, null, 2));
  store.__test.notifyChanged();
  fs.writeFileSync(path.join(dir, 'fabula.json'),
    JSON.stringify({ name: 'moved', shots: [{ id: 'sh_00000001', duration: 2 }] }, null, 2));
  store.__test.notifyChanged();
  const last = events.at(-1);
  assert.ok(last.sources.includes('fabula'));
  assert.ok(!last.sources.includes('montage'), 'montage 未变不应出现在 sources');
  assert.equal(store.current().project.name, 'moved', '重载必须应用解析后的对象');
  assert.equal(store.current().project.shots.length, 1);
  assert.equal(store.current().project.shots[0].duration, 2);
  store.__test.notifyChanged();
  assert.equal(events.at(-1).external, false, '正确内容应在下一次检测中收敛');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('中文名素材路径：sanitizeAsset 接受（与导入/渲染端命名规则一致）', () => {
  const a = M.sanitizeAsset({
    id: 'as_0000000a', name: '素材-中文名', kind: 'audio',
    path: 'assets/audio/素材-中文名.mp3', group: null,
  });
  assert.ok(a, '中文素材文件名不应被路径规范丢弃（此前被丢弃 → 基线与清单永久错位 → 每次保存都误报外部更新）');
  assert.equal(a.path, 'assets/audio/素材-中文名.mp3');
  /* 防穿越底线保持：不含路径分隔的越界写法仍应被拒 */
  assert.equal(M.sanitizeAsset({ id: 'as_0000000b', name: 'x', kind: 'audio', path: 'assets/audio/../evil.mp3', group: null }), null);
});

test('导入中文名素材：真实链路落盘后不触发 fabula 外部变更误报（用户反馈回归）', () => {
  const { dir, events } = setup();
  const st = store.__test.state;
  st.project = M.newProjectModel('t');
  fs.writeFileSync(path.join(dir, 'fabula.json'), JSON.stringify(st.project, null, 2));
  st.lastJson = JSON.stringify(st.project, null, 2);
  /* 造一个中文名 MP3（ID3 magic 头）在工程外临时路径 */
  const src = path.join(os.tmpdir(), 'fab-测试音频.mp3');
  fs.writeFileSync(src, Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0, 0]));
  const r = store.importAssets([src]);
  assert.equal(r.added, 1, '中文名音频应导入成功（而不是被静默跳过）');
  assert.equal(r.addedPaths[0], 'assets/audio/fab-测试音频.mp3');
  /* 导入的媒体是自身写入：watch 里应被吞掉，不冒泡成 media 广播 */
  assert.equal(store.__test.consumeSelfMedia(r.addedPaths[0]), true, '导入的文件应登记为自写');
  /* 关键：此后任何 watch 事件（如编辑音频触发的 montage 保存）不得报 fabula 外部变更 */
  events.length = 0;
  store.__test.notifyChanged();
  assert.ok(!events.at(-1).sources.includes('fabula'), '导入中文名素材后不得误报 fabula（用户反馈：编辑音频总是弹"外部更新"）');
  fs.rmSync(src, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
