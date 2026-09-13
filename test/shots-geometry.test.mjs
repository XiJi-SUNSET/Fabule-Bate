/* 镜头时间轴几何：start 按 duration 连续累加、无间隙
   （agent/mcp-server.mjs 的 starts() 与模型归一化的共同约定）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../main/projectModel.cjs');

/* 与 mcp-server 同规则：按 duration 累加，无间隙 */
function starts(shots) {
  const out = [];
  let acc = 0;
  for (const s of shots) { out.push(acc); acc += s.duration; }
  return out;
}

test('镜头按 duration 连续排布，start 无间隙', () => {
  const p = M.normalizeProject({ shots: [{ duration: 2 }, { duration: 3.5 }, { duration: 1 }] });
  assert.deepEqual(starts(p.shots), [0, 2, 5.5]);
});

test('非法 duration 被修复为默认 3，几何仍连续', () => {
  const p = M.normalizeProject({ shots: [{ duration: -1 }, { duration: 'x' }, { duration: 0 }] });
  assert.deepEqual(p.shots.map((s) => s.duration), [3, 3, 3]);
  assert.deepEqual(starts(p.shots), [0, 3, 6]);
});

test('归一化保持 shots 数组顺序（顺序即镜头顺序）', () => {
  const p = M.normalizeProject({
    shots: [
      { description: { content: 'A' } },
      { description: { content: 'B' } },
      { description: { content: 'C' } },
    ],
  });
  assert.deepEqual(p.shots.map((s) => s.description.content), ['A', 'B', 'C']);
});

test('shots 数量上限收敛（防超长数组拖垮归一化）', () => {
  const big = Array.from({ length: 2100 }, (_, i) => ({ description: { content: 'x' + i } }));
  const p = M.normalizeProject({ shots: big });
  assert.equal(p.shots.length, 2048);
});
