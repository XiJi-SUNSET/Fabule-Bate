import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const create = require('../src/js/save-controller.js');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('保存等待在途写入，并继续保存期间产生的新编辑', async () => {
  const p = {}, gate = deferred();
  let revision = 1, saved = 0, writes = [], active = 0, max = 0;
  const c = create({ project: () => p, dirty: () => saved !== revision, flush: async () => {}, state() {},
    async write() { const r = revision; max = Math.max(max, ++active); writes.push(r); if (r === 1) await gate.promise; saved = r; active--; }
  });
  let finished = false;
  const first = c.save().then(() => { finished = true; });
  const second = c.save();
  await new Promise(setImmediate);
  assert.equal(finished, false);
  revision = 2; gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(writes, [1, 2]);
  assert.equal(max, 1);
});

test('帧失败不写模型、不显示成功，队列允许重试', async () => {
  const states = []; let fail = true, dirty = true, writes = 0;
  const p = {};
  const c = create({ project: () => p, dirty: () => dirty, state: s => states.push(s),
    async flush() { if (fail) throw new Error('disk full'); }, async write() { writes++; dirty = false; }
  });
  await assert.rejects(c.save(), /disk full/);
  assert.equal(writes, 0); assert.deepEqual(states, ['saving', 'failed']);
  fail = false; await c.save(); assert.equal(writes, 1); assert.equal(states.at(-1), 'saved');
});

test('工程切换独占操作等待保存完成，旧工程排队保存不得写新工程', async () => {
  const old = {}, next = {}, gate = deferred(); let p = old, writes = 0;
  const c = create({ project: () => p, dirty: () => false, state() {}, flush: async () => {}, async write() { writes++; await gate.promise; } });
  const save = c.save({ force: true });
  const change = c.exclusive(() => { p = next; });
  const stale = c.save({ force: true });
  const rejected = assert.rejects(stale, /工程已切换/);
  await new Promise(setImmediate); assert.equal(p, old);
  gate.resolve(); await save; await change; await rejected; assert.equal(writes, 1);
});
