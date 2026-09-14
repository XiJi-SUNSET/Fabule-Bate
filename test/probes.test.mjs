/* 探针回归测试（R3 B-3 起）：
   用 --smoke-eval 驱动真 Electron 进程并对关键读数断言。
   · R5：接线补全（重命名含 IME / 素材生命周期 / 导入命名 / R5-2 拖拽兜底），
     并把"能不能跑"的判定从"exe 存在"改为"electron 能产出含 [smoke-eval] 的输出" ——
     受限环境（无 GUI / ELECTRON_RUN_AS_NODE）里是 skip（可诊断），而不是硬红/ENOENT。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const logPath = path.join(root, 'smoke.log');
const hasBinary = fs.existsSync(electron);

function launch(args, timeout) {
  try { fs.rmSync(logPath, { force: true }); } catch (_) {}
  return spawnSync(electron, args, { cwd: root, timeout: timeout || 90000, encoding: 'utf8' });
}

/* 从 stdout/stderr/smoke.log 三源里取 [smoke-eval] 行（R5 §4：此前只读文件，
   启动失败时直接 ENOENT，看不出原因） */
function grabEval(extra) {
  let t = String(extra || '');
  if (t.indexOf('[smoke-eval]') < 0) {
    try { t += '\n' + fs.readFileSync(logPath, 'utf8'); } catch (_) { /* 无文件 */ }
  }
  const line = t.split('\n').find((l) => l.indexOf('[smoke-eval]') >= 0);
  return line ? line.slice(line.indexOf('[smoke-eval]') + '[smoke-eval]'.length) : null;
}

/* 可用性探测：electron 能启动并产出 [smoke-eval] 才跑探针用例 */
const probeOK = hasBinary && (() => {
  try {
    const r = launch(['.', '--smoke', '--smoke-eval="probe-ok"'], 60000);
    return grabEval(String(r.stdout || '') + '\n' + String(r.stderr || '')) != null;
  } catch (_) { return false; }
})();
const skip = probeOK
  ? false
  : (hasBinary
    ? 'Electron 无法产出 smoke-eval 输出（无 GUI / ELECTRON_RUN_AS_NODE？）—— 跳过探针'
    : '未安装 electron 二进制 —— 跳过探针');

function runProbe(expr) {
  const r = launch(['.', '--smoke', '--smoke-play', '--smoke-eval=' + expr]);
  const out = grabEval(String(r.stdout || '') + '\n' + String(r.stderr || ''));
  assert.ok(out != null, '未捕获 [smoke-eval] 输出（electron 退出码 ' + r.status + '）');
  return JSON.parse(out);
}

test('探针回归：压感管线（penProbe）', { skip }, () => {
  const o = runProbe('window.__fabulaTest.penProbe()');
  assert.ok(!o.error, '探针异常：' + o.error);
  assert.equal(o.firstFrameOK, true, '起笔首帧不得塌陷（忠实映射 ≈0）');
  assert.equal(o.recoverOK, true, '真实压力到达后平滑链应追上 > 0.4');
  assert.equal(o.lightStrokeOK, true, '极轻接触必须立即落笔');
  assert.equal(o.faithfulOK, true, '压感忠实映射（0.7 明显大于 0.2）');
  assert.equal(o.zeroStrokeOK, true, '极轻零压起笔不得被判"无压感"');
  assert.equal(o.midStrokeOK, true, '极轻起笔后段必须跟随真实压力（非速度驱动）');
});

test('探针回归：轮盘右键 + 时间轴拖拽（radialProbe / tlDragProbe）', { skip }, () => {
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
  assert.equal(tl.snapExcludesSelf, true, '吸附候选排除自身（H-6 直测：距自身 < 容差也不吸附）');
});

test('探针回归：交互修复（不透明度 / 图层 / 弹窗作用域 / 删镜头）', { skip }, () => {
  const o = runProbe('window.__fabulaTest.interactionProbe(window.__fabulaSmokeDir)');
  assert.ok(!o.error, '探针异常：' + o.error);
  assert.equal(o.opacityScaleOK, true, '不透明度滑杆必须按百分数↔比例换算（20→0.2 / 100→1 / 1→0.01）');
  assert.equal(o.clampOK, true, '引擎 setParam 应把 >1 的 opacity 落回比例（污染兜底）');
  assert.equal(o.sanitizeOK, true, '旧的污染参数读回时应被修正，且滑杆回填为百分数');
  assert.equal(o.layerOK, true, '图层切换必须真正到达引擎（setLayer）');
  assert.equal(o.modalOK, true, '绘画弹窗期间方向键 / Delete / 切视图都不得改变工作台状态');
  assert.equal(o.delShotOK, true, '删镜头：二次确认 + 帧条目与磁盘文件一起清理');
  assert.equal(o.renderConcurrentOK, true, '并发 render 不得渲染出重复条目（H-14）');
});

test('探针回归：重命名（含 IME）/ 素材生命周期 / 导入命名', { skip }, () => {
  const r = runProbe('(async function(){ var o = {};'
    + ' o.rename = await window.__fabulaTest.groupRenameProbe();'
    + ' o.life = await window.__fabulaTest.assetLifecycleProbe(window.__fabulaSmokeDir);'
    + ' o.naming = await window.__fabulaTest.importNamingProbe();'
    + ' return JSON.stringify(o); })()');
  const ren = JSON.parse(r.rename);
  const life = JSON.parse(r.life);
  const nam = JSON.parse(r.naming);
  assert.ok(!ren.error, '重命名探针异常：' + ren.error);
  assert.equal(ren.renamedA, true, '直接输入 + 回车应写回新组名');
  assert.equal(ren.imeGuard, true, '输入法组合中按回车不得把上屏前的旧值写回');
  assert.equal(ren.renamedB, true, '输入法上屏（compositionend）后应自动提交新名');
  assert.ok(!life.error, '素材生命周期探针异常：' + life.error);
  assert.equal(life.ok, true, '素材：精确补录 / 删除不复活 / 磁盘副本回收 全链路');
  assert.ok(!nam.error, '导入命名探针异常：' + nam.error);
  assert.ok(Array.isArray(nam.assets), '导入命名探针应返回素材清单');
});

test('探针回归：拖拽兜底（dragGuardProbe · R5-2）', { skip }, () => {
  const o = runProbe('window.__fabulaTest.dragGuardProbe()');
  assert.ok(!o.error, '探针异常：' + o.error);
  assert.equal(o.clearedByRender, true, 'render 摘除被拖元素时 dragging 必须当场复位');
  assert.equal(o.clearedByWindowUp, true, 'window 级 pointerup 必须兜底复位');
  assert.equal(o.clearedByWindowCancel, true, 'window 级 pointercancel 必须兜底复位');
});
