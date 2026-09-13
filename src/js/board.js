/* ============================================================
   board.js —— 画板：引擎桥接层 + 帧业务逻辑
   ------------------------------------------------------------
   · 绘画内核（GL/笔画/图层/选区/历史）已迁至 engine/paint.js，
     本文件只做两件事：
       1) 把引擎 API 包装成 montage 前端熟悉的 MTG.board.* 接口；
       2) 保留帧业务：分镜帧读写、缩略图缓存、洋葱皮/参考层合成、
          播放头同步、自动存盘 flush。
   · 与引擎的站位：引擎不抢键盘、不管存储；键盘语义、文件、
     洋葱皮贴图合成全部由这一层驱动。
   ============================================================ */
(function () {
  'use strict';
  const MTG = (window.MTG = window.MTG || {});
  const U = MTG.util;
  const E = () => window.__fabulaEngine;          /* 引擎晚于本文件执行也可以，统一惰性取 */
  const BRUSH_IDS = ['pen', 'pencil', 'marker', 'gouache', 'airbrush'];

  /* 画幅（跟随文档尺寸，与引擎 DW/DH 同步） */
  let W = 1280, H = 720;
  /* 当前笔刷（绘制类工具才更新它；切橡皮/选区不改变笔刷记忆） */
  let brushId = 'pen';

  /* 防御式转发到 MTG.ui 的若干同步函数（名字对不上时静默跳过） */
  const UI = (n) => { try { const f = MTG.ui && MTG.ui[n]; if (typeof f === 'function') f(); } catch (_) {} };

  /* 工作台钩子：引擎在画布上收到指针时先问这里，返回 true = 这一下由工作台消费。
     当前的用途：播放头不在任何分镜帧上时不落墨（"帧"是业务概念，引擎不知道）。 */
  window.__fabulaWorkspace = {
    onPointerDown() { return !!B._idle; },
    onPointerMove() { return !!B._idle; },
  };

  /* ---------- 参数对象：直接映射引擎 P（读/写实时生效） ---------- */
  const BP = new Proxy({}, {
    get: (_, k) => { const e = E(); const p = e && e.getParams ? e.getParams() : null; return p ? p[k] : undefined; },
    set: (_, k, v) => { const e = E(); if (e && e.setParam) e.setParam(k, v); return true; },
    has: (_, k) => { const e = E(); const p = e && e.getParams ? e.getParams() : null; return p ? (k in p) : false; },
    ownKeys: () => { const e = E(); const p = e && e.getParams ? e.getParams() : {}; return Object.keys(p); },
    getOwnPropertyDescriptor: (_, k) => ({ configurable: true, enumerable: true, get: () => BP[k] }),
  });

  /* 洋葱皮/后场用的合法掩膜色（与旧内核一致：前帧暖红、后帧冷蓝） */
  const ONION_FG = '#eb684b', ONION_BG = '#7bbbe3';

  const B = (MTG.board = {
    /* ================= 数据属性 ================= */
    dirty: false,
    drawing: false,
    spaceDownAt: 0,
    spacePanned: false,
    strokeTool: null,
    lassoing: false,
    selDrag: null,
    refImg: null,
    onion: { on: true, before: 1, after: 1, opacity: 45 },

    _shots: null,        /* orderedShots 缓存 */
    _bc: null,           /* orderedBoardClips 缓存 */
    _token: 0,           /* 载帧竞态令牌 */
    _btoken: 0,          /* 底图合成竞态令牌 */
    _silent: false,      /* 程序性变更期间置位：引擎的 notifyDirty 不落盘标记 */
    _idle: true,         /* 播放头不在任何分镜帧上：画布不吃笔（__fabulaWorkspace 钩子拦下） */
    thumbCache: new Map(),
    onionCache: new Map(),
    onionLoading: new Set(),
    _thumbUrl: new Map(),

    /* ================= 引擎状态映射 ================= */
    get brushId() { return brushId; },
    set brushId(v) { if (v) brushId = v; },

    get bp() { return BP; },
    set bp(v) { if (v) B.applyBrushParams(v); },

    get undoStack() { const e = E(); return { length: e && e.canUndo() ? 1 : 0 }; },
    get redoStack() { const e = E(); return { length: e && e.canRedo() ? 1 : 0 }; },

    get sel() { const e = E(); return e && e.hasSelection() ? { path: true, float: false } : null; },
    set sel(v) { if (v === null) { const e = E(); if (e && e.hasSelection()) e.deselect(); } },

    get xf() { try { return window.__paintlab.xfState.on ? { on: true } : null; } catch (_) { return null; } },

    get spaceHeld() { try { return !!window.__paintlab.panMode; } catch (_) { return false; } },
    set spaceHeld(v) { const e = E(); if (e && e.setPanMode) e.setPanMode(!!v); },

    get showRef() { return !!B._showRef; },
    set showRef(v) {
      const was = !!B._showRef;
      B._showRef = !!v;
      if (was !== B._showRef) B.rebuildBackdrop();
      UI('syncRef');
    },

    /* ================= 初始化 ================= */
    init() {
      const e = E();
      if (!e) { MTG.toast && MTG.toast('绘画引擎未加载：检查 engine/paint.js 是否引入', true); return; }
      B.ovc = document.getElementById('ov');

      /* 引擎 → 前端 的状态回调 */
      e.onDirty = () => {
        UI('syncHistory');
        if (B._silent) return;
        if (!MTG.state.currentBoardId) return;
        B.dirty = true;
        if (MTG.markDirty) MTG.markDirty();
      };
      e.onView = () => B._syncZoomLabel();
      e.onSel = () => { UI('syncSel'); UI('syncHistory'); };
      e.onColor = (rgb) => {
        const h = (n) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0');
        const hex = '#' + h(rgb[0]) + h(rgb[1]) + h(rgb[2]);
        MTG.state.color = hex;
        if (MTG.picker && MTG.picker.set) MTG.picker.set(hex);
        UI('syncColor');
      };
      e.onToolChange = (t) => B._syncToolUi(t);
      e.onLayerChange = (id) => {
        MTG.state.layer = id;
        document.querySelectorAll('[data-layer]').forEach((b) => b.classList.toggle('active', b.dataset.layer === id));
      };

      /* 起始画幅：优先用工程里的尺寸 */
      const p = MTG.state.project;
      if (p && p.boardW && p.boardH) { W = p.boardW; H = p.boardH; }
      B._silent = true;
      e.setDocSize(W, H, { keepContent: false, fit: false });
      e.clearForShot();
      B._silent = false;
      e.fit();
      B._syncZoomLabel();
      B._syncToolUi(e.tool());
      B.rebuildBackdrop();                 // 空白期也铺一张纸，别让文档区透出棋盘格
    },

    /* ================= 工具 / 参数 ================= */
    setTool(t) {
      const e = E();
      if (!e) return;
      if (t === 'brush') e.setTool(brushId);
      else e.setTool(t);
    },

    /* 引擎工具变化 → montage 按钮态（不回写引擎，避免循环） */
    _syncToolUi(t) {
      const MAP = {
        pen: 'brush', pencil: 'brush', marker: 'brush', gouache: 'brush', airbrush: 'brush',
        eraser: 'eraser', line: 'line', rect: 'rect', eyedrop: 'eyedrop', hand: 'hand',
        zoom: 'zoom', lasso: 'lasso', fill: 'fill', smudge: 'smudge', blur: 'blur',
        warp: 'warp', transform: 'transform',
      };
      const ui = MAP[t] || t;
      MTG.state.tool = ui;
      document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === ui));
      UI('syncBrushUI');
      UI('syncBrushSliders');
    },

    setBrush(id) {
      const e = E();
      if (!e || !id) return;
      if (BRUSH_IDS.indexOf(id) >= 0) brushId = id;
      e.setTool(id);
    },

    /* 整包参数（来自设置面板的预设导入）：逐个 setParam，立即生效 */
    applyBrushParams(obj) {
      const e = E();
      if (!e || !obj) return;
      for (const k of Object.keys(obj)) e.setParam(k, obj[k]);
      UI('syncBrushSliders');
    },

    /* 参数快捷滑杆的数据面：当前工具可调的 4 项（参数名 → 引擎字段在 brushes.js 里映射） */
    engine() {
      const e = E();
      const t = e ? e.tool() : 'pen';
      const kind = BRUSH_IDS.indexOf(t) >= 0 ? 'brush' : 'other';
      return { id: t, kind, params: kind === 'brush' ? ['flow', 'hardness', 'grain', 'scatter'] : [] };
    },

    /* ================= 视图 ================= */
    _syncZoomLabel() {
      const e = E();
      if (!e) return;
      const glc = document.getElementById('gl');
      const el = document.getElementById('z-label');
      if (!glc || !el) return;
      const r = glc.getBoundingClientRect();
      const dpr = r.width ? glc.width / r.width : 1;
      el.textContent = Math.round((e.getView().scale / dpr) * 100) + '%';
    },
    fitView() { const e = E(); if (e) { e.fit(); B._syncZoomLabel(); } },
    zoomCenter(f) {
      const e = E();
      if (!e || !B.ovc) return;
      const r = B.ovc.getBoundingClientRect();
      e.zoomAt(r.left + r.width / 2, r.top + r.height / 2, f);
    },
    zoom100() { const e = E(); if (e) e.zoom100(); },
    panBy(dx, dy) { const e = E(); if (e) e.panBy(dx, dy); },

    /* 引擎自绘光标与线宽环，这里只保留"空场"光标态 */
    syncCursor() {}, paint() {}, refreshRing() {}, hideRing() {}, updateRing() {},
    setIdle(on) {
      B._idle = !!on;
      const el = document.getElementById('stage');
      if (el) el.classList.toggle('no-frame', !!on);
    },

    /* ================= 画幅 ================= */
    applySize(w, h) {
      const e = E();
      if (!e) return;
      W = Math.round(w); H = Math.round(h);
      B._silent = true;
      e.setDocSize(W, H, { keepContent: true, fit: false });
      B._silent = false;
      B.rebuildBackdrop();
    },
    get docW() { return W; },
    get docH() { return H; },

    /* ================= 历史 / 图层 / 选区 ================= */
    undo() { const e = E(); if (e && e.canUndo()) { e.undo(); UI('syncHistory'); UI('syncBoardMeta'); } },
    redo() { const e = E(); if (e && e.canRedo()) { e.redo(); UI('syncHistory'); UI('syncBoardMeta'); } },
    trimUndo() {},                       /* 引擎自带撤销栈上限，无需裁剪 */

    clearLayer(id) { const e = E(); if (e) e.clear(id || MTG.state.layer || 'fg'); },

    clearRef() {
      B.refImg = null;
      B._showRef = false;
      B.rebuildBackdrop();          // 重建底图：只去掉参考层，纸张底与洋葱皮照旧
      UI('syncRef');
      MTG.toast && MTG.toast('已清除参考层');
    },

    fillSel() { const e = E(); if (e && e.hasSelection()) e.fillSelection(); },
    deleteSel() { const e = E(); if (e && e.hasSelection()) e.eraseSelection(); },
    commitSel() { const e = E(); if (e && e.hasSelection()) e.deselect(); },
    startTransform() { const e = E(); if (e && e.hasSelection()) e.transformSelection(); },
    xfCommit() { const e = E(); if (e && e.commitTransform) e.commitTransform(); },
    xfCancel() { const e = E(); if (e && e.cancelTransform) e.cancelTransform(); },
    xfEnd() { try { if (window.__paintlab.xfState.on) B.xfCancel(); } catch (_) {} },

    /* 键盘会话语义（Enter/Esc）统一走这里：处理完吃掉事件，
       避免引擎 window 监听器重复处理同一按键。 */
    handleKey(e) {
      if (e.key !== 'Enter' && e.key !== 'Escape') return false;
      const e2 = E();
      if (!e2) return false;
      if (B.xf) { e.preventDefault(); e.stopPropagation(); if (e.key === 'Enter') B.xfCommit(); else B.xfCancel(); return true; }
      if (e2.hasSelection()) {
        e.preventDefault(); e.stopPropagation();
        e2.deselect();
        MTG.toast && MTG.toast(e.key === 'Enter' ? '选区已落回' : '已取消选区');
        return true;
      }
      return false;
    },

    toBlob() { const e = E(); return e ? e.exportBlob() : Promise.resolve(null); },

    /* ================= 洋葱皮 / 参考层 → 引擎底图 ================= */
    /* 取某帧的 Image（缓存 miss 时后台加载，完成后重合成） */
    onionImage(bid) {
      const hit = B.onionCache.get(bid);
      if (hit) return hit === 'missing' ? null : hit;
      if (B.onionLoading.has(bid)) return null;
      const b = MTG.findBoard(bid);
      if (!b || !MTG.storage.ready) return null;
      B.onionLoading.add(bid);
      MTG.storage.readBlob(b.path).then((blob) => {
        if (!blob) { B.onionCache.set(bid, 'missing'); B.onionLoading.delete(bid); return; }
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          B.onionCache.set(bid, img);
          B.onionLoading.delete(bid);
          B.rebuildBackdrop();
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          B.onionCache.set(bid, 'missing');
          B.onionLoading.delete(bid);
        };
        img.src = url;
      }).catch(() => B.onionLoading.delete(bid));
      return null;
    },

    preloadOnion() { B.rebuildBackdrop(); },

    /* 把一张帧图按"掩膜染色"画进合成 canvas（只在已落笔的像素上着色）。
       染色必须在独立画布上做：source-in 会吃掉合成图上已有的纸底与其它重影。 */
    _blitOnion(cvs, img, color, alpha) {
      const t = document.createElement('canvas');
      t.width = cvs.width; t.height = cvs.height;
      const tx = t.getContext('2d');
      tx.drawImage(img, 0, 0, t.width, t.height);
      tx.globalCompositeOperation = 'source-in';
      tx.fillStyle = color;
      tx.fillRect(0, 0, t.width, t.height);
      const x = cvs.getContext('2d');
      x.save();
      x.globalAlpha = Math.max(0, Math.min(1, alpha));
      x.drawImage(t, 0, 0);
      x.restore();
    },

    /* 合成底图 = 参考层（垫底）；洋葱皮（前红后蓝，按距离衰减）。
       合成完整体送进引擎 setBackdrop —— 引擎只垫底显示，不写帧/不导出。 */
    rebuildBackdrop() {
      const e = E();
      if (!e || !e.setBackdrop) return;
      const tk = ++B._btoken;
      const refOn = !!(B.refImg && B.showRef);
      const onOn = !!(B.onion.on && MTG.state.currentBoardId);

      const cvs = document.createElement('canvas');
      cvs.width = W; cvs.height = H;
      const x = cvs.getContext('2d');
      /* 纸张底层：文档区域总有一张纸（与引擎取色的 paper 常量同色）。
         纸必须跟着视口缩放/平移，所以放 backdrop 而不是 CSS。 */
      x.fillStyle = '#f5f0ea';
      x.fillRect(0, 0, W, H);
      if (refOn) x.drawImage(B.refImg, 0, 0, W, H);

      if (onOn) {
        const list = B.orderedBoardClips();
        const idx = list.findIndex((c) => c.boardId === MTG.state.currentBoardId);
        if (idx >= 0) {
          const base = Math.max(0, Math.min(1, (B.onion.opacity || 45) / 100));
          const pick = (dir, n) => {
            const out = [];
            let seen = new Set([MTG.state.currentBoardId]);
            for (let i = idx + dir; i >= 0 && i < list.length && out.length < n; i += dir) {
              const id = list[i].boardId;
              if (seen.has(id)) continue;
              seen.add(id);
              out.push({ id, k: out.length + 1 });
            }
            return out;
          };
          const b4 = pick(-1, B.onion.before || 0);
          const af = pick(1, B.onion.after || 0);
          for (const it of b4) {
            const img = B.onionImage(it.id);
            if (img) B._blitOnion(cvs, img, ONION_FG, base * (1 - (it.k - 1) * 0.28));
          }
          for (const it of af) {
            const img = B.onionImage(it.id);
            if (img) B._blitOnion(cvs, img, ONION_BG, base * (1 - (it.k - 1) * 0.28));
          }
        }
      }

      /* 合成图里已带各自透明度，backdrop 整体不再二次乘 alpha */
      Promise.resolve(e.setBackdrop(cvs)).then(() => {
        if (tk !== B._btoken) return;
        e.setBackdropAlpha(1);
      }).catch(() => {});
    },

    /* ================= 业务：帧排序 / 播放头同步 ================= */
    orderedShots() {
      const p = MTG.state.project;
      if (!p) return [];
      let sig = '';
      for (const t of p.tracks) sig += t.id + ',';
      sig += '#';
      for (const c of p.clips) {
        if (c.kind !== 'board') continue;
        sig += c.id + ':' + (c.boardId || '-') + ':' + c.trackId + ':' + c.start.toFixed(3) + ';';
      }
      if (B._shots && B._shots.sig === sig) return B._shots.list;
      const order = p.tracks.map(t => t.id);
      const list = p.clips
        .filter(c => c.kind === 'board')
        .slice()
        .sort((a, b) => (order.indexOf(a.trackId) - order.indexOf(b.trackId)) || (a.start - b.start));
      B._shots = { sig, list };
      return list;
    },

    /* 分镜片段按「轨道顺序 → 入点」排序（只含已落帧的，洋葱皮与预览依赖） */
    orderedBoardClips() {
      const p = MTG.state.project;
      if (!p) return [];
      let sig = '';
      for (const t of p.tracks) sig += t.id + ',';
      sig += '#';
      for (const c of p.clips) {
        if (c.kind !== 'board' || !c.boardId) continue;
        sig += c.boardId + ':' + c.trackId + ':' + c.start.toFixed(3) + ':' + c.dur.toFixed(3) + ';';
      }
      if (B._bc && B._bc.sig === sig) return B._bc.list;
      const order = p.tracks.map(t => t.id);
      const list = p.clips
        .filter(c => c.kind === 'board' && c.boardId)
        .slice()
        .sort((a, b) => (order.indexOf(a.trackId) - order.indexOf(b.trackId)) || (a.start - b.start));
      B._bc = { sig, list };
      return list;
    },
    clipAtPlayhead() {
      const t = MTG.state.playhead;
      return B.orderedBoardClips().find(c => t >= c.start - 1e-6 && t < c.start + c.dur - 1e-6) || null;
    },

    /* 播放头变化时调用：自动切换显示对应帧；离开片段则清空 */
    async syncToPlayhead() {
      const p = MTG.state.project;
      if (!p) return;
      const hit = B.clipAtPlayhead();
      const want = hit ? hit.boardId : null;
      if (want === MTG.state.currentBoardId) return;
      const tk = ++B._token;
      if (B.dirty) await B.flush();
      if (tk !== B._token) return;
      if (!want) { B.unload(); return; }
      await B.loadFrame(want, tk);
    },

    /* 离开帧 / 帧被删除时：清空画板并复位历史 */
    unload() {
      MTG.state.currentBoardId = null;
      const e = E();
      B._silent = true;
      if (e) { B.xfEnd(); e.clearForShot(); }
      B._silent = false;
      B.dirty = false;
      B.rebuildBackdrop();                       // 参考层保留显示，洋葱皮不再有对象
      MTG.ui && MTG.ui.syncBoardMeta && MTG.ui.syncBoardMeta();
      MTG.ui && MTG.ui.syncHistory && MTG.ui.syncHistory();
    },

    async loadFrame(id, token) {
      const b = MTG.findBoard(id);
      if (!b) return;
      if (!MTG.storage.ready) { MTG.toast('请先打开工程文件夹', true); return; }
      let blob = await MTG.storage.readBlob(b.path);
      if (!blob) {
        // 帧文件缺失（比如上次写入失败）：补一张空帧，别卡在「找不到文件」
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const nb = await new Promise(res => c.toBlob(res, 'image/png'));
        await MTG.storage.writeFile(b.path, nb).catch(() => {});
        blob = await MTG.storage.readBlob(b.path);
        if (!blob) { MTG.toast('找不到分镜帧文件：' + b.path, true); return; }
        MTG.markDirty();
      }
      const tk = token != null ? token : ++B._token;
      const e = E();
      if (!e) return;
      /* 载入串行化：快切帧时旧载入必须先落定，避免慢解码最后覆盖画面 */
      const job = (B._loadQueue || Promise.resolve()).then(async () => {
        B._silent = true;
        e.clearForShot();                        // 图层 / 掩膜 / 历史一起复位，跨帧不残留
        await e.loadImage(blob, { layer: 'fg', mode: 'stretch', clearUndo: true, fit: false });
        B._silent = false;
      });
      B._loadQueue = job.catch(() => {});
      await job.catch(() => {});
      if (tk !== B._token) return;
      MTG.state.currentBoardId = id;
      B.dirty = false;
      B.rebuildBackdrop();                       // 洋葱皮预热 + 参考层重合成
      MTG.ui && MTG.ui.syncBoardMeta && MTG.ui.syncBoardMeta();
      MTG.ui && MTG.ui.syncHistory && MTG.ui.syncHistory();
    },

    async loadAssetImage(asset) {
      const blob = await MTG.storage.readBlob(asset.path);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        B.refImg = img;
        B._showRef = true;
        B.rebuildBackdrop();
        MTG.ui && MTG.ui.syncRef && MTG.ui.syncRef();
        MTG.toast('已载入参考层（不写入分镜帧）');
      };
      img.onerror = () => { URL.revokeObjectURL(url); MTG.toast('参考图无法解码：' + asset.path, true); };
      img.src = url;
    },

    async flush() {
      const e = E();
      if (e && e.commitStroke) e.commitStroke(); // 画到一半被迫存盘（切帧/退出）：先把这一笔落下
      if (!B.dirty || !MTG.state.currentBoardId) return;
      const b = MTG.findBoard(MTG.state.currentBoardId);
      if (!b) return;
      const blob = await B.toBlob();
      if (!blob) return;
      await MTG.storage.writeFile(b.path, blob).catch(() => {});
      B.onionCache.delete(b.id);
      B.dropThumb(b.id);                   // 内容变了，旧缩略图 URL 作废
      B.dirty = false;
    },

    dropThumb(id) {
      const u = B.thumbCache.get(id);
      if (u) { URL.revokeObjectURL(u); B.thumbCache.delete(id); }
    },

    /* 取某帧的可复用对象 URL（带缓存），时间轴缩略图与分镜表画面列共用 */
    async thumbUrl(b) {
      if (!b) return null;
      if (B.thumbCache.has(b.id)) return B.thumbCache.get(b.id);
      if (!MTG.storage.ready) return null;
      const blob = await MTG.storage.readBlob(b.path);
      if (!blob) return null;
      const u = URL.createObjectURL(blob);
      B.thumbCache.set(b.id, u);
      return u;
    },

    /* 画板当前内容丢弃（从磁盘重读当前帧）——绘画弹窗「取消」用 */
    async reloadCurrent() {
      const id = MTG.state.currentBoardId;
      if (!id) return;
      const b = MTG.findBoard(id);
      if (!b) return;
      const e = E();
      if (!e) return;
      const blob = await MTG.storage.readBlob(b.path);
      B._silent = true;
      e.clearForShot();
      if (blob) await e.loadImage(blob, { layer: 'fg', mode: 'stretch', clearUndo: true, fit: false });
      B._silent = false;
      B.dirty = false;
    },

    /* 播放头落在某个分镜镜头（任意轨道、含空镜头）上 */
    shotAt(t) {
      const p = MTG.state.project;
      if (!p) return null;
      return p.clips.find(c => c.kind === 'board' && t >= c.start - 1e-6 && t < c.start + (c.dur || 0) - 1e-6) || null;
    },

    /* 新建镜头行默认没有画面；为它落一张透明底空帧并绑定 */
    async createBlankBoard(clip) {
      const p = MTG.state.project;
      const n = p.boards.length + 1;
      const id = U.uid('bd');
      const track = MTG.findTrack(clip.trackId) || p.tracks.find(t => t.kind === 'board');
      const gid = MTG.ensureTrackGroup(track);
      const b = { id, name: '帧 ' + String(n).padStart(3, '0'), path: 'boards/' + id + '.png', group: gid };
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const blob = await new Promise(res => c.toBlob(res, 'image/png'));
      try {
        await MTG.storage.writeFile(b.path, blob);
      } catch (err) {
        MTG.toast('写帧文件失败：' + ((err && err.message) || err), true);
        throw err;
      }
      p.boards.push(b);
      clip.boardId = id;
      clip.name = b.name;
      MTG.markDirty();
      return b;
    },

    /* 把一张图片栅格化成新的一帧（等比放进画幅、居中），返回 board 记录。
       图片拖到分镜轨时走这里 —— 变成真正的帧，画板才预览得到。 */
    async frameFromImage(img, track, nameHint) {
      const p = MTG.state.project;
      const n = p.boards.length + 1;
      const id = U.uid('bd');
      track = track || MTG.timeline.activeBoardTrack();
      const gid = MTG.ensureTrackGroup(track);
      const b = {
        id,
        name: (nameHint ? nameHint.replace(/\.[^.]+$/, '') : '图') + ' ' + String(n).padStart(3, '0'),
        path: 'boards/' + id + '.png', group: gid
      };
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d');
      const k = Math.min(W / img.naturalWidth, H / img.naturalHeight);
      const dw = img.naturalWidth * k, dh = img.naturalHeight * k;
      x.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      await MTG.storage.writeFile(b.path, await new Promise(res => c.toBlob(res, 'image/png')));
      p.boards.push(b);
      MTG.markDirty();
      return b;
    },

    /* 新建一帧：画布存盘 → 登记 → 在时间轴末尾（或播放头之后）插入片段 */
    async newFrame() {
      if (!MTG.storage.ready) { MTG.toast('请先打开工程文件夹', true); return; }
      const p = MTG.state.project;
      if (!p) { MTG.toast('请先打开工程文件夹', true); return; }
      await B.flush();

      // 播放头落在「空镜头」上 → 给它补画面（落透明空帧并绑定），而不是另插新行
      const hitShot = B.shotAt(MTG.state.playhead);
      if (hitShot && !hitShot.boardId) {
        const b = await B.createBlankBoard(hitShot);
        MTG.state.selectedClipIds = new Set([hitShot.id]);
        MTG.setPlayhead(hitShot.start + 0.001);   // 播放头进该镜头 → 画板自动切到这张新空帧
        MTG.render();
        MTG.toast('已为镜头补上画面：' + b.name);
        return;
      }

      const n = p.boards.length + 1;
      const id = U.uid('bd');

      /* 落在哪条轨：优先用「选定的轨道」，否则第一条分镜轨 */
      const track = MTG.timeline.activeBoardTrack();
      const gid = MTG.ensureTrackGroup(track);                    // 帧默认归入所在轨道的分组
      const b = { id, name: '帧 ' + String(n).padStart(3, '0'), path: 'boards/' + id + '.png', group: gid };
      /* 新帧必须是空白的：这里曾经把当前画板内容存进去，于是指针停在某一帧上再点新建，
         就会把那一帧原样复制一份。 */
      const bc = document.createElement('canvas');
      bc.width = W; bc.height = H;
      await MTG.storage.writeFile(b.path, await new Promise(res => bc.toBlob(res, 'image/png')));
      p.boards.push(b);

      // 同轨不重叠：挡路的片段往右顺推，新帧插在播放头所在时刻
      const moved = MTG.timeline.makeRoom(track.id, MTG.state.playhead, 3);
      const start = Math.max(0, MTG.state.playhead);
      const clip = {
        id: U.uid('cl'), trackId: track.id, kind: 'board', boardId: id,
        name: b.name, start, dur: 3, offset: 0
      };
      p.clips.push(clip);
      MTG.state.selectedClipIds = new Set([clip.id]);
      MTG.setPlayhead(start + 0.001);                             // 播放头进新帧 → 画板自动切过去
      MTG.markDirty();
      MTG.render();
      MTG.toast('已新建 ' + b.name + '（分组：' + (p.groups.find(g => g.id === gid) || {}).name + '）'
        + (moved ? '，顺推 ' + moved + ' 个片段' : ''));
    },

    async saveFrame() {
      const b = MTG.findBoard(MTG.state.currentBoardId);
      if (!b) { MTG.toast('播放头不在任何分镜帧上', true); return; }
      await B.flush();
      MTG.markDirty();
      MTG.toast('已保存：' + b.name);
    },

    /* 换工程时释放所有 blob URL：旧工程的缩略图/洋葱皮缓存不再有效 */
    resetCaches() {
      B.thumbCache.forEach(u => URL.revokeObjectURL(u));
      B.thumbCache.clear();
      B.onionCache.clear();
      B.onionLoading.clear();
      B._bc = null;
      B._shots = null;
      B._token++; B._btoken++;
      B.refImg = null;
      B._showRef = false;
      const e = E();
      if (e) { e.setBackdrop(null); }
      B.dirty = false;
    },
  });

})();
