/* Fabula 主进程数据层：工程的打开/创建/保存、镜头图片写入、原子写、fs.watch 转发。
   纯模型逻辑在 projectModel.cjs（无 electron 依赖）。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { newProjectModel, normalizeProject, sanitizeShot, genId, genAssetId, ASSET_ID_RE, SHOT_ID_RE } = require('./projectModel.cjs');

const PTR_FILE = path.join(os.homedir(), '.fabula', 'current-project.json');

const state = {
  win: null,          // BrowserWindow（watch 通知用）
  root: null,         // 当前工程根目录（绝对路径）
  project: null,      // normalizeProject 后的模型
  watcher: null,
  lastJson: '',       // 上次成功落盘的 JSON 文本（watch 回环抑制）
  selfWriteAt: 0
};

/* ---------- 原子写：tmp + rename，读者（渲染端/agent）永远看到完整文件 ---------- */
function writeAtomic(absPath, data) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = absPath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, absPath);
}

function writeJsonAtomic(absPath, obj) {
  const text = JSON.stringify(obj, null, 2);
  writeAtomic(absPath, text);
  return text;
}

function pointerPath() { return PTR_FILE; }

/* MCP server 通过指针文件定位当前工程；Fabula 打开/创建工程时同步更新 */
function writePointer(root) {
  try {
    writeAtomic(PTR_FILE, JSON.stringify({ project: root.split(path.sep).join('/') }, null, 2));
  } catch (_) { /* 指针写失败不阻断主流程（MCP 侧读不到时报清晰错误） */ }
}

/* ---------- 打开 / 创建 / 保存 ---------- */

function openDir(dirPath) {
  const root = path.normalize(path.resolve(dirPath));
  const jsonPath = path.join(root, 'fabula.json');
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    throw new Error('不是有效的 Fabula 工程（读取 fabula.json 失败）：' + e.message);
  }
  const project = normalizeProject(raw);
  setProject(root, project);
  return snapshot();
}

function createProject(dirPath, name) {
  const root = path.normalize(path.resolve(dirPath));
  if (fs.existsSync(path.join(root, 'fabula.json'))) {
    throw new Error('目录已存在 fabula.json：' + root);
  }
  const project = newProjectModel(name);
  writeJsonAtomic(path.join(root, 'fabula.json'), project);
  fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
  fs.mkdirSync(path.join(root, 'audio'), { recursive: true });
  return openDir(root);
}

function saveProject(incoming) {
  if (!state.root) throw new Error('没有打开的工程');
  const project = normalizeProject(incoming);
  const text = writeJsonAtomic(path.join(state.root, 'fabula.json'), project);
  state.project = project;
  state.lastJson = text;
  state.selfWriteAt = Date.now();
  return snapshot();
}

/* 渲染端把画布导出为 PNG dataURL 写入指定镜头 */
function writeShotImage(shotId, dataUrl) {
  if (!state.root) throw new Error('没有打开的工程');
  if (typeof shotId !== 'string' || !SHOT_ID_RE.test(shotId)) throw new Error('非法镜头 id');
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error('只接受 PNG dataURL');
  }
  const b64 = dataUrl.slice('data:image/png;base64,'.length);
  const buf = Buffer.from(b64, 'base64');
  /* PNG magic bytes 校验：内容与声明必须一致 */
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('PNG 内容校验失败');

  let shot = state.project.shots.find(s => s.id === shotId);
  if (!shot) { shot = sanitizeShot({ id: shotId }); state.project.shots.push(shot); }
  const rel = 'shots/' + shotId + '.png';
  writeAtomic(path.join(state.root, rel), buf);
  shot.image = rel;
  state.lastJson = writeJsonAtomic(path.join(state.root, 'fabula.json'), state.project);
  state.selfWriteAt = Date.now();
  return snapshot();
}

function snapshot() {
  return { root: state.root, project: state.project };
}

function setProject(root, project) {
  state.root = root;
  state.project = project;
  try { state.lastJson = JSON.stringify(project, null, 2); } catch (_) {}
  writePointer(root);
  startWatch(root);
}

/* ---------- fs.watch：外部（agent）变更 → 通知渲染端 ---------- */

function startWatch(root) {
  if (state.watcher) { try { state.watcher.close(); } catch (_) {} state.watcher = null; }
  try {
    state.watcher = fs.watch(root, { recursive: true }, () => scheduleNotify());
  } catch (e) {
    console.error('[fabula] fs.watch 启动失败：', e.message);
  }
}

let notifyTimer = null;
function scheduleNotify() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    notifyChanged();
  }, 350);
}

/* 回环抑制：读回磁盘上的 fabula.json，与内存 lastJson 一致 → 是自己写的，忽略。
   不一致（agent 改过）→ 重读模型 + 通知渲染端。 */
function notifyChanged() {
  if (!state.root || !state.win) return;
  let external = false;
  try {
    const disk = JSON.parse(fs.readFileSync(path.join(state.root, 'fabula.json'), 'utf8'));
    external = JSON.stringify(disk, null, 2) !== state.lastJson;
  } catch (_) { external = false; }   // JSON 正被写一半（tmp rename 原子性保证不会读到半截；读不到就不误报）
  if (external) {
    try { state.project = normalizeProject(fs.readFileSync(path.join(state.root, 'fabula.json'), 'utf8')); } catch (_) {}
    try { state.lastJson = JSON.stringify(state.project, null, 2); } catch (_) {}
  }
  try {
    state.win.webContents.send('project:changed', { external, at: Date.now() });
  } catch (_) {}
}

/* ---------- 素材导入（媒体库）：按内容判别类型，复制进工程，原子写 ---------- */

/* magic bytes 判别：图片 / 音频 / 不认识（拒收）——内容与扩展名无关，防伪装 */
function sniffAsset(buf) {
  if (buf.length < 12) return null;
  const s = (a, b) => buf.subarray(a, b).toString('latin1');
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image';   // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image';                     // JPEG
  if (s(0, 3) === 'GIF') return 'image';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'image';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'audio';                                 // WAV
  if (s(0, 4) === 'OggS') return 'audio';
  if (s(0, 4) === 'fLaC') return 'audio';
  if (s(0, 3) === 'ID3') return 'audio';                                                          // MP3
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio';                                // MP3 帧同步
  if (s(4, 8) === 'ftyp') return 'audio';                                                         // M4A/MP4 音频
  return null;
}

const ASSET_MAX_BYTES = 96 * 1024 * 1024;

function importAssets(filePaths) {
  if (!state.root) throw new Error('没有打开的工程');
  const added = [];
  let skipped = 0;
  for (const src of (filePaths || []).slice(0, 64)) {
    try {
      const buf = fs.readFileSync(src);
      if (buf.length === 0 || buf.length > ASSET_MAX_BYTES) { skipped++; continue; }
      const kind = sniffAsset(buf);
      if (!kind) { skipped++; continue; }
      const id = genAssetId();
      let ext = path.extname(src).toLowerCase().replace(/[^.a-z0-9]/g, '');
      if (!ext || ext.length > 6) ext = kind === 'image' ? '.png' : '.mp3';
      const rel = 'assets/' + kind + '/' + id + ext;
      writeAtomic(path.join(state.root, rel), buf);
      state.project.assets.push({
        id,
        name: path.basename(src, path.extname(src)).slice(0, 120) || '素材',
        kind, path: rel, group: null
      });
      added.push(id);
    } catch (_) { skipped++; }
  }
  state.lastJson = writeJsonAtomic(path.join(state.root, 'fabula.json'), state.project);
  state.selfWriteAt = Date.now();
  return Object.assign(snapshot(), { added: added.length, skipped });
}

function attachWindow(win) { state.win = win; }
function current() { return snapshot(); }
function makeId() { return genId(); }

module.exports = { openDir, createProject, saveProject, writeShotImage, importAssets, current, attachWindow, pointerPath, writePointer, normalizeProject };
