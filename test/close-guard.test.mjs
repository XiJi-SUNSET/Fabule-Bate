import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const create = require('../main/closeGuard.cjs');

function fixture(ask = async () => 'wait') {
  const timers = new Map(), requests = [], cancelled = [], errors = [];
  let seq = 0, closed = 0;
  const guard = create({save:id=>requests.push(id), close:()=>closed++, cancel:id=>cancelled.push(id), failed:e=>errors.push(e), ask}, {
    setTimeout(fn, delay) { assert.equal(delay, 12000); timers.set(++seq, fn); return seq; },
    clearTimeout(id) { timers.delete(id); }
  });
  return {guard,requests,cancelled,errors, get closed(){return closed;},
    async timeout() { const [id,fn] = timers.entries().next().value; timers.delete(id); await fn(); }, timers};
}

test('慢保存只询问，不自动关闭；重复关闭共享一个请求', async () => {
  const f=fixture();
  assert.equal(f.guard.request(),true); assert.equal(f.guard.request(),true);
  assert.equal(f.requests.length,1);
  await f.timeout(); assert.equal(f.closed,0); assert.equal(f.timers.size,1);
  assert.equal(f.guard.complete(f.requests[0]),true);
  assert.equal(f.closed,1); assert.equal(f.guard.request(),false); assert.equal(f.timers.size,0);
});

test('保存失败保留窗口并允许再次关闭重试', () => {
  const f=fixture(); f.guard.request();
  assert.equal(f.guard.complete(f.requests[0],'磁盘不可写'),false);
  assert.equal(f.closed,0); assert.deepEqual(f.errors,['磁盘不可写']);
  f.guard.request(); assert.equal(f.requests.length,2);
  assert.equal(f.guard.complete(f.requests[0]),false);
  assert.equal(f.guard.complete(f.requests[1]),true);
});

test('取消关闭后忽略迟到的保存成功，新请求独立处理', async () => {
  const f=fixture(async()=>'cancel'); f.guard.request(); const old=f.requests[0];
  await f.timeout(); assert.deepEqual(f.cancelled,[old]);
  assert.equal(f.guard.complete(old),false); assert.equal(f.closed,0);
  f.guard.request(); assert.equal(f.guard.complete(old),false);
  f.guard.complete(f.requests[1]); assert.equal(f.closed,1);
});

test('只有明确放弃才允许跳过未完成保存', async () => {
  const f=fixture(async()=>'discard'); f.guard.request();
  await f.timeout(); assert.equal(f.closed,1); assert.equal(f.guard.request(),false);
});
