#!/usr/bin/env node
/* Fabula MCP server（stdio，零依赖手写实现）——供外部 agent（Claude Code 等）
   按视频脚本 / AI 生图编辑分镜：镜头图片、顺序、描述、时长等参数。
   工具边界：不含播放/缩放控制类工具（这些由人在 Fabula 里操作）。

   MCP stdio 传输 = 每行一条 JSON-RPC 2.0 消息（NDJSON）；
   覆盖 initialize / notifications/initialized / ping / tools/list / tools/call。
   不引 @modelcontextprotocol/sdk：其 zod 兼容层在本仓库环境存在版本互操作问题，
   而本 server 面窄（无资源/提示/采样），协议层手写全可控。

   工程定位（优先级）：工具参数 projectPath > 环境变量 FABULA_PROJECT >
   --project <dir> > 当前工程指针（Fabula 打开工程时写入 ~/.fabula/current-project.json）。
   模型（H-2 归一）：**直接读写渲染层工程文件 montage.json**（UI + Agent 同一份真相）。
   镜头 = kind:'board' 的 clip（含 meta 字段与时长）+ 其 board（boards/<id>.png 图片）。
   Agent 的写入经主进程 fs.watch 广播（project:changed, sources=['montage']）→ UI 自动同步；
   UI 的编辑同样落在这份文件上，Agent 读取即所见。 */
import fs from 'node:fs';
import path from 'node:path';

/* ════════ 工程读写（原子写 + 同源模型） ════════ */
const argv = process.argv.slice(2);
const argProject = (() => {
  const i = argv.indexOf('--project');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
})();

/* 当前工程指针：Fabula（Electron 主进程）打开/创建工程时写入。
   这让 agent 无需任何参数即可命中"Fabula 里正开着的工程"。 */
function readPointer() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const f = path.join(home, '.fabula', 'current-project.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return typeof j.project === 'string' && j.project ? j.project : null;
  } catch (_) { return null; }
}

function resolveProject(input) {
  const p = input || process.env.FABULA_PROJECT || argProject || readPointer();
  if (!p) {
    throw new Error('没有打开的 Fabula 工程：请传 projectPath 参数，或用 FABULA_PROJECT 环境变量，'
      + '或在 Fabula 里打开一个工程（指针文件会自动指明）');
  }
  const root = path.resolve(p);
  if (!fs.existsSync(path.join(root, 'montage.json'))) {
    throw new Error('不是 Fabula 工程（缺少 montage.json）：' + root
      + '；若该目录只有 fabula.json，请先在 Fabula 里打开一次该工程以生成它');
  }
  return root;
}

/* 保守修形：只补缺失的顶层字段/数组，绝不重排或丢弃未知字段
   （montage.json 是 UI 的完整工程文件，字段比 MCP 认识的多）。 */
function normalizeMontage(raw) {
  const p = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  p.version = p.version || 4;
  p.name = (typeof p.name === 'string' && p.name) ? p.name : '未命名分镜';
  p.fps = (typeof p.fps === 'number' && p.fps > 0) ? p.fps : 24;
  p.boardW = (typeof p.boardW === 'number' && p.boardW > 0) ? p.boardW : 1280;
  p.boardH = (typeof p.boardH === 'number' && p.boardH > 0) ? p.boardH : 720;
  for (const k of ['tracks', 'groups', 'clips', 'assets', 'boards']) {
    if (!Array.isArray(p[k])) p[k] = [];
  }
  if (!p.tracks.some((t) => t.kind === 'board')) {
    p.tracks.unshift({ id: 'tr_board_1', name: '分镜 V1', kind: 'board', h: 78, muted: false, groupId: null });
  }
  return p;
}

function readProject(root) {
  try {
    return normalizeMontage(JSON.parse(fs.readFileSync(path.join(root, 'montage.json'), 'utf8')));
  } catch (e) {
    throw new Error('montage.json 读取失败：' + e.message);
  }
}

function writeProject(root, proj) {
  const dst = path.join(root, 'montage.json');
  /* tmp 名带 pid + 时间戳（M-2）：固定名在双实例/双写时会互相覆盖 */
  const tmp = dst + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(proj, null, 2), 'utf8');
  /* 原子替换；Windows 下杀软/索引器短暂占用目标文件会 EBUSY/EPERM —— 小退避重试 */
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, dst); return; }
    catch (e) {
      if (i >= 4 || (e.code !== 'EBUSY' && e.code !== 'EPERM')) {
        try { fs.rmSync(tmp, { force: true }); } catch (_) {}
        throw e;
      }
      sleepSync((i + 1) * 40);
    }
  }
}

/* 同步 sleep：退避重试用（Atomics.wait 是零依赖的标准做法） */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/* 跨进程互斥（M-3）：主进程 / 其它 MCP 实例并发读-改-写会互相丢更新。
   用 O_EXCL 锁文件实现；陈死锁（>10s）自动清理，等待超时给出可重试的报错。 */
function withLock(root, fn) {
  const lock = path.join(root, 'montage.json.lock');
  const t0 = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > 10000) { fs.rmSync(lock, { force: true }); continue; }
      } catch (_) {}
      if (Date.now() - t0 > 5000) throw new Error('工程正被其它进程写入（montage.json.lock），请稍后重试');
      sleepSync(30);
    }
  }
  try { return fn(); }
  finally { try { fs.rmSync(lock, { force: true }); } catch (_) {} }
}

/* 读-改-写全程持锁的公共模式：所有写工具都经这里（M-3）。
   onWriteError：清单落盘失败时的回滚钩子（如 import_assets 删除刚复制的媒体，N-B16）。 */
function mutate(root, fn, onWriteError) {
  return withLock(root, () => {
    const proj = readProject(root);
    const r = fn(proj);
    try {
      writeProject(root, proj);
    } catch (e) {
      if (onWriteError) { try { onWriteError(e); } catch (_) {} }
      throw e;
    }
    return r;
  });
}

/* ════════ 模型辅助（与渲染端 board.js 同规则） ════════ */

/* id 生成：与 UI 的 util.uid 同构（prefix_ + base36×7） */
function genId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 9);
}

/* 镜头列表：轨道顺序 → 入点（与 board.js orderedShots 一致） */
function shotList(p) {
  const order = p.tracks.map((t) => t.id);
  return p.clips
    .filter((c) => c.kind === 'board')
    .slice()
    .sort((a, b) => (order.indexOf(a.trackId) - order.indexOf(b.trackId)) || ((a.start || 0) - (b.start || 0)));
}

/* 单轨内镜头（按 start 排序） */
function trackShots(p, trackId) {
  return p.clips
    .filter((c) => c.kind === 'board' && c.trackId === trackId)
    .slice()
    .sort((a, b) => (a.start || 0) - (b.start || 0));
}

/* 轨内重排：镜头首尾相接（与 UI 的 moveShot 语义一致）。
   orderedIds 给出期望顺序；省略时按现 start 排序。 */
function relayoutTrack(p, trackId, orderedIds) {
  const list = p.clips.filter((c) => c.kind === 'board' && c.trackId === trackId);
  let ordered;
  if (orderedIds) {
    const byId = new Map(list.map((c) => [c.id, c]));
    ordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
    for (const c of list) if (!ordered.includes(c)) ordered.push(c);
  } else {
    ordered = list.slice().sort((a, b) => (a.start || 0) - (b.start || 0));
  }
  if (!ordered.length) return;
  let acc = Math.max(0, ordered[0].start || 0);
  for (const c of ordered) { c.start = acc; acc += (+c.dur || 0); }
}

/* 镜头读形态：clip + board 展平（agent 最省 token 的扁平结构） */
function clipView(p, c, no) {
  const b = c.boardId ? p.boards.find((x) => x.id === c.boardId) : null;
  return Object.assign({
    id: c.id,
    no,
    duration: c.dur,
    start: c.start || 0,
    image: b ? b.path : null,
    boardId: c.boardId || null,
    trackId: c.trackId,
  }, c.meta || {});
}

function findClip(p, id) {
  const c = p.clips.find((x) => x.id === id && x.kind === 'board');
  if (!c) throw new Error('镜头不存在：' + id + '（可用 list_shots 查看全部 id）');
  return c;
}

/* description → meta：只接受已知键；notes 是 remark 的别名（agent 惯用词） */
const DESC_KEYS = ['content', 'dialogue', 'sfx', 'size', 'move', 'lens', 'trans', 'remark'];
const DESC_ALIAS = { notes: 'remark' };
function applyDescription(meta, description) {
  if (!description || typeof description !== 'object') return;
  for (const k of Object.keys(description)) {
    const t = DESC_ALIAS[k] || k;
    if (DESC_KEYS.includes(t) && typeof description[k] === 'string') meta[t] = description[k];
  }
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ content: [{ type: 'text', text: '错误：' + (e && e.message ? e.message : String(e)) }], isError: true });

/* ════════ 工具注册表 ════════ */
const T = [];
function tool(name, description, inputSchema, handler) { T.push({ name, description, inputSchema, handler }); }

const S = (desc) => ({ type: 'string', description: desc });
const N = (desc) => ({ type: 'number', description: desc });
const objOf = (props, required = []) => ({ type: 'object', properties: props, required });
const PP = { projectPath: S('工程文件夹路径（省略时用 Fabula 当前工程指针 / FABULA_PROJECT / --project）') };
const DESC_PROPS = {
  content: S('画面内容（一句话）'),
  dialogue: S('对白 / 旁白'),
  sfx: S('音效 / 音乐'),
  size: S('景别（如 远景 / 中景 / 特写）'),
  move: S('运镜（如 固定 / 横摇 / 推近）'),
  lens: S('焦段（如 24mm / 50mm）'),
  trans: S('转场（如 切 / 叠化）'),
  remark: S('备注（现场/道具/服装信息）'),
  notes: S('备注（与 remark 同义，写入同一字段）'),
};
const DESC_SCHEMA = objOf(DESC_PROPS);

/* —— 读：工程概览 —— */
tool(
  'get_project',
  '查看工程总览：名称、画幅、镜头数、总时长、轨道、分组与素材数。配合 list_shots 拿镜头 id。',
  objOf({ ...PP }),
  async ({ projectPath }) => {
    try {
      const root = resolveProject(projectPath);
      const p = readProject(root);
      const shots = shotList(p);
      return ok({
        root,
        name: p.name,
        fps: p.fps,
        board: p.boardW + 'x' + p.boardH,
        shotCount: shots.length,
        totalDuration: shots.reduce((a, c) => a + (+c.dur || 0), 0),
        tracks: p.tracks.map((t) => ({ id: t.id, name: t.name, kind: t.kind })),
        groups: p.groups,
        assetCount: p.assets.length,
        boardCount: p.boards.length,
        tagOptions: p.tagOptions || null,
      });
    } catch (e) { return fail(e); }
  },
);

/* —— 读：镜头列表 —— */
tool(
  'list_shots',
  '列出全部镜头（id / 镜号 / 时长 / 起始时间 / 画面路径 / 描述字段展开）。顺序＝时间轴顺序。',
  objOf({ ...PP }),
  async ({ projectPath }) => {
    try {
      const root = resolveProject(projectPath);
      const p = readProject(root);
      const shots = shotList(p);
      return ok({
        count: shots.length,
        totalDuration: shots.reduce((a, c) => a + (+c.dur || 0), 0),
        shots: shots.map((c, i) => clipView(p, c, i + 1)),
      });
    } catch (e) { return fail(e); }
  },
);

/* —— 读：单镜头 —— */
tool(
  'get_shot',
  '读取单个镜头：id / 镜号 / 时长 / 起始时间 / 图片路径 / 描述字段。',
  objOf({ id: S('镜头 id（cl_xxxxxxxx）'), ...PP }, ['id']),
  async ({ id, projectPath }) => {
    try {
      const root = resolveProject(projectPath);
      const p = readProject(root);
      const c = findClip(p, id);
      const shots = shotList(p);
      return ok(clipView(p, c, shots.indexOf(c) + 1));
    } catch (e) { return fail(e); }
  },
);

/* —— 写：新建 —— */
tool(
  'add_shot',
  '新建镜头（时间轴上一个分镜片段）。afterId 指定插在哪个镜头之后（省略 = 追加到末尾）；'
  + '新镜头自动获得一个画面位（boards/<id>.png，初始为空镜），可用 set_shot_image 填图。',
  objOf({
    afterId: S('插在该镜头之后；省略则追加到末尾'),
    duration: N('时长（秒），默认 3'),
    description: DESC_SCHEMA,
    ...PP,
  }),
  async ({ afterId, duration, description, projectPath }) => {
    try {
      const root = resolveProject(projectPath);
      return mutate(root, (p) => {
        /* 目标轨：afterId 所在的分镜轨，否则第一条分镜轨 */
        let track = null;
        if (afterId) {
          const anchor = findClip(p, afterId);
          track = p.tracks.find((t) => t.id === anchor.trackId && t.kind === 'board') || null;
          if (!track) throw new Error('afterId 不在分镜轨上：' + afterId);
        } else {
          track = p.tracks.find((t) => t.kind === 'board') || p.tracks[0];
        }
        if (!track) throw new Error('工程没有可用轨道');

        const bid = genId('bd');
        const board = {
          id: bid,
          name: '帧 ' + String(p.boards.length + 1).padStart(3, '0'),
          path: 'boards/' + bid + '.png',
          group: track.groupId || null,
        };
        const dur = (typeof duration === 'number' && isFinite(duration) && duration > 0) ? duration : 3;
        const clip = {
          id: genId('cl'),
          trackId: track.id,
          kind: 'board',
          boardId: bid,
          name: board.name,
          start: 0, dur, offset: 0,
          meta: {},
        };
        applyDescription(clip.meta, description);

        const list = trackShots(p, track.id);
        let orderedIds;
        if (afterId) {
          const at = list.findIndex((c) => c.id === afterId);
          orderedIds = list.map((c) => c.id);
          orderedIds.splice(at + 1, 0, clip.id);
        } else {
          orderedIds = list.map((c) => c.id).concat([clip.id]);
        }
        p.boards.push(board);
        p.clips.push(clip);
        relayoutTrack(p, track.id, orderedIds);
        return ok(clipView(p, clip, shotList(p).indexOf(clip) + 1));
      });
    } catch (e) { return fail(e); }
  },
);

/* —— 写：更新 —— */
tool(
  'update_shot',
  '更新镜头参数：description 为增量合并（只覆盖传了的键，其余字段保留），duration 单独传。',
  objOf({ id: S('镜头 id'), description: DESC_SCHEMA, duration: N('时长（秒）'), ...PP }, ['id']),
  async ({ id, description, duration, projectPath }) => {
    try {
      const root = resolveProject(projectPath);
      return mutate(root, (p) => {
        const c = findClip(p, id);
        c.meta = c.meta || {};
        applyDescription(c.meta, description);
        if (typeof duration === 'number' && isFinite(duration) && duration > 0) {
          c.dur = duration;
          relayoutTrack(p, c.trackId);            // 时长变化：后续镜头跟着前移/后移
        }
        return ok(clipView(p, c, shotList(p).indexOf(c) + 1));
      });
    } catch (e) { return fail(e); }
  },
);

/* —— 写：重排 —— */
tool(
  'set_shot_order',
  '重排镜头顺序。ids 必须是当前全部镜头 id 的一个完整排列（缺员/未知 id 都会被拒收）。'
  + '仅在镜头位于同一条分镜轨时可用。',
  objOf({ ids: { type: 'array', items: { type: 'string' }, description: '全部镜头 id 按目标顺序' }, ...PP }, ['ids']),
  async ({ ids, projectPath }) => {
    try {
      const root = resolveProject(projectPath);
      return mutate(root, (p) => {
        const list = shotList(p);
        const cur = list.map((c) => c.id);
        if (ids.length !== cur.length) {
          throw new Error('ids 数量（' + ids.length + '）与现有镜头数（' + cur.length + '）不一致');
        }
        const set = new Set(ids);
        if (set.size !== ids.length) throw new Error('ids 存在重复');
        for (const id of cur) if (!set.has(id)) throw new Error('缺少镜头 id：' + id);
        const tracks = new Set(list.map((c) => c.trackId));
        if (tracks.size > 1) throw new Error('镜头分布在多条轨道，暂不支持整体重排（请在 Fabula 时间轴里调整）');
        relayoutTrack(p, list[0].trackId, ids);
        return ok({ order: shotList(p).map((c, i) => clipView(p, c, i + 1)) });
      });
    } catch (e) { return fail(e); }
  },
);

/* —— 写：镜头图片 —— */
tool(
  'set_shot_image',
  '把一张 PNG 写入镜头画面（boards/<boardId>.png）。imagePath 读本地文件；imageBase64 收 dataURL 或裸 base64（AI 生图直接回填用）。仅支持 PNG。',
  objOf({ id: S('镜头 id'), imagePath: S('本地 PNG 文件路径'), imageBase64: S('data:image/png;base64,… 或裸 base64'), ...PP }, ['id']),
  async ({ id, imagePath, imageBase64, projectPath }) => {
    try {
      const root = resolveProject(projectPath);

      let buf = null;
      if (imagePath) {
        const src = path.resolve(imagePath);
        if (!fs.existsSync(src)) throw new Error('文件不存在：' + src);
        if (!/\.png$/i.test(src)) throw new Error('只接受 PNG（' + path.extname(src) + ' 请先转换）');
        buf = fs.readFileSync(src);
      } else if (imageBase64) {
        const b64 = imageBase64.replace(/^data:image\/png;base64,/, '');
        buf = Buffer.from(b64, 'base64');
      } else {
        throw new Error('需要 imagePath 或 imageBase64 之一');
      }
      if (!(buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) {
        throw new Error('不是有效的 PNG 数据（magic 校验失败）');
      }

      return mutate(root, (p) => {
        const c = findClip(p, id);
        let b = c.boardId ? p.boards.find((x) => x.id === c.boardId) : null;
        if (!b) {                                // 老数据/异常：给这个镜头补一个画面位
          const bid = genId('bd');
          b = { id: bid, name: '帧 ' + String(p.boards.length + 1).padStart(3, '0'), path: 'boards/' + bid + '.png', group: null };
          p.boards.push(b);
          c.boardId = bid;
        }
        /* b.path 来自磁盘（可能被手改成 ../x.png）：不合规就按净化后的 id 重建，防写出工程外（N-B14） */
        if (!/^boards\/[A-Za-z0-9._-]+\.png$/.test(b.path)) {
          b.path = 'boards/' + String(b.id).replace(/[^A-Za-z0-9_-]/g, '_') + '.png';
        }
        ensureDir(path.join(root, 'boards'));
        fs.writeFileSync(path.join(root, b.path), buf);
        return ok({ id, image: b.path, kind: 'png', bytes: buf.length });
      });
    } catch (e) { return fail(e); }
  },
);

/* —— 写：删除 —— */
tool(
  'delete_shot',
  '删除镜头（只删时间轴片段；画面帧保留在素材库，需要时可在 Fabula 里再次使用）。',
  objOf({ id: S('镜头 id'), ...PP }, ['id']),
  async ({ id, projectPath }) => {
    try {
      const root = resolveProject(projectPath);
      return mutate(root, (p) => {
        const c = findClip(p, id);
        p.clips.splice(p.clips.indexOf(c), 1);
        relayoutTrack(p, c.trackId);             // 后续镜头前移，闭合空隙
        return ok({ deleted: id, remaining: shotList(p).length });
      });
    } catch (e) { return fail(e); }
  },
);

/* —— 素材：导入 / 列表 —— */
tool(
  'import_assets',
  '导入素材文件到工程（图片→assets/image/，音频→assets/audio/），可用 group 归组。',
  objOf({
    paths: { type: 'array', items: { type: 'string' }, description: '本地文件路径（png/jpg/webp 图片，mp3/wav/m4a/ogg 音频）' },
    group: S('分组 id（先看 get_project 的 groups）'),
    ...PP,
  }, ['paths']),
  async ({ paths: srcs, group, projectPath }) => {
    try {
      const root = resolveProject(projectPath);
      const copied = [];                     // 已复制的媒体路径：写清单失败时回滚（N-B16）
      return mutate(root, (proj) => {
        const added = [], skipped = [];
        for (const p of srcs) {
          const src = path.resolve(p);
          const ext = path.extname(src).toLowerCase();
          const kind = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? 'image'
            : ['.mp3', '.wav', '.m4a', '.ogg'].includes(ext) ? 'audio' : null;
          if (!kind || !fs.existsSync(src)) { skipped.push(p); continue; }
          const base = path.basename(src).replace(/[^A-Za-z0-9._-]/g, '_');
          const dstDir = path.join(root, 'assets', kind);
          ensureDir(dstDir);
          let dst = path.join(dstDir, base);
          let n = 1;
          while (fs.existsSync(dst)) {
            const e2 = path.extname(base);
            dst = path.join(dstDir, base.slice(0, base.length - e2.length) + '-' + (n++) + e2);
          }
          fs.copyFileSync(src, dst);
          const asset = {
            id: genId('as'),
            name: path.basename(src, ext).slice(0, 120) || '素材',
            kind,
            path: 'assets/' + kind + '/' + path.basename(dst),
            group: (proj.groups.some((g) => g.id === group) ? group : null),   // 只收已知分组 id
          };
          proj.assets.push(asset);
          copied.push(asset.path);
          added.push({ id: asset.id, name: asset.name, kind, path: asset.path });
        }
        return ok({ added, skipped, assetCount: proj.assets.length });
      }, () => {
        /* 清单写失败：删掉刚复制的媒体，避免"有文件无清单"的幽灵素材（N-B16） */
        for (const rel of copied) { try { fs.rmSync(path.join(root, rel), { force: true }); } catch (_) {} }
      });
    } catch (e) { return fail(e); }
  },
);

tool(
  'list_assets',
  '列出工程素材（可按 kind 过滤：image / audio）。',
  objOf({ kind: { type: 'string', enum: ['image', 'audio'], description: '可选：只列某一类' }, ...PP }),
  async ({ kind, projectPath }) => {
    try {
      const root = resolveProject(projectPath);
      const proj = readProject(root);
      const list = proj.assets.filter((a) => !kind || a.kind === kind)
        .map((a) => ({ id: a.id, name: a.name, kind: a.kind, path: a.path, group: a.group }));
      return ok({ count: list.length, assets: list, groups: proj.groups });
    } catch (e) { return fail(e); }
  },
);

/* ════════ 轻量参数校验（面窄，一层类型检查足够） ════════ */
function validate(schema, args) {
  const bad = (m) => { const e = new Error(m); e.code = -32602; throw e; };
  if (typeof args !== 'object' || args === null || Array.isArray(args)) bad('arguments 必须是对象');
  for (const k of schema.required || []) {
    if (args[k] === undefined) bad('缺少必填参数：' + k);
  }
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties && schema.properties[k];
    if (!p || v === undefined || v === null) continue;
    if (p.type === 'string' && typeof v !== 'string') bad(k + ' 必须是字符串');
    if (p.type === 'number' && (typeof v !== 'number' || !isFinite(v))) bad(k + ' 必须是数字');
    if (p.type === 'array' && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) bad(k + ' 必须是字符串数组');
    if (p.type === 'object' && (typeof v !== 'object' || Array.isArray(v))) bad(k + ' 必须是对象');
    if (p.enum && !p.enum.includes(v)) bad(k + ' 只能是：' + p.enum.join(' / '));
  }
}

/* ════════ JSON-RPC over stdio ════════ */
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(line) {
  let m;
  try { m = JSON.parse(line); } catch (_) {
    /* 协议要求：解析失败回 -32700（此前静默丢弃，客户端会挂等超时，N-B15） */
    try { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); } catch (__) {}
    return;
  }
  /* 非对象消息（如一行 null / 数组）直接忽略：解构会抛 TypeError 且无人接（M-11） */
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return;
  const { id, method, params } = m;
  try {
    if (method === 'initialize') {
      return send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fabula', version: '0.1.0' },
        },
      });
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') {
      return send({
        jsonrpc: '2.0', id,
        result: { tools: T.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) },
      });
    }
    if (method === 'tools/call') {
      const t = T.find((x) => x.name === (params && params.name));
      if (!t) { const e = new Error('未知工具：' + (params && params.name)); e.code = -32602; throw e; }
      const args = (params && params.arguments) || {};
      if (process.env.FABULA_MCP_DEBUG) console.error('[call]', t.name, JSON.stringify(args).slice(0, 300));
      validate(t.inputSchema, args);
      const r = await t.handler(args);
      return send({ jsonrpc: '2.0', id, result: r });
    }
    if (id !== undefined) { const e = new Error('不支持的方法：' + method); e.code = -32601; throw e; }
  } catch (e) {
    if (id === undefined) return;
    send({
      jsonrpc: '2.0', id,
      error: { code: e && e.code ? e.code : -32603, message: String((e && e.message) || e) },
    });
  }
}

const MAX_LINE = 8 * 1024 * 1024;     // 单条消息上限 8MB：超长未闭合行丢弃，防内存膨胀（N-B15）
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
  if (buf.length > MAX_LINE) buf = '';
});
process.stdin.on('end', () => process.exit(0));

console.error('[fabula-mcp] ready · project=' + (argProject || process.env.FABULA_PROJECT || readPointer() || '(调用时传 projectPath)'));
