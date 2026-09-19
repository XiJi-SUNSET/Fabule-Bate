/* Fabula 主进程数据层：工程的打开/创建/保存、镜头图片写入、原子写、fs.watch 转发。
   纯模型逻辑在 projectModel.cjs（无 electron 依赖）。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { newProjectModel, normalizeProject, sanitizeShot, sanitizeAsset, genAssetId, SHOT_ID_RE } = require('./projectModel.cjs');

const PTR_FILE = path.join(os.homedir(), '.fabula', 'current-project.json');

const state = {
  win: null,          // BrowserWindow（watch 通知用）
  root: null,         // 当前工程根目录（绝对路径）
  project: null,      // normalizeProject 后的模型（fabula.json，冒烟自检用）
  watcher: null,
  lastJson: '',       // 上次成功落盘的 fabula.json 文本（watch 回环抑制）
  lastMontage: null,  // 上次已知的 montage.json 文本（null = 尚未建立基线）
  mediaFiles: new Set()    // boards/shots/assets 下"外部"改动的文件（N-A5）
};

/* 自写媒体抑制（N-A5 修订）：UI 保存帧图/素材经 project:writeFile 落盘，
   同样会触发 watch —— 不抑制的话每次自动保存都会被当成"外部写入"，
   广播 media 打断作画（弹提示、清缓存、重读当前帧）。 */
const selfMedia = new Map();     // rel -> 时间戳
const SELF_MEDIA_WINDOW_MS = 5000;
function markSelfMedia(rel) {
  if (typeof rel !== 'string') return;
  selfMedia.set(rel, Date.now());
  if (selfMedia.size > 64) {                       // 兜底清理：不无限增长
    const now = Date.now();
    for (const [k, v] of selfMedia) if (now - v > 30000) selfMedia.delete(k);
  }
}
/* watch 回调消费：true = 这次变化是自己写的（吞掉）。
   窗口期内**持续生效、不删除**——Windows 上一次写入常产生多个 watch 事件，
   消费一次即删会让后续事件误报成"外部写入"（实测验证过）。 */
function consumeSelfMedia(rel) {
  const ts = selfMedia.get(rel);
  if (!ts) return false;
  if (Date.now() - ts > SELF_MEDIA_WINDOW_MS) { selfMedia.delete(rel); return false; }
  return true;
}

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

/* saveProject 已删（N-B7）：project:save 通道移除后无人调用，
   且它会把渲染端模型 normalize 成 shots 模型写 fabula.json（埋雷函数本体）。
   真实保存走渲染端 → project:writeFile → montage.json。 */

/* 把内存模型规范化后写回 fabula.json，并同步"已知基线"（lastJson）。
   为什么写盘前也要 normalize：notifyChanged 判定"外部变更"时拿【磁盘 normalize 后】
   与 lastJson 比较；若写盘对象未经规范化，两边口径不一致会永久误报
   （实例：中文名素材被旧的 sanitizeAsset 路径规则丢弃 → 每次保存 montage.json
   触发的 watch 都会误报"外部更新了工程数据"，用户反馈）。 */
function persistModel() {
  state.project = normalizeProject(state.project);
  state.lastJson = writeJsonAtomic(path.join(state.root, 'fabula.json'), state.project);
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
  /* 与素材导入的 96MB 上限对齐（L-13）：dataURL 无上限时一个超大帧会把内存吃穿 */
  if (buf.length === 0 || buf.length > 96 * 1024 * 1024) throw new Error('帧图片为空或超过 96MB');
  /* PNG magic bytes 校验：内容与声明必须一致 */
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('PNG 内容校验失败');

  let shot = state.project.shots.find(s => s.id === shotId);
  if (!shot) { shot = sanitizeShot({ id: shotId }); state.project.shots.push(shot); }
  const rel = 'shots/' + shotId + '.png';
  writeAtomic(path.join(state.root, rel), buf);
  shot.image = rel;
  persistModel();
  markSelfMedia(rel);      // M-15：帧图是自身写入，登记后在 watch 里不当作"外部媒体变更"广播
  return snapshot();
}

function snapshot() {
  return { root: state.root, project: state.project };
}

function setProject(root, project) {
  state.root = root;
  state.project = project;
  try { state.lastJson = JSON.stringify(project, null, 2); } catch (_) {}
  /* montage.json 的"已知文本"基线：watch 用它判定外部（Agent/手改）变更 */
  try { state.lastMontage = fs.readFileSync(path.join(root, 'montage.json'), 'utf8'); }
  catch (_) { state.lastMontage = null; }
  writePointer(root);
  startWatch(root);
}

/* 渲染端经 IPC（project:writeFile）写工程文件后调用：记下我们自己写的
   montage.json 文本，避免 UI 的每次保存都被 watch 当成外部变更广播（回环抑制）。 */
function markSelfWrite(rel, text) {
  if (rel === 'montage.json') state.lastMontage = text;
}

/* ---------- fs.watch：外部（agent）变更 → 通知渲染端 ---------- */

/* watch 名字 → 媒体采集判定（抽成独立函数便于测试与复用）。
   规则（实测复现教训）：
   · writeAtomic 的中间态临时文件（xxx.tmp-<pid>-<ts>）**不计入媒体变更** ——
     watch 捕获的是 tmp 名而自写登记（markSelfMedia）用正式名，直接比对会全部漏吞，
     导致每次保存/播放切帧 flush 都被误报"外部更新"（files 全是 .tmp- 名）；
   · 正式名的"自己写的"由 consumeSelfMedia 吞掉（N-A5）；
   · 正式名的未登记事件（外部直写，如 MCP set_shot_image）照常采集。 */
function noteWatchName(name) {
  if (!name) return;
  const n = String(name).replace(/\\/g, '/');
  if (/\.tmp-\d+-\d+$/.test(n)) return;
  if (n.startsWith('boards/') || n.startsWith('shots/') || n.startsWith('assets/')) {
    if (!consumeSelfMedia(n)) state.mediaFiles.add(n);
  }
}

function startWatch(root) {
  if (state.watcher) { try { state.watcher.close(); } catch (_) {} state.watcher = null; }
  try {
    state.watcher = fs.watch(root, { recursive: true }, (_ev, name) => {
      /* 媒体文件（帧图/素材）变化也要标记（Agent 纯换图不改任何 JSON）；
         自写吞掉与 tmp 过滤见 noteWatchName（N-A5 修订 + 误报根因修复） */
      noteWatchName(name);
      /* 锁文件（montage.json.lock）是写事务的内部产物、不承载内容：
         过滤掉，避免每次保存都空跑一轮变更判定（广播里也只剩噪声） */
      if (/\.lock$/.test(String(name || '').replace(/\\/g, '/'))) return;
      scheduleNotify();
    });
    /* 被监视目录被删/掉线时 error 不监听会变 uncaughtException（L-14） */
    state.watcher.on('error', (e) => {
      console.error('[fabula] fs.watch 错误：', e.message);
      try { state.watcher.close(); } catch (_) {}
      state.watcher = null;
    });
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
  const sources = [];
  /* fabula.json（主进程/MCP 旧链路 + 冒烟自检模型） */
  let fabulaChanged = false;
  try {
    const disk = JSON.parse(fs.readFileSync(path.join(state.root, 'fabula.json'), 'utf8'));
    /* 口径对称比较（M-6 加强）：磁盘与内存**都**过 normalizeProject 再比。
       只比 lastJson 在"内存模型与规范化结果不一致"时会永久错位、持续误报
       （实例：中文名素材写盘后被旧路径规则丢弃 → 每次保存都弹"外部更新"）；
       与"当前内存模型归一化后"相同也视为自己人（自写产生的等效态）。 */
    const diskNorm = JSON.stringify(normalizeProject(disk), null, 2);
    let memNorm = '';
    try { memNorm = state.project ? JSON.stringify(normalizeProject(state.project), null, 2) : ''; } catch (_) {}
    fabulaChanged = diskNorm !== state.lastJson && diskNorm !== memNorm;
  } catch (_) { fabulaChanged = false; }   // JSON 正被写一半（tmp rename 原子性保证不会读到半截；读不到就不误报）
  if (fabulaChanged) {
    sources.push('fabula');
    try { state.project = normalizeProject(fs.readFileSync(path.join(state.root, 'fabula.json'), 'utf8')); } catch (_) {}
    try { state.lastJson = JSON.stringify(state.project, null, 2); } catch (_) {}
  }
  /* montage.json（UI + Agent 的工程真相，H-2）：与"最后一次已知文本"比较。
     基线 null（新建工程尚未写过）时文件首次出现视为外部创建（N-B20）。 */
  try {
    const text = fs.readFileSync(path.join(state.root, 'montage.json'), 'utf8');
    if (state.lastMontage === null) {
      state.lastMontage = text;
      sources.push('montage');
    } else if (text !== state.lastMontage) {
      state.lastMontage = text;            // 收敛：广播一次后即视为已知
      sources.push('montage');
    }
  } catch (_) {}
  /* 媒体文件变化（Agent 换图/导素材）：JSON 无变化也要通知 UI——
     带文件清单，渲染端只处理真正相关的（当前帧被改才提示/重读）（N-A5） */
  let mediaFiles = [];
  if (state.mediaFiles.size) {
    mediaFiles = [...state.mediaFiles];
    state.mediaFiles.clear();
    sources.push('media');
  }
  try {
    state.win.webContents.send('project:changed', {
      external: sources.length > 0, sources, files: mediaFiles, at: Date.now(),
    });
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
  if (s(4, 8) === 'ftyp') {
    /* ISO-BMFF 容器：只有 M4A/M4B 品牌可确认为纯音频；
       其余（isom/mp42/avc1…）多为视频，拒收而不是误当音频导入（L-15） */
    const brand = s(8, 12);
    return (brand === 'M4A ' || brand === 'M4B ') ? 'audio' : null;
  }
  return null;
}

const ASSET_MAX_BYTES = 96 * 1024 * 1024;

function importAssets(filePaths) {
  if (!state.root) throw new Error('没有打开的工程');
  const added = [];
  let skipped = 0;
  const copied = [];                    // 已落盘媒体：清单写失败时回滚（M-4）
  for (const src of (filePaths || []).slice(0, 64)) {
    try {
      const buf = fs.readFileSync(src);
      if (buf.length === 0 || buf.length > ASSET_MAX_BYTES) { skipped++; continue; }
      const kind = sniffAsset(buf);
      if (!kind) { skipped++; continue; }
      const id = genAssetId();
      let ext = path.extname(src).toLowerCase().replace(/[^.a-z0-9]/g, '');
      if (!ext || ext.length > 7) ext = kind === 'image' ? '.png' : '.mp3';
      /* 磁盘文件名保留原名（净化非法字符 + 重名 -1/-2 去重；允许中文），
         与 MCP import_assets / 渲染端 U.safeFileName 同一规则 —— 此前用素材 id 命名
         （哈希形态），用户打开 assets 文件夹无法辨认文件（用户反馈）。
         边缘防护：主干去首点（防 ".." 路径前缀）/去尾点空格（Windows 会剥尾点造成名字漂移） */
      let base = path.basename(src, path.extname(src))
        .replace(/[^A-Za-z0-9._\u4e00-\u9fa5-]/g, '_')
        .slice(0, 80);
      base = base.replace(/^\.+/, '_').replace(/[. ]+$/, '') || 'asset';
      let fname = base + ext, n = 0;
      while (fs.existsSync(path.join(state.root, 'assets', kind, fname))) {
        fname = base + '-' + (++n) + ext;
      }
      const rel = 'assets/' + kind + '/' + fname;
      /* 先过与"外部变更判定"同一套规范（sanitizeAsset）：不合规的名字在源头拒收，
         而不是"写进 fabula.json → 下次 normalize 悄悄丢掉 → 基线与清单永久错位" */
      const asset = sanitizeAsset({
        id,
        name: path.basename(src, path.extname(src)).slice(0, 120) || '素材',
        kind, path: rel, group: null
      });
      if (!asset) { skipped++; continue; }
      writeAtomic(path.join(state.root, rel), buf);
      copied.push(rel);
      markSelfMedia(rel);      // 导入也是自身写入：不登记的话每次导入都被当成外部媒体变更广播
      state.project.assets.push(asset);
      added.push(id);
    } catch (_) { skipped++; }
  }
  try {
    persistModel();
  } catch (e) {
    /* 清单写失败：删除本轮刚落盘的媒体并回滚内存清单，避免"有文件无清单"的孤儿素材（M-4） */
    for (const rel of copied) { try { fs.rmSync(path.join(state.root, rel), { force: true }); } catch (_) {} }
    state.project.assets = state.project.assets.filter((a) => added.indexOf(a.id) < 0);
    throw e;
  }
  /* addedPaths：本次复制进工程的文件相对路径清单。
     渲染端据此**精确**补录新素材，而不是全盘扫描 ——
     全盘扫描会把 assets/ 里的历史遗留文件也一并收进素材库（"导入一个出现两条"）。 */
  return Object.assign(snapshot(), { added: added.length, skipped, addedPaths: copied.slice() });
}

/* 渲染端删除素材后同步主进程清单：按相对路径从 fabula.json 的 assets 里移除。
   只动清单不碰磁盘（磁盘文件的回收由渲染端经 project:trashFile 完成）。 */
function removeAssets(rels) {
  if (!state.root) return { removed: 0 };
  const want = new Set((Array.isArray(rels) ? rels : [])
    .slice(0, 4096)
    .map((r) => String(r || '').replace(/\\/g, '/'))
    .filter(Boolean));
  if (!want.size) return { removed: 0 };
  const before = state.project.assets.length;
  state.project.assets = state.project.assets.filter((a) => !want.has(a.path));
  const removed = before - state.project.assets.length;
  if (removed) {
    try {
      persistModel();
    } catch (e) {
      console.error('[fabula] removeAssets 清单写入失败：', e.message);
    }
  }
  return { removed };
}

function attachWindow(win) { state.win = win; }
function current() { return snapshot(); }

module.exports = {
  openDir, createProject, writeShotImage, importAssets, removeAssets,
  current, attachWindow,
  writeAtomic,                      // main.js 的 writeFile/备份导出共用（原子写）
  markSelfWrite,                    // main.js 写 montage.json 后登记（watch 回环抑制）
  markSelfMedia,                    // main.js 写帧图/素材后登记（N-A5 修订）
  /* 测试探针（test/project-store.test.mjs）：直接驱动变更判定，不拉起 fs.watch */
  __test: { notifyChanged, state, consumeSelfMedia, selfMedia, noteWatchName },
};
