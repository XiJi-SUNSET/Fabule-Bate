/* Fabula 工程数据模型 —— 纯逻辑，无 electron 依赖（node:test 可直接测）。
   工程格式 v2：
     <project>/fabula.json   { version, name, fps, boardW, boardH, tagOptions,
                               shots: [...], groups: [...], assets: [...] }
     <project>/shots/*.png   镜头图片（相对路径引用）
     <project>/assets/image/ 图片素材（参考图）
     <project>/assets/audio/ 音频素材
     <project>/audio/        （v1 预留目录，保留兼容）
   shots 数组的顺序即镜头顺序（显式 order）；镜号由渲染端按序派生，不落盘。
   v1 → v2 迁移：补 groups/assets 空数组（normalizeProject 统一收敛）。 */

const FORMAT_VERSION = 2;
const SHOT_ID_RE = /^sh_[0-9a-f]{8}$/;
const ASSET_ID_RE = /^as_[0-9a-f]{8}$/;
const ASSET_KINDS = ['image', 'audio'];
/* 素材路径只允许工程内 assets/{image,audio}/ 下的相对路径（防穿越） */
const ASSET_PATH_RE = /^assets\/(image|audio)\/[A-Za-z0-9._-]+$/;

/* description 结构采纳 montage 分镜表的已验证字段集：
   content/dialogue/sfx/notes 为自由文本，size/move/lens/trans 为软枚举（值即自由字符串，
   tagOptions 只提供候选）。全部为字符串，agent 逐键读写、可增量编辑。 */
const DESCRIPTION_KEYS = ['content', 'dialogue', 'sfx', 'size', 'move', 'lens', 'trans', 'notes'];

const TAG_DEFAULTS = {
  size: ['大远景', '远景', '全景', '中全景', '中景', '中近景', '近景', '特写', '大特写'],
  move: ['固定', '横摇', '俯仰', '横移', '升降', '轨道推拉', '变焦推拉', '正跟随', '倒跟随', '环绕', '滑轨横移'],
  lens: ['14mm', '18mm', '24mm', '35mm', '50mm', '85mm', '100mm', '135mm'],
  trans: ['切', '叠化', '划变', '淡入', '淡出', '黑场', '白场']
};

function genId() {
  let hex = '';
  for (let i = 0; i < 8; i++) hex += '0123456789abcdef'[(Math.random() * 16) | 0];
  return 'sh_' + hex;
}

function genAssetId() {
  let hex = '';
  for (let i = 0; i < 8; i++) hex += '0123456789abcdef'[(Math.random() * 16) | 0];
  return 'as_' + hex;
}

function asStr(v) { return typeof v === 'string' ? v : ''; }

function normalizeDescription(raw) {
  const out = {};
  for (const k of DESCRIPTION_KEYS) out[k] = asStr(raw && raw[k]);
  return out;
}

function sanitizeShot(raw) {
  const shot = {
    id: (raw && typeof raw.id === 'string' && SHOT_ID_RE.test(raw.id)) ? raw.id : genId(),
    image: null,
    description: normalizeDescription(raw && raw.description),
    duration: (raw && typeof raw.duration === 'number' && isFinite(raw.duration) && raw.duration > 0)
      ? raw.duration : 3
  };
  const img = raw && typeof raw.image === 'string' ? raw.image : null;
  /* image 必须指向工程内 shots/ 目录，防穿越；不合法一律归 null（空镜头） */
  if (img && /^shots\/[A-Za-z0-9._-]+$/.test(img) && img.endsWith('.png')) shot.image = img;
  return shot;
}

function newProjectModel(name) {
  return {
    version: FORMAT_VERSION,
    name: asStr(name) || '未命名工程',
    fps: 24,
    boardW: 1280,
    boardH: 720,
    tagOptions: JSON.parse(JSON.stringify(TAG_DEFAULTS)),
    shots: [],
    groups: [],
    assets: []
  };
}

/* 素材条目（媒体库：图片参考图 / 音频）。kind 与 path 前缀必须一致。 */
function sanitizeAsset(raw) {
  const kind = (raw && ASSET_KINDS.includes(raw.kind)) ? raw.kind : null;
  if (!kind) return null;
  const p = raw && typeof raw.path === 'string' ? raw.path : '';
  if (!ASSET_PATH_RE.test(p) || !p.startsWith('assets/' + kind + '/')) return null;
  return {
    id: (raw && typeof raw.id === 'string' && ASSET_ID_RE.test(raw.id)) ? raw.id : genAssetId(),
    name: asStr(raw && raw.name).slice(0, 120) || '素材',
    kind,
    path: p,
    group: (raw && typeof raw.group === 'string' && raw.group) ? raw.group : null
  };
}

function sanitizeGroup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  const name = asStr(raw.name).slice(0, 60);
  if (!id || !name) return null;
  return { id, name };
}

/* 任何来自磁盘/agent/IPC 的工程 JSON 都要过这里：修形、补默认、剔除非法字段。
   永远返回一个结构完整的工程对象，绝不抛异常。 */
function normalizeProject(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const p = newProjectModel(src.name);
  if (typeof src.fps === 'number' && src.fps > 0 && src.fps <= 120) p.fps = src.fps;
  if (typeof src.boardW === 'number' && src.boardW >= 320 && src.boardW <= 4096) p.boardW = Math.round(src.boardW);
  if (typeof src.boardH === 'number' && src.boardH >= 180 && src.boardH <= 4096) p.boardH = Math.round(src.boardH);
  if (src.tagOptions && typeof src.tagOptions === 'object') {
    for (const k of Object.keys(TAG_DEFAULTS)) {
      const v = src.tagOptions[k];
      if (Array.isArray(v)) p.tagOptions[k] = v.filter(x => typeof x === 'string').slice(0, 64);
    }
  }
  if (Array.isArray(src.shots)) {
    const seen = new Set();
    for (const s of src.shots.slice(0, 2048)) {
      const shot = sanitizeShot(s);
      while (seen.has(shot.id)) shot.id = genId();   // 修 id 冲突
      seen.add(shot.id);
      p.shots.push(shot);
    }
  }
  /* v1 → v2 迁移：老工程没有 groups/assets —— 上面 newProjectModel 已补空数组，
     这里只做既有数据的收敛校验 */
  const groupIds = new Set();
  if (Array.isArray(src.groups)) {
    for (const g of src.groups.slice(0, 256)) {
      const grp = sanitizeGroup(g);
      if (grp && !groupIds.has(grp.id)) { groupIds.add(grp.id); p.groups.push(grp); }
    }
  }
  if (Array.isArray(src.assets)) {
    const seen = new Set();
    for (const a of src.assets.slice(0, 4096)) {
      const asset = sanitizeAsset(a);
      if (!asset) continue;                          // 路径不合规直接丢弃
      while (seen.has(asset.id)) asset.id = genAssetId();
      seen.add(asset.id);
      if (asset.group && !groupIds.has(asset.group)) asset.group = null;   // 悬空组引用归零
      p.assets.push(asset);
    }
  }
  return p;
}

module.exports = { FORMAT_VERSION, SHOT_ID_RE, ASSET_ID_RE, ASSET_KINDS, DESCRIPTION_KEYS, TAG_DEFAULTS, genId, genAssetId, newProjectModel, normalizeProject, sanitizeShot, sanitizeAsset, normalizeDescription };
