#!/usr/bin/env node
/* Fabula MCP server（stdio，零依赖手写实现）——供外部 agent（Claude Code 等）
   按视频脚本 / AI 生图粗略编辑第一版分镜：镜头图片、顺序、描述、时长等参数。
   工具边界：不含任何时间轴/播放控制类工具（时间轴由人在 Fabula 里编）。

   MCP stdio 传输 = 每行一条 JSON-RPC 2.0 消息（NDJSON）；
   覆盖 initialize / notifications/initialized / ping / tools/list / tools/call。
   不引 @modelcontextprotocol/sdk：其 zod 兼容层在本仓库环境存在版本互操作问题，
   而本 server 面窄（无资源/提示/采样），协议层手写全可控。

   工程定位（优先级）：工具参数 projectPath > 环境变量 FABULA_PROJECT >
   --project <dir> > 当前工程指针（Fabula 打开工程时写入 ~/.fabula/current-project.json）。
   直接读写工程文件（fabula.json + shots/ + assets/），与 Electron 主进程共用同一份
   模型逻辑（main/projectModel.cjs）——agent 与 Fabula 是否打开互不依赖；
   Fabula 打开时通过 fs.watch 自动刷新（dom/sync.js）。 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../main/projectModel.cjs');

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
  if (!fs.existsSync(path.join(root, 'fabula.json'))) {
    throw new Error('不是 Fabula 工程（缺少 fabula.json）：' + root);
  }
  return root;
}

function readProject(root) {
  try {
    return M.normalizeProject(JSON.parse(fs.readFileSync(path.join(root, 'fabula.json'), 'utf8')));
  } catch (e) {
    throw new Error('fabula.json 读取失败：' + e.message);
  }
}

function writeProject(root, proj) {
  const tmp = path.join(root, 'fabula.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(proj, null, 2), 'utf8');
  fs.renameSync(tmp, path.join(root, 'fabula.json'));   // 原子替换，Fabula 侧 watch 不会读到半截
}

/* 连续序列派生：镜头 start 时间（与渲染端同规则——按 duration 累加，无间隙） */
function starts(proj) {
  const out = [];
  let acc = 0;
  for (const s of proj.shots) { out.push(acc); acc += s.duration; }
  return out;
}

function findShot(proj, id) {
  const i = proj.shots.findIndex((x) => x.id === id);
  if (i < 0) throw new Error('镜头不存在：' + id + '（可用 list_shots 查看全部 id）');
  return i;
}

/* 镜头读形态：description 展开 + 派生 no/start（agent 最省 token 的扁平结构） */
function shotView(proj, i) {
  const s = proj.shots[i];
  return Object.assign(
    { id: s.id, no: i + 1, duration: s.duration, start: starts(proj)[i], image: s.image },
    s.description,
  );
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
  notes: S('备注'),
};
const DESC_SCHEMA = objOf(DESC_PROPS);

/* —— 读：工程概览 —— */
tool(
  'get_project',
  '查看工程总览：名称、画幅、镜头数、总时长、分组与素材数。配合 list_shots 拿镜头 id。',
  objOf({ ...PP }),
  async ({ projectPath }) => {
    try {
      const root = resolveProject(projectPath);
      const proj = readProject(root);
      return ok({
        root,
        name: proj.name,
        fps: proj.fps,
        board: proj.boardW + 'x' + proj.boardH,
        shotCount: proj.shots.length,
        totalDuration: proj.shots.reduce((a, s) => a + s.duration, 0),
        groups: proj.groups,
        assetCount: proj.assets.length,
        tagOptions: proj.tagOptions,
      });
    } catch (e) { return fail(e); }
  },
);

/* —— 读：镜头列表 —— */
tool(
  'list_shots',
  '列出全部镜头（id / 镜号 / 时长 / 起始时间 / 画面有无 / 描述字段展开）。',
  objOf({ ...PP }),
  async ({ projectPath }) => {
    try {
      const root = resolveProject(projectPath);
      const proj = readProject(root);
      return ok({
        count: proj.shots.length,
        totalDuration: proj.shots.reduce((a, s) => a + s.duration, 0),
        shots: proj.shots.map((_, i) => shotView(proj, i)),
      });
    } catch (e) { return fail(e); }
  },
);

/* —— 读：单镜头 —— */
tool(
  'get_shot',
  '读取单个镜头：id / 镜号 / 时长 / 起始时间 / 图片路径 / description（各字段分组）。',
  objOf({ id: S('镜头 id（sh_xxxxxxxx）'), ...PP }, ['id']),
  async ({ id, projectPath }) => {
    try {
      const root = resolveProject(projectPath);
      const proj = readProject(root);
      const i = findShot(proj, id);
      const s = proj.shots[i];
      return ok({
        id: s.id,
        no: i + 1,
        duration: s.duration,
        start: starts(proj)[i],
        image: s.image,
        description: s.description,
      });
    } catch (e) { return fail(e); }
  },
);

/* —— 写：新建 —— */
tool(
  'add_shot',
  '新建镜头。afterId 指定插在哪个镜头之后（省略 = 追加到末尾）。description 可带 content/dialogue/sfx/size/move/lens/trans/notes。',
  objOf({
    afterId: S('插在该镜头之后；省略则追加到末尾'),
    duration: N('时长（秒），默认 3'),
    description: DESC_SCHEMA,
    ...PP,
  }),
  async ({ afterId, duration, description, projectPath }) => {
    try {
      const root = resolveProject(projectPath);
      const proj = readProject(root);
      const shot = M.sanitizeShot({ id: M.genId(), description: description || {}, duration: duration || 3 });
      if (afterId) {
        const i = findShot(proj, afterId);
        proj.shots.splice(i + 1, 0, shot);
      } else {
        proj.shots.push(shot);
      }
      writeProject(root, proj);
      return ok(shotView(proj, proj.shots.indexOf(shot)));
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
      const proj = readProject(root);
      const i = findShot(proj, id);
      const s = proj.shots[i];
      if (description && typeof description === 'object') {
        for (const k of M.DESCRIPTION_KEYS) {
          if (typeof description[k] === 'string') s.description[k] = description[k];
        }
      }
      if (typeof duration === 'number' && isFinite(duration) && duration > 0) s.duration = duration;
      writeProject(root, proj);
      return ok(shotView(proj, i));
    } catch (e) { return fail(e); }
  },
);

/* —— 写：重排 —— */
tool(
  'set_shot_order',
  '重排镜头顺序。ids 必须是当前全部镜头 id 的一个完整排列（缺员/未知 id 都会被拒收）。',
  objOf({ ids: { type: 'array', items: { type: 'string' }, description: '全部镜头 id 按目标顺序' }, ...PP }, ['ids']),
  async ({ ids, projectPath }) => {
    try {
      const root = resolveProject(projectPath);
      const proj = readProject(root);
      const cur = proj.shots.map((s) => s.id);
      if (ids.length !== cur.length) {
        throw new Error('ids 数量（' + ids.length + '）与现有镜头数（' + cur.length + '）不一致');
      }
      const set = new Set(ids);
      if (set.size !== ids.length) throw new Error('ids 存在重复');
      for (const id of cur) if (!set.has(id)) throw new Error('缺少镜头 id：' + id);
      const byId = new Map(proj.shots.map((s) => [s.id, s]));
      proj.shots = ids.map((x) => byId.get(x));
      writeProject(root, proj);
      return ok({ order: proj.shots.map((_, i) => shotView(proj, i)) });
    } catch (e) { return fail(e); }
  },
);

/* —— 写：镜头图片 —— */
tool(
  'set_shot_image',
  '把一张 PNG 写入镜头画面（shots/<id>.png）。imagePath 读本地文件；imageBase64 收 dataURL 或裸 base64（AI 生图直接回填用）。仅支持 PNG。',
  objOf({ id: S('镜头 id'), imagePath: S('本地 PNG 文件路径'), imageBase64: S('data:image/png;base64,… 或裸 base64'), ...PP }, ['id']),
  async ({ id, imagePath, imageBase64, projectPath }) => {
    try {
      const root = resolveProject(projectPath);
      const proj = readProject(root);
      findShot(proj, id);

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

      ensureDir(path.join(root, 'shots'));
      const rel = 'shots/' + id + '.png';
      fs.writeFileSync(path.join(root, rel), buf);
      const s = proj.shots.find((x) => x.id === id);
      s.image = rel;
      writeProject(root, proj);
      return ok({ id, image: rel, kind: 'png', bytes: buf.length });
    } catch (e) { return fail(e); }
  },
);

/* —— 写：删除 —— */
tool(
  'delete_shot',
  '删除镜头（含其 PNG 文件）。',
  objOf({ id: S('镜头 id'), ...PP }, ['id']),
  async ({ id, projectPath }) => {
    try {
      const root = resolveProject(projectPath);
      const proj = readProject(root);
      const i = findShot(proj, id);
      const s = proj.shots[i];
      proj.shots.splice(i, 1);
      writeProject(root, proj);
      if (s.image) { try { fs.rmSync(path.join(root, s.image)); } catch (_) {} }
      return ok({ deleted: id, remaining: proj.shots.length });
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
      const proj = readProject(root);
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
        const asset = M.sanitizeAsset({
          id: M.genAssetId(),
          name: path.basename(src, ext),
          kind,
          path: 'assets/' + kind + '/' + path.basename(dst),
          group: group || null,
        });
        if (asset) { proj.assets.push(asset); added.push({ id: asset.id, name: asset.name, kind, path: asset.path }); }
      }
      writeProject(root, proj);
      return ok({ added, skipped, assetCount: proj.assets.length });
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
  try { m = JSON.parse(line); } catch (_) { return; }
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
});
process.stdin.on('end', () => process.exit(0));

console.error('[fabula-mcp] ready · project=' + (argProject || process.env.FABULA_PROJECT || readPointer() || '(调用时传 projectPath)'));
