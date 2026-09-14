/* 探针回归测试（R3 B-3）：压感/轮盘/时间轴三个探针此前"写了不跑"——
   这里用 --smoke-eval 驱动真 Electron 进程并对关键读数断言。
   与 mcp-server.test 同法：spawn 真进程；无 electron 二进制时跳过。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const logPath = path.join(root, 'smoke.log');
const canRun = fs.existsSync(electron);

function runProbe(expr) {
  try { fs.rmSync(logPath, { force: true }); } catch (_) {}
  const r = spawnSync(electron, ['.', '--smoke', '--smoke-play', '--smoke-eval=' + expr],
    { cwd: root, timeout: 90000, encoding: 'utf8' });
  assert.equal(r.status, 0, 'electron 退出码 ' + r.status + '（' + (r.error || '') + '）');
  const log = fs.readFileSync(logPath, 'utf8');
  const line = log.split('\n').find((l) => l.indexOf('[smoke-eval]') >= 0);
  assert.ok(line, 'smoke.log 缺少 [smoke-eval] 输出');
  return JSON.parse(line.slice(line.indexOf('[smoke-eval]') + '[smoke-eval]'.length));
}

test('探针回归：压感管线（penProbe）', { skip: !canRun }, () => {
  const o = runProbe('window.__fabulaTest.penProbe()');
  assert.ok(!o.error, '探针异常：' + o.error);
  assert.equal(o.firstFrameOK, true, '起笔首帧不得塌陷（忠实映射 ≈0）');
  assert.equal(o.recoverOK, true, '真实压力到达后平滑链应追上 > 0.4');
  assert.equal(o.lightStrokeOK, true, '极轻接触必须立即落笔');
  assert.equal(o.faithfulOK, true, '压感忠实映射（0.7 明显大于 0.2）');
  assert.equal(o.zeroStrokeOK, true, '极轻零压起笔不得被判"无压感"');
  assert.equal(o.midStrokeOK, true, '极轻起笔后段必须跟随真实压力（非速度驱动）');
});

test('探针回归：轮盘右键 + 时间轴拖拽（radialProbe / tlDragProbe）', { skip: !canRun }, () => {
  const arr = runProbe('[window.__fabulaTest.radialProbe(),window.__fabulaTest.tlDragProbe()]');
  assert.ok(Array.isArray(arr) && arr.length === 2, '双探针输出应为数组');
  const radial = JSON.parse(arr[0]);
  const tl = JSON.parse(arr[1]);
  assert.ok(!radial.error, '轮盘探针异常：' + radial.error);
  assert.equal(radial.radialOpenOK, true, '笔右键应呼出轮盘');
  assert.equal(radial.panOK, true, '抓手不得连带启动');
  assert.ok(!tl.error, '时间轴探针异常：' + tl.error);
  assert.equal(tl.reordered, true, '拖过邻居中线应触发重排');
});
