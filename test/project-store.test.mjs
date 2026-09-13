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
  st.mediaDirty = false;
  const fab = path.join(dir, 'fabula.json');
  fs.writeFileSync(fab, JSON.stringify(M.newProjectModel('t'), null, 2));
  st.lastJson = JSON.stringify(M.normalizeProject(JSON.parse(fs.readFileSync(fab, 'utf8'))), null, 2);
  return { dir, events };
}

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
  fs.rmSync(dir, { recursive: true, force: true });
});
