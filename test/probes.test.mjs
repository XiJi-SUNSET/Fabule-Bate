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
  /* smoke.log 可能因启动失败而缺失（此前直接 readFileSync 抛 ENOENT，看不出原因）：
     回退读 stdout/stderr，仍无输出时给出可诊断的断言信息 */
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf8'); } catch (_) { text = ''; }
  if (!text.trim()) text = String(r.stdout || '') + '\n' + String(r.stderr || '');
  const line = text.split('\n').find((l) => l.indexOf('[smoke-eval]') >= 0);
  assert.ok(line, '未捕获 [smoke-eval] 输出（smoke.log / stdout / stderr 均为空）');
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
  assert.equal(tl.thirdUntouched, true, '换位只交换两段：未触碰的第三段与间隔原地不动（H-4）');
  assert.equal(tl.snapFreeOK, true, '拖拽连续跟手：吸附候选不得含被拖片段自身（H-6）');
});

test('探针回归：交互修复（不透明度 / 图层 / 弹窗作用域 / 删镜头）', { skip: !canRun }, () => {
  const o = runProbe('window.__fabulaTest.interactionProbe(window.__fabulaSmokeDir)');
  assert.ok(!o.error, '探针异常：' + o.error);
  assert.equal(o.opacityScaleOK, true, '不透明度滑杆必须按百分数↔比例换算（20→0.2 / 100→1 / 1→0.01）');
  assert.equal(o.clampOK, true, '引擎 setParam 应把 >1 的 opacity 落回比例（污染兜底）');
  assert.equal(o.sanitizeOK, true, '旧的污染参数读回时应被修正，且滑杆回填为百分数');
  assert.equal(o.layerOK, true, '图层切换必须真正到达引擎（setLayer）');
  assert.equal(o.modalOK, true, '绘画弹窗期间方向键 / Delete / 切视图都不得改变工作台状态');
  assert.equal(o.delShotOK, true, '删镜头：二次确认 + 帧条目与磁盘文件一起清理');
});
