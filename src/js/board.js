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
     当前的用途：播放头不在任何分镜帧上时不落墨（"帧"是业务概念，引擎不知道）。
     H-11：空态不能一刀切吞掉所有指针 —— 抓手/缩放/空格平移是导航操作，必须放行，
     否则"放大后只能靠「适应」复位"。 */
  window.__fabulaWorkspace = {
    onPointerDown() { return B._blockPaint(); },
    onPointerMove() { return B._blockPaint(); },
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
    revision: 0,
    _flushPromise: null,
    _frameBusy: 0,
    spaceDownAt: 0,
    spacePanned: false,
    refImg: null,
    onion: { on: true, before: 1, after: 1, opacity: 45 },

    _shots: null,        /* orderedShots 缓存 */
    _bc: null,           /* orderedBoardClips 缓存 */
    _token: 0,           /* 载帧竞态令牌 */
    _btoken: 0,          /* 底图合成竞态令牌 */
    _silent: false,      /* 程序性变更期间置位：引擎的 notifyDirty 不落盘标记 */
    _idle: true,         /* 播放头不在任何分镜帧上：画布不吃笔（__fabulaWorkspace 钩子拦下） */
    _spaceHeld: false,   /* 空格平移的宿主侧状态位：引擎 panMode 只写不读，必须自己记 */
    thumbCache: new Map(),
    onionCache: new Map(),
    onionLoading: new Set(),
    _ogen: 0,            /* 洋葱皮加载代际：refreshMedia 自增以作废 in-flight 回填（R3 B-11） */
    _thumbPending: new Map(),   /* thumbUrl 并发去重（R3 B-16）：id -> in-flight Promise */

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

    /* 空格平移：状态自己记（__paintlab 没暴露 panMode，之前 getter 恒 false
       → keyup 判断失败 → 引擎 spaceDown 永不复位 → "抓手卡死"） */
    get spaceHeld() { return !!B._spaceHeld; },
    set spaceHeld(v) {
      B._spaceHeld = !!v;
      const e = E();
      if (e && e.setPanMode) e.setPanMode(!!v);
      /* 低项：`.board-stage.panning` 的光标规则此前是死 CSS（全库无人加类）——
         空格平移期间加上，抓手中光标可见 */
      const st = document.getElementById('stage');
      if (st) st.classList.toggle('panning', !!v);
    },

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
        B.revision++;
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
        UI('syncColor', hex);
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
      try {
        e.setDocSize(W, H, { keepContent: false, fit: false });
        e.clearForShot();
      } finally { B._silent = false; }
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
      return { id: t, kind };
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

    /* （原 syncCursor/paint/refreshRing 三空桩已删：引擎自绘光标与线宽环；
       全部调用点已随 R3 B-9 清理归零） */
    setIdle(on) {
      B._idle = !!on;
      const el = document.getElementById('stage');
      if (el) el.classList.toggle('no-frame', !!on);
    },
    /* 空态是否拦截指针：导航类（抓手/缩放/空格平移）放行，其余拦下（不落墨） */
    _blockPaint() {
      if (B._silent || B._frameBusy || MTG.state.switchingProject) return true;
      if (!B._idle) return false;
      if (B.spaceHeld) return false;
      const e = E();
      const t = e && e.tool ? e.tool() : '';
      return !(t === 'hand' || t === 'zoom');
    },

    /* ================= 画幅 ================= */
    applySize(w, h) {
      const e = E();
      if (!e) return;
      W = Math.round(w); H = Math.round(h);
      B._silent = true;
      try { e.setDocSize(W, H, { keepContent: true, fit: false }); }
      finally { B._silent = false; }
      B.rebuildBackdrop();
    },
    get docW() { return W; },
    get docH() { return H; },

    /* ================= 历史 / 图层 / 选区 ================= */
    undo() { const e = E(); if (e && e.canUndo()) { e.undo(); UI('syncHistory'); UI('syncBoardMeta'); } },
    redo() { const e = E(); if (e && e.canRedo()) { e.redo(); UI('syncHistory'); UI('syncBoardMeta'); } },
    trimUndo() {},                       /* 引擎自带撤销栈上限，无需裁剪 */

    clearLayer(id) { const e = E(); if (e) e.clear(id || MTG.state.layer || 'fg'); },

    /* 切层（S-2）：必须真的调引擎 —— 只改 MTG.state.layer 的话画笔仍落原层。
       UI 高亮/状态的单一回写点是引擎回调 onLayerChange（init 里接好）。 */
    setLayer(id) {
      const e = E();
      if (e && e.setLayer) { e.setLayer(id); return; }
      MTG.state.layer = id;                    // 引擎未就绪：至少让状态一致
    },

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
      const gen = B._ogen;        /* 加载代际：期间被 refreshMedia 作废则丢弃回填（R3 B-11） */
      MTG.storage.readBlob(b.path).then((blob) => {
        if (gen !== B._ogen) { B.onionLoading.delete(bid); return; }
        if (!blob) { B.onionCache.set(bid, 'missing'); B.onionLoading.delete(bid); return; }
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          if (gen !== B._ogen) { B.onionLoading.delete(bid); return; }
          B.onionCache.set(bid, img);
          B.onionLoading.delete(bid);
          B.rebuildBackdrop();
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          if (gen !== B._ogen) { B.onionLoading.delete(bid); return; }
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
      /* 纸色从 CSS token --paper 读（单一来源，R3 B-8）；读不到回退出厂值 */
      let paperHex = '#f5f0ea';
      try {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
        if (/^#[0-9a-fA-F]{6}$/.test(v)) paperHex = v;
      } catch (_) {}
      x.fillStyle = paperHex;
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
      B._frameBusy++;
      try {
        if (B.dirty) await B.flush();
        if (tk !== B._token) return;
        if (!want) { B.unload(); return; }
        await B.loadFrame(want, tk);
      } catch (err) {
        if (MTG.audio && MTG.audio.playing) MTG.audio.pause();
        const current = B.orderedBoardClips().find(c => c.boardId === MTG.state.currentBoardId);
        if (current && MTG.setPlayhead) MTG.setPlayhead(current.start + 0.001);
        throw err;
      } finally { B._frameBusy--; }
    },

    /* 离开帧 / 帧被删除时：清空画板并复位历史 */
    unload() {
      MTG.state.currentBoardId = null;
      const e = E();
      B._silent = true;
      try { if (e) { B.xfEnd(); e.clearForShot(); } }
      finally { B._silent = false; }
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
        /* 排队期间已切帧/切工程：这一载入作废，防旧工程画面落进新画布（N-B2） */
        if (tk !== B._token) return;
        B._silent = true;
        try {
          B.xfEnd();                             // 变换会话不得跨帧（S-4）：否则上一帧内容
          e.clearForShot();                      // 会以变换框浮在新帧上，误操作还会写进新帧
          await e.loadImage(blob, { layer: 'fg', mode: 'stretch', clearUndo: true, fit: false });
        } finally {
          B._silent = false;                     // 载入异常也必须复位：否则后续笔迹的脏标记被吞、静默丢失
        }
      });
      B._loadQueue = job.catch((err) => {
        console.error('[board] 载帧失败', err);
        MTG.toast && MTG.toast('载帧失败：' + ((err && err.message) || err), true);
      });
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

    flush() {
      // 每个调用者先提交尚未抬笔的内容；切帧即使复用慢保存，也不能漏掉新起的一笔。
      const e = E();
      if (e && e.commitStroke) e.commitStroke();
      if (B._flushPromise) return B._flushPromise;
      const job = (async () => {
        while (B.dirty) {
          const project = MTG.state.project;
          const id = MTG.state.currentBoardId;
          const b = MTG.findBoard(id);
          if (!b || !MTG.storage.ready) throw new Error('当前画面没有可保存的工程位置');
          const revision = B.revision;
          const blob = await B.toBlob();
          if (!blob) throw new Error('无法生成帧图，原画面已保留');
          if (MTG.state.project !== project || MTG.state.currentBoardId !== id) {
            throw new Error('画面已切换，已停止旧帧保存');
          }
          await MTG.storage.writeFile(b.path, blob);
          if (MTG.state.project !== project || MTG.state.currentBoardId !== id) {
            throw new Error('工程已切换，无法确认旧帧保存状态');
          }
          B.onionCache.delete(id);
          B.dropThumb(id);
          if (MTG.timeline && MTG.timeline.refreshBoardThumb) MTG.timeline.refreshBoardThumb(id);
          if (MTG.assets && MTG.assets.refreshBoardThumb) MTG.assets.refreshBoardThumb(id);
          if (B.revision === revision) B.dirty = false;
        }
        return true;
      })();
      B._flushPromise = job.catch(err => {
        MTG.ui && MTG.ui.syncSave && MTG.ui.syncSave('failed');
        MTG.toast && MTG.toast('帧保存失败，原画面已保留：' + err.message, true);
        throw err;
      }).finally(() => { B._flushPromise = null; });
      return B._flushPromise;
    },

    dropThumb(id) {
      B._thumbPending.delete(id); // 在途旧读取不得回填保存前的内容
      const u = B.thumbCache.get(id);
      if (u) { URL.revokeObjectURL(u); B.thumbCache.delete(id); }
    },
    clearThumbnails() {
      B._thumbPending.clear();
      B.thumbCache.forEach(u => URL.revokeObjectURL(u));
      B.thumbCache.clear();
    },

    /* 取某帧的可复用对象 URL（带缓存），时间轴缩略图与分镜表画面列共用。
       并发 miss 去重（R3 B-16）：同一帧的并发请求共享同一次加载，
       避免重复 readBlob 与"后写覆盖先写"造成的 blob URL 泄漏。 */
    async thumbUrl(b) {
      if (!b) return null;
      if (B.thumbCache.has(b.id)) return B.thumbCache.get(b.id);
      if (!MTG.storage.ready) return null;
      if (B._thumbPending.has(b.id)) return B._thumbPending.get(b.id);
      const project = MTG.state.project;
      const job = (async () => {
        try {
          const blob = await MTG.storage.readBlob(b.path);
          if (MTG.state.project !== project) return null;
          if (B._thumbPending.get(b.id) !== job) return B.thumbUrl(b);
          if (!blob) return null;
          const u = URL.createObjectURL(blob);
          B.thumbCache.set(b.id, u);
          return u;
        } finally {
          if (B._thumbPending.get(b.id) === job) B._thumbPending.delete(b.id);
        }
      })();
      B._thumbPending.set(b.id, job);
      return job;
    },

    /* 画板当前内容丢弃（从磁盘重读当前帧）——绘画弹窗「取消」用。
       keepUndo=true 保留撤销栈（外部刷新画面时不该清掉用户的撤销历史）。 */
    async reloadCurrent(keepUndo) {
      const id = MTG.state.currentBoardId;
      if (!id) return;
      const b = MTG.findBoard(id);
      if (!b) return;
      const e = E();
      if (!e) return;
      const blob = await MTG.storage.readBlob(b.path);
      B._silent = true;
      try {
        B.xfEnd();                               // 重读帧时同样丢弃未提交的变换（S-4）
        e.clearForShot();
        if (blob) await e.loadImage(blob, { layer: 'fg', mode: 'stretch', clearUndo: !keepUndo, fit: false });
      } finally { B._silent = false; }
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
      try { await B.flush(); } catch (_) { return; }

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
      try { await B.flush(); } catch (_) { return; }
      MTG.markDirty();
      MTG.toast('已保存：' + b.name);
    },

    /* 换工程时释放所有 blob URL：旧工程的缩略图/洋葱皮缓存不再有效 */
    resetCaches() {
      B.clearThumbnails();
      B._ogen++;
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
