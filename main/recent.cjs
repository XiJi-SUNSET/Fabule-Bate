/* 最近项目（Home 启动器）存储：~/.fabula/recent-projects.json（SMOKE 隔离到 SMOKE_ROOT）。
   条目 { root, name, shots, openedAt }；最新在前、去重（路径大小写不敏感）、上限 12；
   损坏文件容错为空表。纯 fs + 纯函数（file 可注入），test/recent.test.mjs 直接驱动。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MAX = 12;

function defaultFile() {
  const smoke = process.argv.some((a) => a === '--smoke' || a.startsWith('--smoke-'));
  if (smoke && process.env.FABULA_SMOKE_ROOT) {
    return path.join(process.env.FABULA_SMOKE_ROOT, 'recent-projects.json');
  }
  return path.join(os.homedir(), '.fabula', 'recent-projects.json');
}

function load(file) {
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && typeof e.root === 'string' && e.root)
      .map((e) => ({
        root: e.root,
        name: String(e.name || ''),
        shots: Number.isFinite(e.shots) ? e.shots : 0,
        openedAt: Number.isFinite(e.openedAt) ? e.openedAt : 0,
      }))
      .slice(0, MAX);
  } catch (_) { return []; }
}

function save(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file);
}

/* Windows 路径大小写不敏感：去重比较统一小写 */
function samePath(a, b) {
  try { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
  catch (_) { return false; }
}

function touch(file, root, meta, now) {
  const list = load(file).filter((e) => !samePath(e.root, root));
  list.unshift({
    root: path.resolve(root),
    name: String((meta && meta.name) || path.basename(root)),
    shots: Number.isFinite(meta && meta.shots) ? meta.shots : 0,
    openedAt: now || Date.now(),
  });
  const next = list.slice(0, MAX);
  save(file, next);
  return next;
}

function forget(file, root) {
  const list = load(file).filter((e) => !samePath(e.root, root));
  save(file, list);
  return list;
}

/* 启动器展示用：附"仍存在"标记 + 从 fabula.json 刷新名称/镜头数（读不到就沿用快照） */
function listLive(file) {
  return load(file).map((e) => {
    let exists = false, name = e.name, shots = e.shots;
    try {
      exists = fs.existsSync(path.join(e.root, 'fabula.json'))
        || fs.existsSync(path.join(e.root, 'montage.json'));
      const pj = JSON.parse(fs.readFileSync(path.join(e.root, 'fabula.json'), 'utf8'));
      if (pj && pj.name) name = String(pj.name);
      if (pj && Array.isArray(pj.shots)) shots = pj.shots.length;
    } catch (_) {}
    return { root: e.root, name, shots, openedAt: e.openedAt, exists };
  });
}

/* 安全门：启动器只允许打开"自己列表里"的路径（渲染端不可注入任意目录） */
function has(file, root) {
  return load(file).some((e) => samePath(e.root, root));
}

module.exports = { load, save, touch, forget, listLive, has, samePath, MAX, defaultFile };
