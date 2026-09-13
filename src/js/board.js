/* board.js · 画板（同时是预览器）
   · 画板跟随播放头：播放头落在哪个分镜片段上，就显示哪一帧，并可直接作画；
     离开片段区间时清空并提示，切换帧前自动保存（不丢笔）
   · 图层结构（由下至上）：参考层 ref（不保存）→ 背景层 → 线稿层 → 洋葱皮（不保存）
   · 压感笔画基于 perfect-freehand（js/vendor/，MIT）：收集 [x,y,pressure] 点列
     生成整条笔画轮廓再填充，起收笔锥形收窄，压力点间插值；鼠标/触屏按速度模拟
     详见 https://github.com/steveruizok/perfect-freehand
   · 画幅可变（applySize），已有图层内容缩放适配
   · 撤销 = 落笔前对当前图层做一次 ImageData 快照，栈深 16 */
(function () {
  'use strict';
  const MTG = window.MTG;
  const U = MTG.util;
  let W = MTG.BOARD_W, H = MTG.BOARD_H;   // 画幅可变（applySize），模块内共享
  const PAPER = '#f5f0ea';
  const MAX_UNDO = 16;

  const B = (MTG.board = {
    cv: null, ctx: null,
    bg: null, fg: null, ref: null,
    bgx: null, fgx: null, refx: null,
    tmp: null, tmpx: null,                 // 洋葱皮染色用的临时画布
    undoStack: [], redoStack: [],
    drawing: false, start: null, last: null, lastMid: null, shapeRect: null,
    dirty: false,                          // 当前帧有未保存的笔触
    showRef: true,
    onion: { on: false, before: 1, after: 1, opacity: 35 },
    onionCache: new Map(),                 // boardId -> Image | 'missing'
    onionLoading: new Set(),
    thumbCache: new Map(),
    _token: 0,
    _bc: null,                             // orderedBoardClips 的结构签名缓存
    _shots: null,                          // orderedShots 的结构签名缓存
    view: { x: 0, y: 0, z: 1 },            // 画布导航（PS 同款：平移 + 缩放）
    brushId: 'brushPen',                   // 当前笔刷（见 js/brushes.js）
    bp: null,                              // 当前笔刷参数
    sel: null,                             // 套索选区 { path, float }
    lassoing: false,
    selDrag: null,
    spaceHeld: false, spaceDownAt: 0, spacePanned: false,

    init(canvas) {
      B.cv = canvas;
      canvas.width = W; canvas.height = H;
      B.ctx = canvas.getContext('2d');
      const mk = () => {
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        return c;
      };
      B.bg = mk(); B.fg = mk(); B.ref = mk(); B.tmp = mk();
      B.strokeCv = mk();                                    // 笔画预览 / 橡皮草稿
      /* 图层不设 willReadFrequently —— 那个标志会把画布踢到 CPU 后端，
         而涂抹 / 模糊的 GPU 通道每段都要把结果贴回图层（drawImage），
         CPU 后端意味着**每段一次 GPU→CPU 同步回读**，手感就是"一顿一顿、跟不上手"。
         现在需要回读的地方只剩：撤销收尾（每笔一次，脏区）与颜料桶（每批一次），代价可接受。 */
      B.bgx = B.bg.getContext('2d');
      B.fgx = B.fg.getContext('2d');
      B.refx = B.ref.getContext('2d');
      B.tmpx = B.tmp.getContext('2d');
      B.strokex = B.strokeCv.getContext('2d');
      if (MTG.brushes) B.bp = MTG.brushes.loadParams(B.brushId);
      B.paint();

      canvas.addEventListener('pointerdown', B.down);
      canvas.addEventListener('pointermove', B.move);
      canvas.addEventListener('pointerup', B.up);
      canvas.addEventListener('pointercancel', B.up);
      canvas.addEventListener('pointerleave', e => { B.hideRing(); if (B.drawing) B.up(e); });
      canvas.addEventListener('contextmenu', e => e.preventDefault());

      /* ── 画布导航：滚轮缩放（以光标为锚），空格/抓手/中键拖动平移 ── */
      const stage = document.getElementById('board-stage');
      stage.addEventListener('wheel', e => {
        e.preventDefault();
        let f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        if (MTG.settings && MTG.settings.get('invertWheel')) f = 1 / f;   // 设置里可反向
        B.zoomAt(e.clientX, e.clientY, f);
      }, { passive: false });

      /* 缩放工具（PS 同款）：按住一点拖动 = 以该点为中心缩放，右拖放大 / 左拖缩小；
         点按不拖 = 放大一级（Alt+点按 = 缩小一级） */
      let pan = null;      // 平移拖拽状态（空格 / 抓手 / 中键共用）
      let zdrag = null;    // 缩放工具拖拽状态

      stage.addEventListener('pointerdown', e => {
        if (MTG.state.tool === 'zoom' && !B.spaceHeld && e.button === 0) {
          e.preventDefault();
          const r0 = stage.getBoundingClientRect();
          const lx = e.clientX - r0.left, ly = e.clientY - r0.top;
          zdrag = {
            id: e.pointerId, sx: e.clientX, moved: false, alt: e.altKey,
            zPress: B.view.z, ax: lx, ay: ly,
            wx: (lx - B.view.x) / B.view.z, wy: (ly - B.view.y) / B.view.z
          };
          try { stage.setPointerCapture(e.pointerId); } catch (err) {}
          return;
        }
        if (zdrag) return;
        const wantPan = e.button === 1 || B.spaceHeld || MTG.state.tool === 'hand';
        if (!wantPan || e.target.closest && e.target.closest('.stage-zoom')) return;
        e.preventDefault();
        pan = { sx: e.clientX, sy: e.clientY, ox: B.view.x, oy: B.view.y, id: e.pointerId };
        B.panning = true;
        try { stage.setPointerCapture(e.pointerId); } catch (err) {}
        stage.classList.add('panning');
        B.spacePanned = true;
        B.syncCursor();
      });
      stage.addEventListener('pointermove', e => {
        if (zdrag) {
          const dx = e.clientX - zdrag.sx;
          if (Math.abs(dx) > 2) zdrag.moved = true;
          if (zdrag.moved) {
            // 按下点的世界坐标保持不动：右拖 ×2/150px，左拖同比例缩小
            const z2 = U.clamp(zdrag.zPress * Math.pow(2, dx / 150), 0.05, 16);
            B.view.z = z2;
            B.view.x = zdrag.ax - zdrag.wx * z2;
            B.view.y = zdrag.ay - zdrag.wy * z2;
            B.applyView();
          }
          return;
        }
        if (!pan) return;
        B.view.x = pan.ox + (e.clientX - pan.sx);
        B.view.y = pan.oy + (e.clientY - pan.sy);
        B.applyView();
      });
      const endPan = e => {
        if (zdrag) {
          try { stage.releasePointerCapture(zdrag.id); } catch (err) {}
          if (!zdrag.moved) B.zoomAt(zdrag.sx, zdrag.sy, zdrag.alt ? 0.5 : 2);   // 点按：放大/缩小一级
          zdrag = null;
          B.syncCursor();
          return;
        }
        if (!pan) return;
        try { stage.releasePointerCapture(pan.id); } catch (err) {}
        stage.classList.remove('panning');
        pan = null;
        B.panning = false;
        B.syncCursor();
      };
      stage.addEventListener('pointerup', endPan);
      stage.addEventListener('pointercancel', endPan);

      B.fitView();
    },

    /* ══════════ 画布导航 ══════════ */
    applyView() {
      const v = document.getElementById('board-view');
      if (v) v.style.transform = 'translate(' + B.view.x + 'px,' + B.view.y + 'px) scale(' + B.view.z + ')';
      const lab = document.getElementById('z-label');
      if (lab) lab.textContent = Math.round(B.view.z * 100) + '%';
    },
    fitView() {
      const s = B.stageSize();
      if (!s.w || !s.h) return;
      B.view.z = U.clamp(Math.min((s.w - 28) / W, (s.h - 28) / H), 0.05, 16);
      B.view.x = (s.w - W * B.view.z) / 2;
      B.view.y = (s.h - H * B.view.z) / 2;
      B.applyView();
      B.refreshRing();
      B.xfUpdate();
    },
    zoomAt(cx, cy, factor) {
      const rect = document.getElementById('board-stage').getBoundingClientRect();
      const lx = cx - rect.left, ly = cy - rect.top;
      const z2 = U.clamp(B.view.z * factor, 0.05, 16);
      const wx = (lx - B.view.x) / B.view.z, wy = (ly - B.view.y) / B.view.z;
      B.view.z = z2;
      B.view.x = lx - wx * z2;      // 光标下的画布点保持不动
      B.view.y = ly - wy * z2;
      B.applyView();
      B.refreshRing();
      B.xfUpdate();
    },
    zoomCenter(factor) {
      const s = B.stageSize();
      B.zoomAt(s.left + s.w / 2, s.top + s.h / 2, factor);
    },
    zoom100() {
      const s = B.stageSize();
      B.view.z = 1;
      B.view.x = (s.w - W) / 2;
      B.view.y = (s.h - H) / 2;
      B.applyView();
    },
    /* 画布 / 舞台的几何缓存。
       getBoundingClientRect 和 clientWidth 都会**强制同步布局**，而绘制时每帧要量很多次
       （每个 coalesced 采样点一次）。如果同一帧里又写 DOM（光标环）又量 DOM，
       浏览器就得反复重排 —— 这就是"涂抹一卡一卡"的根源（layout thrashing）。
       这里一帧最多实测一次，其余全走缓存。 */
    _geo: null, _geoAt: 0,
    geo() {
      const now = performance.now();
      if (B._geo && now - B._geoAt < 16) return B._geo;
      const cvR = B.cv.getBoundingClientRect();
      const st = document.getElementById('board-stage');
      const stR = st ? st.getBoundingClientRect() : null;
      B._geo = {
        cvLeft: cvR.left, cvTop: cvR.top,
        cvW: cvR.width || 1, cvH: cvR.height || 1,
        stLeft: stR ? stR.left : 0, stTop: stR ? stR.top : 0,
        stW: st ? st.clientWidth : 0, stH: st ? st.clientHeight : 0
      };
      B._geoAt = now;
      return B._geo;
    },
    stageSize() {
      const g = B.geo();
      return { w: g.stW, h: g.stH, left: g.stLeft, top: g.stTop };
    },
    syncCursor() {
      if (!B.cv) return;
      if (B.panning) { B.cv.style.cursor = 'grabbing'; return; }
      if (!MTG.state.currentBoardId) { B.cv.style.cursor = 'not-allowed'; return; }
      if (MTG.state.tool === 'zoom') { B.cv.style.cursor = 'zoom-in'; return; }
      B.cv.style.cursor = (B.spaceHeld || MTG.state.tool === 'hand') ? 'grab' : 'crosshair';
    },

    /* ══════════ 笔尖光标环：实时显示笔刷/橡皮/线宽的实际覆盖范围 + 尺寸数值 ══════════ */
    _ring() {
      if (!B.ring) {
        B.ring = document.getElementById('brush-ring');
        B.ringNum = document.getElementById('brush-ring-num');
      }
      return B.ring;
    },
    hideRing() {
      const ring = B._ring();
      if (ring) ring.style.display = 'none';
      B._ringOn = false;                       // 与 updateRing 的缓存保持同步
      B.ringPos = null;
    },
    updateRing(clientX, clientY) {
      const ring = B._ring();
      if (!ring) return;
      const st = MTG.state;
      const on = !!st.currentBoardId &&
        (st.tool === 'brush' || st.tool === 'eraser' || st.tool === 'line' || st.tool === 'rect') &&
        (!MTG.settings || MTG.settings.get('showRing'));
      if (!on || clientX == null) {
        if (B._ringOn) { ring.style.display = 'none'; B._ringOn = false; }
        B.ringPos = null;
        return;
      }
      if (!B._ringOn) { ring.style.display = 'block'; B._ringOn = true; }
      B.ringPos = { x: clientX, y: clientY };
      const d = Math.max(6, B.widthOf() * B.view.z);     // 屏幕像素直径（最小 6px 保证可见）
      const g = B.geo();
      /* 位置走 transform：它在合成层上处理，不像 left/top 那样触发布局计算。
         尺寸和文字只在值真的变了才写 —— 每帧无条件写 style 会让浏览器一路重排。 */
      ring.style.transform = 'translate3d(' + (clientX - g.stLeft - d / 2) + 'px,' +
                             (clientY - g.stTop - d / 2) + 'px,0)';
      if (B._ringD !== d) {
        ring.style.width = d + 'px';
        ring.style.height = d + 'px';
        B._ringD = d;
      }
      if (B.ringNum) {
        const label = Math.round(B.widthOf()) + 'px';
        if (B._ringLabel !== label) { B.ringNum.textContent = label; B._ringLabel = label; }
        const showNum = !MTG.settings || MTG.settings.get('showRingNum');
        if (B._ringNumShown !== showNum) {
          B.ringNum.style.display = showNum ? '' : 'none';
          B._ringNumShown = showNum;
        }
      }
    },
    refreshRing() {
      if (B.ringPos) B.updateRing(B.ringPos.x, B.ringPos.y);   // 缩放后按原光标位置刷新直径
      else { const r = B._ring(); if (r) r.style.display = 'none'; }
    },

    /* ══════════ 合成与洋葱皮 ══════════ */
    /* 重绘节流：数位板一帧能给好几个点位，合并成一次合成，笔跟手不掉帧 */
    paint() {
      if (B._raf) return;
      B._raf = requestAnimationFrame(() => { B._raf = 0; B.compose(); });
    },
    /* 需要立刻看到结果时用（抬笔 / 切帧 / 撤销 / 选区） */
    paintNow() {
      if (B._raf) { cancelAnimationFrame(B._raf); B._raf = 0; }
      B.compose();
    },

    compose() {
      const c = B.ctx;
      c.clearRect(0, 0, W, H);
      c.fillStyle = (MTG.settings ? MTG.settings.get('paper') : null) || PAPER;
      c.fillRect(0, 0, W, H);
      B.drawOnion();                       // 洋葱皮垫底（前红后蓝重影）
      if (B.showRef) c.drawImage(B.ref, 0, 0);
      c.drawImage(B.bg, 0, 0);
      if (B.drawing && B.strokeTool === 'eraser' && B.outline) {
        B.drawErasePreview(c);             // 橡皮：当前层挖洞的实时预览
      } else {
        c.drawImage(B.fg, 0, 0);
        if ((B.drawing && B.strokeTool === 'brush') || B.xf) {   // 变换预览也走这条离屏层
          // 预览就按最终合成的方式画（含不透明 / 正片叠底），做到所见即所得
          const eng = B.engine();
          c.save();
          c.globalAlpha = U.clamp(B.eff().opacity / 100, 0.01, 1);
          if (eng && eng.kind === 'overlay') c.globalCompositeOperation = 'multiply';
          c.drawImage(B.strokeCv, 0, 0);
          c.restore();
        }
      }
      // 套索：浮动内容 + 蚂蚁线
      if (B.sel && B.sel.float) c.drawImage(B.sel.float.cv, B.sel.float.x, B.sel.float.y);
      B.strokeSelPath(c);
    },

    drawOnion() {
      if (!B.onion.on || !MTG.state.currentBoardId) return;
      const list = B.orderedBoardClips();
      const idx = list.findIndex(c => c.boardId === MTG.state.currentBoardId);
      if (idx < 0) return;
      const base = B.onion.opacity / 100;
      for (let k = 1; k <= B.onion.before; k++) {
        const c = list[idx - k];
        if (!c) break;
        B.blitOnion(c.boardId, '#eb684b', base * (1 - (k - 1) * 0.28));
      }
      for (let k = 1; k <= B.onion.after; k++) {
        const c = list[idx + k];
        if (!c) break;
        B.blitOnion(c.boardId, '#7bbbe3', base * (1 - (k - 1) * 0.28));
      }
    },
    blitOnion(boardId, color, alpha) {
      const img = B.onionImage(boardId);
      if (!(img && img.width)) return;                   // 还没加载好，加载完会自动重绘
      const t = B.tmpx;
      t.globalCompositeOperation = 'source-over';
      t.clearRect(0, 0, W, H);
      t.drawImage(img, 0, 0, W, H);
      t.globalCompositeOperation = 'source-in';          // 只给已有笔画上色
      t.fillStyle = color;
      t.fillRect(0, 0, W, H);
      const c = B.ctx;
      c.save();
      c.globalAlpha = U.clamp(alpha, 0, 1);
      c.drawImage(B.tmp, 0, 0);
      c.restore();
    },
    /* 取洋葱皮要用的帧图：命中缓存直接用；没有就异步加载，完成后自动重绘一次 */
    onionImage(boardId) {
      if (B.onionCache.has(boardId)) return B.onionCache.get(boardId);
      if (B.onionLoading.has(boardId)) return null;
      if (!MTG.storage.ready) return null;
      const b = MTG.findBoard(boardId);
      if (!b) return null;
      B.onionLoading.add(boardId);
      MTG.storage.readFile(b.path).then(blob => {
        if (!blob) { B.onionCache.set(boardId, 'missing'); return; }
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          B.onionCache.set(boardId, img);
          URL.revokeObjectURL(url);          // 解码完成后即可释放，img 自身保留位图
          B.paint();
        };
        img.onerror = () => { URL.revokeObjectURL(url); B.onionCache.set(boardId, 'missing'); };
        img.src = url;
      }).catch(() => {})
        .finally(() => B.onionLoading.delete(boardId));
      return null;
    },
    /* 切帧 / 开洋葱皮时预热前后帧，避免第一次画不出来 */
    preloadOnion() {
      if (!MTG.state.currentBoardId) return;
      const list = B.orderedBoardClips();
      const i = list.findIndex(c => c.boardId === MTG.state.currentBoardId);
      if (i < 0) return;
      for (let k = 1; k <= Math.max(B.onion.before, B.onion.after); k++) {
        if (list[i - k]) B.onionImage(list[i - k].boardId);
        if (list[i + k]) B.onionImage(list[i + k].boardId);
      }
    },

    /* ══════════ 图层操作 ══════════ */
    activeCtx() { return MTG.state.layer === 'bg' ? B.bgx : B.fgx; },
    clearLayer(layer, record) {
      if (record !== false) B.pushUndo(layer || MTG.state.layer);
      const x = (layer || MTG.state.layer) === 'bg' ? B.bgx : B.fgx;
      x.clearRect(0, 0, W, H);
      B.paint();
      B.dirty = true;
      MTG.markDirty();
    },
    clearRef() {
      B.refx.clearRect(0, 0, W, H);
      B.paint();
    },

    /* 更改画幅：已有内容整体缩放适配新尺寸（图层、参考层一并） */
    applySize(w, h) {
      w = U.clamp(Math.round(w) || 1280, 64, 4096);
      h = U.clamp(Math.round(h) || 720, 64, 4096);
      if (w === W && h === H) return;
      const snap = layer => {
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        c.getContext('2d').drawImage(layer, 0, 0);
        return c;
      };
      const bgS = snap(B.bg), fgS = snap(B.fg), refS = snap(B.ref);
      W = w; H = h;
      [B.cv, B.bg, B.fg, B.ref, B.tmp, B.strokeCv].forEach(cv => { cv.width = w; cv.height = h; });
      B.bgx.drawImage(bgS, 0, 0, w, h);
      B.fgx.drawImage(fgS, 0, 0, w, h);
      B.refx.drawImage(refS, 0, 0, w, h);
      B.undoStack.length = 0; B.redoStack.length = 0;   // 画幅变了，历史记录的尺寸失效
      B._pend = null;
      B.sel = null; B.lassoing = false; B.selDrag = null;
      B.paint();
      B.fitView();
      MTG.ui && MTG.ui.syncHistory && MTG.ui.syncHistory();
    },

    /* ── 撤销：脏矩形差分 ──
       旧做法：每落一笔对整层 getImageData（1280×720 ≈ 3.7MB），栈深 16 → 近 60MB 常驻，
       而且快速连笔时这一下分配 + 拷贝本身就够卡。
       新做法：落笔前把图层**整层快拷**进一块复用的 scratch 画布（drawImage，一次，不占栈），
       绘制途中把「即将改到的矩形」并进一个包围盒，收笔时只从 scratch 抠出该矩形存栈。
       常驻内存 = 各笔的包围盒（通常几十 KB），整层读回也从「每笔一次」降到「零次」。 */
    _undoCv: null, _undoCx: null,      // 复用的整层备份（只留一份，不进撤销栈）
    _pend: null,                       // { layer, rect:[x0,y0,x1,y1]|null } 本笔待收尾的脏区

    undoScratch() {
      if (!B._undoCv) {
        B._undoCv = document.createElement('canvas');
        B._undoCx = B._undoCv.getContext('2d', { willReadFrequently: true });
      }
      const c = B._undoCv;
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      return c;
    },
    /* 落笔前：整层拷进 scratch，开启脏区累积（上一笔没收尾就先收掉，不丢步） */
    beginUndo(layer) {
      if (B._pend) B.endUndo();
      const src = layer === 'bg' ? B.bg : B.fg;
      const sx = B.undoScratch().getContext('2d');
      sx.setTransform(1, 0, 0, 1, 0, 0);
      sx.globalAlpha = 1;
      sx.globalCompositeOperation = 'source-over';
      sx.clearRect(0, 0, W, H);
      sx.drawImage(src, 0, 0);
      B._pend = { layer, rect: null };
    },
    /* 即将改动某矩形之前调用：并进本笔脏区 */
    markUndo(x0, y0, x1, y1) {
      const p = B._pend;
      if (!p) return;
      x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
      x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
      if (x1 <= x0 || y1 <= y0) return;
      const r = p.rect;
      if (!r) p.rect = [x0, y0, x1, y1];
      else {
        if (x0 < r[0]) r[0] = x0;
        if (y0 < r[1]) r[1] = y0;
        if (x1 > r[2]) r[2] = x1;
        if (y1 > r[3]) r[3] = y1;
      }
    },
    /* 收笔：把脏区的「改动前」像素存进栈；空脏区（点一下没画成）直接丢弃 */
    endUndo() {
      const p = B._pend;
      B._pend = null;
      if (!p || !p.rect) return false;
      const [x0, y0, x1, y1] = p.rect;
      const w = Math.min(x1, W) - x0, h = Math.min(y1, H) - y0;
      if (w <= 0 || h <= 0) return false;
      let before;
      try { before = B._undoCx.getImageData(x0, y0, w, h); } catch (e) { return false; }
      B.pushRec({ layer: p.layer, x: x0, y: y0, w, h, before });
      return true;
    },
    /* 一次性操作（清层 / 填充 / 变换 / 选区）：改动前直接拍指定区域，缺省整层 */
    pushUndo(layer, box) {
      const x = layer === 'bg' ? B.bgx : B.fgx;
      let x0 = 0, y0 = 0, x1 = W, y1 = H;
      if (box) {
        x0 = Math.max(0, Math.floor(box[0])); y0 = Math.max(0, Math.floor(box[1]));
        x1 = Math.min(W, Math.ceil(box[2])); y1 = Math.min(H, Math.ceil(box[3]));
      }
      if (x1 <= x0 || y1 <= y0) return;
      let before;
      try { before = x.getImageData(x0, y0, x1 - x0, y1 - y0); } catch (e) { return; }
      B.pushRec({ layer, x: x0, y: y0, w: x1 - x0, h: y1 - y0, before });
    },
    pushRec(rec) {
      B.undoStack.push(rec);
      B.trimUndo();
      B.redoStack.length = 0;
      MTG.ui && MTG.ui.syncHistory && MTG.ui.syncHistory();
    },
    /* 撤销栈深在设置里可调：改小就把多余的老记录裁掉 */
    trimUndo() {
      const max = (MTG.settings && +MTG.settings.get('maxUndo')) || MAX_UNDO;
      while (B.undoStack.length > max) B.undoStack.shift();
      while (B.redoStack.length > max) B.redoStack.shift();
      MTG.ui && MTG.ui.syncHistory && MTG.ui.syncHistory();
    },
    /* 一条记录同时在 undo / redo 栈里流转：把该区域的「栈里那份」与「图层当前」互换 ——
       撤销与重做因此完全对称，不需要各自再拍快照。 */
    _swapRec(s) {
      const x = s.layer === 'bg' ? B.bgx : B.fgx;
      let cur;
      try { cur = x.getImageData(s.x, s.y, s.w, s.h); } catch (e) { return; }
      x.putImageData(s.before, s.x, s.y);
      s.before = cur;
      B.paint();
      B.dirty = true;
      MTG.markDirty();
      MTG.ui && MTG.ui.syncHistory && MTG.ui.syncHistory();
    },
    undo() {
      if (B._pend) B.endUndo();            // 有未收尾的笔先落账
      const s = B.undoStack.pop();
      if (!s) return;
      B.redoStack.push(s);
      B._swapRec(s);
    },
    redo() {
      const s = B.redoStack.pop();
      if (!s) return;
      B.undoStack.push(s);
      B.trimUndo();
      B._swapRec(s);
    },
    /* 点列包围盒 + 外扩（供撤销脏区用） */
    pointsBox(list, pad) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of list) {
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      }
      if (!isFinite(x0)) return [0, 0, 0, 0];
      return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
    },

    /* ══════════ 压感 ══════════ */
    toCanvas(e) {
      const g = B.geo();                       // 走缓存，不再每次强制布局
      return {
        x: (e.clientX - g.cvLeft) * (W / g.cvW),
        y: (e.clientY - g.cvTop) * (H / g.cvH)
      };
    },
    /* ══════════ 压感笔画（perfect-freehand 引擎） ══════════
       不再逐段画线，而是收集 [x, y, pressure] 点列，由 perfect-freehand
       生成整条笔画的轮廓多边形再填充：
       · 起笔/收笔锥形收窄（taper）→ 轻点起笔不会再出现一个大圆点
       · 压力在点间插值 → 笔画粗细连续，不再依赖事件里的瞬时压力
       · 鼠标/触屏用 simulatePressure 按速度模拟；数位板用真实 pressure */
    pressureOf(e) {
      if (e.pointerType !== 'pen' || !MTG.state.brush.usePressure) return 0.5;
      const p = e.pressure == null ? 0 : e.pressure;
      if (p > 0) { B.ps.seen = true; B.ps.last = p; return B.pcurve(p); }
      // 起笔/抬笔瞬间驱动常给 0：起笔保留真实的 0（由 taper 收窄），
      // 中途掉 0 视为驱动抖动，回落到上次有效压力
      return B.ps.seen ? B.pcurve(B.ps.last * 0.6) : 0;
    },
    /* 笔压曲线：soft = 轻压更灵敏（起笔就粗），hard = 要压重了才明显 */
    pcurve(p) {
      const c = MTG.settings ? MTG.settings.get('pressureCurve') : 'linear';
      if (c === 'soft') return Math.pow(p, 0.65);
      if (c === 'hard') return Math.pow(p, 1.5);
      return p;
    },
    /* 抖动修正：照参考实现（paint-lab）的 stabilize —— 「拉绳 + 指数平滑」两级。
       ① 拉绳：笔尖离真实位置最远只允许 rope = lv×90 像素（默认 0.3 → 27px）。
          这一级是关键：它让平滑**不会把手感拖远** —— 走得快时绳子绷紧，
          笔尖被拽着跟上，而不是像纯指数平滑那样越走越落后。
       ② 指数平滑：固定系数 k = 1 - lv×0.88，不做速度自适应。
       （之前那版按速度改系数、还加了 0.35px 噪声门限，慢笔滞后明显，是"跟不上手"的一环。） */
    smoothPt(p) {
      const lv = U.clamp((MTG.settings ? +MTG.settings.get('stabilizer') : 30) / 100, 0, 0.95);
      if (!B.sm) { B.sm = { x: p.x, y: p.y }; return p; }
      if (lv <= 0.002) { B.sm.x = p.x; B.sm.y = p.y; return p; }
      const rope = lv * 90;
      let dx = p.x - B.sm.x, dy = p.y - B.sm.y;
      const d = Math.hypot(dx, dy);
      if (d > rope && d > 1e-6) {
        B.sm.x = p.x - dx / d * rope;
        B.sm.y = p.y - dy / d * rope;
        dx = p.x - B.sm.x;
        dy = p.y - B.sm.y;
      }
      const k = 1 - lv * 0.88;
      B.sm.x += dx * k;
      B.sm.y += dy * k;
      p.x = B.sm.x;
      p.y = B.sm.y;
      return p;
    },
    strokeOptions(last) {
      const st = MTG.state;
      const eng = B.engine();
      if (eng) return MTG.brushes.outlineOptions(eng.id, B.bp, last, B.strokeIsPen);   // 钢笔 / 秀丽笔
      // 回退：未接引擎时的旧参数
      // perfect-freehand 半径公式：size · f(0.5 − thinning·(0.5 − pressure))
      //   thinning = k → k=0 完全无压感差；size/(1+k) → 保证 pressure=1 时半径恒为 size/2
      const k = st.brush.usePressure ? st.brush.pressure / 100 : 0;
      return {
        size: st.brush.size / (1 + k),
        thinning: k,
        smoothing: 0.5,
        streamline: 0.5,
        simulatePressure: !B.strokeIsPen,
        start: { cap: true, taper: st.brush.size, easing: t => t * t },
        end: { cap: true, taper: st.brush.size },
        last: !!last
      };
    },
    /* ── 柳叶笔（套索填充）：随手圈一圈，松手就用当前颜色填满这块形状 ── */
    fillPath: null,
    renderFillPreview() {
      const sx = B.strokex;
      sx.clearRect(0, 0, W, H);
      const path = B.fillPath;
      if (path && path.length > 1) {
        const st = MTG.state;
        const alpha = U.clamp(B.eff().opacity / 100, 0.05, 1);
        sx.save();
        sx.globalAlpha = alpha * 0.6;              // 填充预览淡一点，能看到底下的画
        sx.fillStyle = st.color;
        B.buildPath(sx, path);
        sx.fill('nonzero');
        sx.globalAlpha = Math.min(1, alpha + 0.25);
        sx.strokeStyle = st.color;
        sx.lineWidth = Math.max(1, 1.6 / Math.max(0.01, B.view.z));
        B.buildPath(sx, path);
        sx.stroke();
        sx.restore();
      }
      B.paint();
    },
    commitFill() {
      const path = B.fillPath;
      B.fillPath = null;
      B.strokex.clearRect(0, 0, W, H);
      if (!path || path.length < 3) { B.paintNow(); return; }
      const bb = B.pathBBox(path), pad0 = B.eff().size + 6;
      B.pushUndo(MTG.state.layer, [bb.x - pad0, bb.y - pad0, bb.x + bb.w + pad0, bb.y + bb.h + pad0]);
      const x = B.activeCtx();
      x.save();
      x.globalAlpha = U.clamp(B.eff().opacity / 100, 0.05, 1);
      x.fillStyle = MTG.state.color;
      B.withSel(x, () => {                         // 有选区时只填在选区内
        B.buildPath(x, path);
        x.fill('nonzero');
      });
      x.restore();
      B.dirty = true;
      MTG.markDirty();
      B.paintNow();
    },

    fillOutline(x, outline) {
      if (!outline || outline.length < 2) return;
      x.beginPath();
      x.moveTo(outline[0][0], outline[0][1]);
      for (let i = 1; i < outline.length - 1; i++) {
        const a = outline[i], b = outline[i + 1];
        x.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      }
      x.closePath();
      x.fill('nonzero');
    },
    /* 点按圆点半径：与引擎同一公式，但不吃 taper（否则单击会缩成不可见） */
    dotRadius(pressure) {
      const st = MTG.state;
      const k = st.brush.usePressure ? st.brush.pressure / 100 : 0;
      return Math.max(0.6, (B.eff().size / (1 + k)) * (0.5 - k * (0.5 - pressure)));
    },
    renderStroke() {
      const st = MTG.state;
      if (B.points.length === 1) {                        // 落笔瞬间：先给一个与压力匹配的点
        const p0 = B.points[0], sx = B.strokex;
        sx.clearRect(0, 0, W, H);
        if (st.tool === 'brush') {
          sx.fillStyle = st.color;
          sx.globalAlpha = B.eff().opacity / 100;
          sx.beginPath();
          sx.arc(p0[0], p0[1], B.dotRadius(p0[2]), 0, Math.PI * 2);
          sx.fill();
          sx.globalAlpha = 1;
        }
        B.paint();
        return;
      }
      B.outline = window.PerfectFreehand.getStroke(B.points, B.strokeOptions(false));
      if (st.tool === 'eraser') { B.paint(); return; }   // 橡皮在 paint 里做挖洞预览
      const sx = B.strokex;
      sx.clearRect(0, 0, W, H);
      sx.fillStyle = st.color;
      sx.globalAlpha = B.eff().opacity / 100;
      B.fillOutline(sx, B.outline);
      sx.globalAlpha = 1;
      B.paint();
    },
    drawErasePreview(c) {
      const act = MTG.state.layer;
      const hole = B.strokex;                            // 借用笔画画布做草稿
      hole.globalCompositeOperation = 'source-over';
      hole.clearRect(0, 0, W, H);
      hole.drawImage(act === 'bg' ? B.bg : B.fg, 0, 0);
      hole.globalCompositeOperation = 'destination-out';
      B.fillOutline(hole, B.outline);
      hole.globalCompositeOperation = 'source-over';
      if (act === 'bg') { c.drawImage(B.strokeCv, 0, 0); c.drawImage(B.fg, 0, 0); }
      else { c.drawImage(B.bg, 0, 0); c.drawImage(B.strokeCv, 0, 0); }
    },
    commitStroke() {
      const st = MTG.state;
      const x = B.activeCtx();
      const first = B.points[0], lastP = B.points[B.points.length - 1];
      const travel = Math.hypot(lastP[0] - first[0], lastP[1] - first[1]);
      const bb = B.pointsBox(B.points, B.eff().size * 1.2 + 6);   // 撤销脏区：整条笔画的范围

      if (st.tool === 'eraser') {                       // 橡皮：直接对图层挖洞
        B.markUndo(bb[0], bb[1], bb[2], bb[3]);
        x.save();
        x.globalCompositeOperation = 'destination-out';
        x.fillStyle = '#000';
        if (travel < 3) {
          x.beginPath();
          x.arc(lastP[0], lastP[1], B.dotRadius(lastP[2]), 0, Math.PI * 2);
          x.fill();
        } else {
          B.fillOutline(x, window.PerfectFreehand.getStroke(B.points, B.strokeOptions(true)));
        }
        x.restore();
        B.strokex.clearRect(0, 0, W, H);
        B.dirty = true;
        MTG.markDirty();
        return;
      }

      /* 画笔（outline）：离屏画完 → 压纸纹 → 整笔合成，和 dab 走同一条路 */
      const sx = B.strokex;
      sx.clearRect(0, 0, W, H);
      sx.fillStyle = st.color;
      if (travel < 3) {
        // 点按：实心圆点（半径随压力），不吃 taper
        sx.beginPath();
        sx.arc(lastP[0], lastP[1], B.dotRadius(lastP[2]), 0, Math.PI * 2);
        sx.fill();
      } else {
        B.fillOutline(sx, window.PerfectFreehand.getStroke(B.points, B.strokeOptions(true)));
      }
      if (MTG.brushes) MTG.brushes.applyPaper(sx, B.brushId, W, H);
      B.markUndo(bb[0], bb[1], bb[2], bb[3]);
      x.save();
      x.globalAlpha = U.clamp(B.eff().opacity / 100, 0.01, 1);
      B.withSel(x, () => x.drawImage(B.strokeCv, 0, 0));
      x.restore();
      sx.clearRect(0, 0, W, H);
      B.dirty = true;
      MTG.markDirty();
    },

    widthOf() { return B.eff().size; },        // 直线/矩形用固定线宽

    /* ══════════ 笔刷引擎接线 ══════════ */
    engine() {
      if (MTG.state.tool !== 'brush' || !MTG.brushes) return null;
      return MTG.brushes.get(B.brushId);
    },
    /* 当前生效的大小 / 不透明（引擎优先，无引擎时回退到旧 brush 参数） */
    eff() {
      if (B.engine()) return { size: B.bp.size, opacity: B.bp.opacity };
      return { size: MTG.state.brush.size, opacity: MTG.state.brush.opacity };
    },
    setBrush(id) {
      B.brushId = id;
      B.bp = MTG.brushes.loadParams(id);
      MTG.brushes.saveParams(id, B.bp);
    },
    /* dab / overlay 不直接往图层上盖，而是画到离屏笔画层，抬笔时整笔合成一次 ——
       沿途反复盖章 / 反复 multiply 会让一笔之内浓淡不匀、边缘发脏。 */
    stampSeg(eng, from, to, pressure) {
      const fx = from[0] != null ? from[0] : from.x;
      const fy = from[1] != null ? from[1] : from.y;
      const seg = {
        px: fx, py: fy, x: to.x, y: to.y,
        dist: Math.hypot(to.x - fx, to.y - fy),
        pressure: pressure || 0.5,
        pressure0: from[2] != null ? from[2] : (pressure || 0.5),  // 段内压感插值用
        mixSrc: B.activeCtx().canvas                              // 混色取色用（图层本身）
      };
      const x = B.strokex;
      B.withSel(x, () => MTG.brushes.stampDab(x, eng.id, B.bp, MTG.state.color, seg));
      /* 撤销脏区：整笔最后由 commitDabStroke 合成到图层，这里把笔迹范围累积进本笔脏区 */
      const rr = B.bp.size * (0.6 + (B.bp.scatter || 0) * 0.5) + 6;
      B.markUndo(Math.min(fx, to.x) - rr, Math.min(fy, to.y) - rr,
                 Math.max(fx, to.x) + rr, Math.max(fy, to.y) + rr);
    },
    /* ══════════ 自由变换（Ctrl+T） ══════════
       对「套索抬起的内容」或「贴入的图片」做移动 / 缩放：内容先画在离屏层做预览，
       回车落到当前图层，Esc 放弃。角点默认等比，按住 Shift 自由拉伸。 */
    xf: null, xfEl: null,

    pasteImage(img) {
      if (!MTG.state.currentBoardId) { MTG.toast('播放头不在任何帧上', true); return; }
      const k = Math.min((W * 0.8) / img.naturalWidth, (H * 0.8) / img.naturalHeight, 1);
      const w = Math.max(8, img.naturalWidth * k), h = Math.max(8, img.naturalHeight * k);
      const cv = document.createElement('canvas');
      cv.width = Math.ceil(w); cv.height = Math.ceil(h);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      B.beginTransform(cv, { x: (W - w) / 2, y: (H - h) / 2, w, h }, 'image');
      MTG.toast('拖动摆位置 · 拉四角改大小（Shift 自由拉伸）· 回车确认，Esc 取消');
    },

    /* Ctrl+T：有选区就变换选区内容，否则提示 */
    startTransform() {
      if (!MTG.state.currentBoardId) { MTG.toast('播放头不在任何帧上', true); return; }
      if (B.xf) { B.xfCommit(); return; }
      if (B.sel && B.sel.path && B.sel.path.length > 2 && !B.sel.float) B.liftSel();   // 选了区但还没抬起
      if (B.sel && B.sel.float) {
        const f = B.sel.float;
        B.beginTransform(f.cv, { x: f.x, y: f.y, w: f.cv.width, h: f.cv.height }, 'sel');
        MTG.toast('拖动摆位置 · 拉四角改大小 · 回车确认，Esc 取消');
        return;
      }
      MTG.toast('先用套索圈出要变的内容，或从素材库点「贴入」放一张图', true);
    },

    beginTransform(src, rect, kind) {
      B.xf = {
        src, kind: kind || 'image',
        x: rect.x, y: rect.y, w: rect.w, h: rect.h,
        handle: null, sx: 0, sy: 0, ox: 0, oy: 0, ow: 0, oh: 0
      };
      B.ensureXfEl();
      if (B.xfEl) B.xfEl.classList.remove('hidden');
      B.xfUpdate();
      B.xfPreview();
    },

    xfPreview() {
      const t = B.xf;
      if (!t) return;
      const sx = B.strokex;
      sx.clearRect(0, 0, W, H);
      sx.drawImage(t.src, 0, 0, t.src.width, t.src.height, t.x, t.y, t.w, t.h);
      B.paintNow();
    },
    xfCommit() {
      const t = B.xf;
      if (!t) return;
      B.pushUndo(MTG.state.layer, [t.x - 6, t.y - 6, t.x + t.w + 6, t.y + t.h + 6]);
      B.activeCtx().drawImage(t.src, 0, 0, t.src.width, t.src.height, t.x, t.y, t.w, t.h);
      B.xfEnd();
      B.dirty = true;
      MTG.markDirty();
      B.paintNow();
      MTG.toast('已确认变形');
    },
    xfCancel() {
      if (!B.xf) return;
      B.xfEnd();
      B.paintNow();
      MTG.toast('已取消变形');
    },
    xfEnd() {
      if (B.xf && B.xf.kind === 'sel') {          // 选区内容已经变形落位，原位置不必再回填
        B.sel = null;
        MTG.ui && MTG.ui.syncSel && MTG.ui.syncSel();
      }
      B.xf = null;
      if (B.xfEl) B.xfEl.classList.add('hidden');
      B.strokex.clearRect(0, 0, W, H);
    },
    xfUpdate() {
      const t = B.xf;
      if (!t || !B.xfEl) return;
      B.xfEl.style.left = (B.view.x + t.x * B.view.z) + 'px';
      B.xfEl.style.top = (B.view.y + t.y * B.view.z) + 'px';
      B.xfEl.style.width = (t.w * B.view.z) + 'px';
      B.xfEl.style.height = (t.h * B.view.z) + 'px';
    },

    ensureXfEl() {
      if (B.xfEl) return B.xfEl;
      const st = document.getElementById('board-stage');
      if (!st) return null;
      const el = document.createElement('div');
      el.id = 'xf-box';
      el.className = 'xf-box hidden';
      ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(h => {
        const i = document.createElement('i');
        i.className = 'xf-h ' + h;
        i.dataset.h = h;
        el.appendChild(i);
      });
      st.appendChild(el);
      B.xfEl = el;

      const start = (e, handle) => {
        const t = B.xf;
        if (!t) return;
        e.preventDefault();
        e.stopPropagation();
        t.handle = handle;
        t.ox = t.x; t.oy = t.y; t.ow = t.w; t.oh = t.h;
        t.sx = e.clientX; t.sy = e.clientY;
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
      };
      el.addEventListener('pointerdown', e => {
        start(e, (e.target.dataset && e.target.dataset.h) || 'move');
      });
      el.addEventListener('pointermove', e => {
        const t = B.xf;
        if (!t || !t.handle) return;
        const dx = (e.clientX - t.sx) / B.view.z;
        const dy = (e.clientY - t.sy) / B.view.z;
        let x = t.ox, y = t.oy, w = t.ow, h = t.oh;
        if (t.handle === 'move') {
          x = t.ox + dx; y = t.oy + dy;
        } else {
          if (t.handle.indexOf('e') >= 0) w = t.ow + dx;
          if (t.handle.indexOf('s') >= 0) h = t.oh + dy;
          if (t.handle.indexOf('w') >= 0) { w = t.ow - dx; x = t.ox + dx; }
          if (t.handle.indexOf('n') >= 0) { h = t.oh - dy; y = t.oy + dy; }
          const keep = !e.shiftKey && /^(nw|ne|se|sw)$/.test(t.handle);   // 角点默认等比
          if (keep && t.ow > 0 && t.oh > 0) {
            const k = Math.max(Math.abs(w) / t.ow, Math.abs(h) / t.oh);
            w = t.ow * k; h = t.oh * k;
            if (t.handle.indexOf('w') >= 0) x = t.ox + (t.ow - w);
            if (t.handle.indexOf('n') >= 0) y = t.oy + (t.oh - h);
          }
        }
        t.w = Math.max(2, w); t.h = Math.max(2, h);
        t.x = x; t.y = y;
        B.xfUpdate();
        B.xfPreview();
      });
      const up = () => { if (B.xf) B.xf.handle = null; };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      return el;
    },

    /* 抬笔：把离屏笔画层整笔合成到目标层 */
    commitDabStroke(eng) {
      const x = B.activeCtx();
      if (MTG.brushes) MTG.brushes.applyPaper(B.strokex, eng.id, W, H);   // 笔迹吃纸纹
      x.save();
      B.withSel(x, () => {
        x.globalAlpha = U.clamp(B.eff().opacity / 100, 0.01, 1);
        x.globalCompositeOperation = eng.kind === 'overlay' ? 'multiply' : 'source-over';
        x.drawImage(B.strokeCv, 0, 0);
      });
      x.restore();
      B.strokex.clearRect(0, 0, W, H);
      B.dirty = true;
      MTG.markDirty();
    },
    effectSeg(eng, from, to, pressure) {
      const x = B.activeCtx();
      /* 像素级 effect 不受 canvas 裁剪约束，所以选区要自己判：笔尖不在选区内就跳过 */
      if (B.sel && B.sel.path && B.sel.path.length > 2 && !B.inSel(to.x, to.y)) return;
      /* 注：颜料桶不在这里更新 —— 参考实现是「本批的段跑之前 updateBucket() 一次」，
         调用点在 move() 里段循环之前（每段都更新会让桶色跟着笔尖跳）。 */
      /* 撤销脏区：本段笔尖覆盖范围（含涂抹拖拽 / 模糊扩散的余量，取压感上限保守估） */
      const rr = Math.max(2, B.eff().size * 0.75) +
        (eng.id === 'smudge'
          ? Math.ceil(B.eff().size * 0.75 * Math.max(0.1, (B.bp.drag == null ? 60 : B.bp.drag) / 100)) + 4
          : Math.ceil(Math.max(1, B.bp.blurRadius == null ? 14 : B.bp.blurRadius)) + 4);
      B.markUndo(Math.min(from.x, to.x) - rr, Math.min(from.y, to.y) - rr,
                 Math.max(from.x, to.x) + rr, Math.max(from.y, to.y) + rr);
      B.withSel(x, () => MTG.brushes.applyEffect(x, x.canvas, eng.id, B.bp, {
        px: from.x, py: from.y, x: to.x, y: to.y,
        pressure: pressure || 0.5,
        pickup: B.pickup            // 涂抹用：落笔时拾取的那块颜色
      }));
      B.dirty = true;
      MTG.markDirty();
    },

    /* ══════════ 套索选区（抬起浮动内容 → 可移动 / 可填充） ══════════ */
    buildPath(x, path) {
      if (!path || !path.length) return;
      x.beginPath();
      x.moveTo(path[0][0], path[0][1]);
      for (let i = 1; i < path.length; i++) x.lineTo(path[i][0], path[i][1]);
      x.closePath();
    },
    /* 有选区时把绘制限制在选区内 */
    withSel(x, fn) {
      const on = !!(B.sel && B.sel.path && B.sel.path.length > 2);
      x.save();
      if (on) { B.buildPath(x, B.sel.path); x.clip(); }
      fn();
      x.restore();
    },
    inSel(x, y) {
      const path = B.sel && B.sel.path;
      if (!path || path.length < 3) return false;
      let inside = false;
      for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
        const xi = path[i][0], yi = path[i][1], xj = path[j][0], yj = path[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
      }
      return inside;
    },
    pathBBox(path) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      path.forEach(p => {
        x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
      });
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    },
    /* 把选区内的像素从图层「抬起」成浮动层：内容跟着选区走，可整体拖动 */
    liftSel() {
      const s = B.sel;
      if (!s || !s.path || s.path.length < 3) return;
      const bb = B.pathBBox(s.path);
      const pad = 2;
      const w = Math.ceil(bb.w + pad * 2), h = Math.ceil(bb.h + pad * 2);
      if (w <= 0 || h <= 0) return;
      const layer = MTG.state.layer === 'bg' ? B.bg : B.fg;
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const cx = cv.getContext('2d');
      cx.save();
      cx.translate(-(bb.x - pad), -(bb.y - pad));
      B.buildPath(cx, s.path);
      cx.clip();
      cx.drawImage(layer, 0, 0);
      cx.restore();
      const lx = B.activeCtx();                 // 原位置挖空
      B.pushUndo(MTG.state.layer, [bb.x - pad, bb.y - pad, bb.x + bb.w + pad, bb.y + bb.h + pad]);
      lx.save();
      B.buildPath(lx, s.path);
      lx.clip();
      lx.clearRect(bb.x - pad, bb.y - pad, w, h);
      lx.restore();
      s.float = { cv, x: bb.x - pad, y: bb.y - pad };
      B.dirty = true;
      MTG.markDirty();
    },
    moveSel(dx, dy) {
      const s = B.sel;
      if (!s) return;
      s.path.forEach(p => { p[0] += dx; p[1] += dy; });
      if (s.float) { s.float.x += dx; s.float.y += dy; }
      B.dirty = true;
      MTG.markDirty();
    },
    /* 浮动内容落回图层（保存 / 切换工具前一定调用，不会丢） */
    commitSel() {
      const s = B.sel;
      if (!s) return;
      if (s.float) {
        const f = s.float;
        B.pushUndo(MTG.state.layer, [f.x - 2, f.y - 2, f.x + f.cv.width + 2, f.y + f.cv.height + 2]);
        B.activeCtx().drawImage(f.cv, f.x, f.y);
        s.float = null;
        B.dirty = true;
        MTG.markDirty();
      }
      B.sel = null;
      MTG.ui && MTG.ui.syncSel && MTG.ui.syncSel();
    },
    fillSel() {
      const s = B.sel;
      if (!s || !s.path || s.path.length < 3) { MTG.toast('先用套索画一个选区', true); return; }
      if (!s.float) B.liftSel();
      if (!s.float) return;
      const bb = B.pathBBox(s.path);
      const cx = s.float.cv.getContext('2d');
      cx.save();
      cx.translate(-s.float.x, -s.float.y);
      B.buildPath(cx, s.path);
      cx.clip();
      cx.fillStyle = MTG.state.color;
      cx.fillRect(bb.x - 2, bb.y - 2, bb.w + 4, bb.h + 4);
      cx.restore();
      B.dirty = true;
      MTG.markDirty();
      B.paint();
      MTG.toast('已用当前颜色填充选区');
    },
    deleteSel() {
      const s = B.sel;
      if (!s) { MTG.toast('没有选区', true); return; }
      if (s.float) s.float.cv.getContext('2d').clearRect(0, 0, s.float.cv.width, s.float.cv.height);
      B.commitSel();
      B.paint();
      MTG.toast('已删除选区内容');
    },
    strokeSelPath(c) {
      const s = B.sel;
      if (!s || !s.path || s.path.length < 3) return;
      const inv = 1 / Math.max(0.01, B.view.z);   // 蚂蚁线粗细/间距始终按屏幕大小，缩小时不至于看不见
      c.save();
      c.lineWidth = 1.5 * inv;
      c.setLineDash([6 * inv, 4 * inv]);
      c.strokeStyle = 'rgba(255,255,255,.92)';
      B.buildPath(c, s.path);
      c.stroke();
      c.strokeStyle = 'rgba(0,0,0,.65)';
      c.lineDashOffset = 5 * inv;
      B.buildPath(c, s.path);
      c.stroke();
      c.restore();
    },

    /* ══════════ 指针事件 ══════════ */
    down(e) {
      if (e.button === 2) return;
      if (B.xf) return;                          // 变换进行中：先回车确认 / Esc 放弃
      const st = MTG.state;
      if (st.tool === 'hand' || st.tool === 'zoom' || B.spaceHeld) return;    // 抓手/缩放工具：不落笔
      if (!st.currentBoardId) { MTG.toast('播放头不在任何分镜帧上，先新建帧或把播放头移到片段里'); return; }
      const p = B.toCanvas(e);

      if (st.tool === 'eyedrop') {
        const d = B.ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data;
        const hex = U.rgb2hex(d[0], d[1], d[2]);
        MTG.picker.set(hex);
        MTG.picker.pushSwatch(hex);
        MTG.ui && MTG.ui.syncColor && MTG.ui.syncColor(hex);
        return;
      }

      /* 套索：在已有选区内按下 = 拖动选区内容；否则开始画新选区 */
      if (st.tool === 'lasso') {
        if (B.sel && B.sel.path && B.inSel(p.x, p.y)) {
          B.selDrag = { sx: p.x, sy: p.y, dx: 0, dy: 0, moved: false };
        } else {
          if (B.sel && B.sel.float) B.commitSel();      // 先把上一段浮动内容落回去
          B.sel = { path: [[p.x, p.y]], float: null };
          B.lassoing = true;
        }
        try { B.cv.setPointerCapture(e.pointerId); } catch (err) {}
        B.drawing = true;
        return;
      }

      try { B.cv.setPointerCapture(e.pointerId); } catch (err) {}
      B.ps = { seen: false, last: 0.5 };
      B.sm = null;                                  // 抖动修正：每一笔重置平滑锚点
      B.beginUndo(st.layer);                        // 撤销：整层快拷进复用备份，开启脏区累积
      B.shapeRect = null;                           // 直线 / 矩形：上一帧画过的区域
      B.drawing = true;
      B.start = p; B.last = p; B.lastMid = p;

      B.strokeTool = (st.tool === 'brush' || st.tool === 'eraser') ? st.tool : null;
      if (B.strokeTool) {
        B.strokeIsPen = e.pointerType === 'pen';
        B.points = [[p.x, p.y, B.pressureOf(e)]];
        B.outline = null;
        B.strokex.clearRect(0, 0, W, H);      // 笔画层归零：dab / overlay 整笔都画在这上面
        const eng = B.engine();
        if (!eng || eng.kind === 'outline') { B.renderStroke(); return; }
        if (eng.kind === 'dab' || eng.kind === 'overlay') {
          B.stampSeg(eng, B.points[0], { x: p.x, y: p.y }, B.points[0][2]);   // 落笔先盖一个点
          B.paint();
        } else if (eng.kind === 'fill') {
          B.fillPath = [[p.x, p.y]];                  // 柳叶笔：先攒轮廓，松手再填
        } else if (eng.id === 'smudge') {
          MTG.brushes.resetSmudge();                  // 涂抹：每一笔重置颜料桶
        }
        // effect（模糊 / 涂抹）要位移才有意义，等 move 再处理
        return;
      }
      // 直线 / 矩形：每次移动从撤销备份抠回上一帧区域再重绘（不再整层快照），笔刷点列用不到
      B.points = null;
      B.shapeRect = null;
    },
    move(e) {
      B.updateRing(e.clientX, e.clientY);   // 光标环：未落笔时也要跟随
      if (!B.drawing) return;
      const st = MTG.state;

      /* 套索：画选区轮廓，或整块拖动选区内容 */
      if (st.tool === 'lasso') {
        const p = B.toCanvas(e);
        if (B.lassoing && B.sel) {
          const last = B.sel.path[B.sel.path.length - 1];
          if (Math.hypot(p.x - last[0], p.y - last[1]) > 2) B.sel.path.push([p.x, p.y]);
        } else if (B.selDrag && B.sel) {
          const dx = p.x - B.selDrag.sx, dy = p.y - B.selDrag.sy;
          const stepX = dx - B.selDrag.dx, stepY = dy - B.selDrag.dy;
          if (Math.abs(stepX) + Math.abs(stepY) > 0.4) {
            B.moveSel(stepX, stepY);
            B.selDrag.dx = dx; B.selDrag.dy = dy;
            B.selDrag.moved = true;
          }
        }
        B.paint();
        return;
      }

      const eng = B.engine();
      const direct = eng && (eng.kind === 'dab' || eng.kind === 'overlay' || eng.kind === 'effect');
      // 高频采样：数位板一帧内可能有多个点位，全部收集，压感曲线才连续
      const co = (e.getCoalescedEvents && e.getCoalescedEvents()) || null;
      const list = (co && co.length) ? co : [e];
      let added = false;
      const segs = [];                       // effect 类：本批的段攒起来，处理完再统一跑（见循环后）
      for (const ev of list) {
        const p = B.toCanvas(ev);
        B.smoothPt(p);                                             // 抖动修正
        if (st.tool === 'brush' && eng && eng.kind === 'fill') {   // 柳叶笔：攒轮廓 + 实时预览
          if (!B.fillPath) B.fillPath = [[p.x, p.y]];
          const fp = B.fillPath[B.fillPath.length - 1];
          if (Math.hypot(p.x - fp[0], p.y - fp[1]) > 1.5) {
            B.fillPath.push([p.x, p.y]);
            B.renderFillPreview();
          }
          B.last = p;
          continue;
        }
        if (st.tool === 'brush' || st.tool === 'eraser') {
          const lp = B.points[B.points.length - 1];
          if (direct) {
            /* effect 类不做间距过滤：参考实现是「每段一次」，速度相关由弧长归一处理。
               旧的按笔刷大小留间距会让涂抹一顿一顿的。段阈值 0.6 与参考实现一致。 */
            if (Math.hypot(p.x - lp[0], p.y - lp[1]) < 0.6) continue;
            if (eng.kind === 'effect') segs.push([{ x: lp[0], y: lp[1] }, { x: p.x, y: p.y }, B.pressureOf(ev)]);
            else B.stampSeg(eng, lp, p, B.pressureOf(ev));
            B.points.push([p.x, p.y, B.pressureOf(ev)]);
            added = true;
          } else {
            if (Math.hypot(p.x - lp[0], p.y - lp[1]) < 1.2) continue;
            B.points.push([p.x, p.y, B.pressureOf(ev)]);
            added = true;
          }
        } else {
          B.redrawShape(B.start, p, ev);
        }
        B.last = p;
      }
      /* effect 类：本批的段在这里统一跑。
         颜料桶必须**本批只更新一次**（对应参考实现「整帧的 segs 跑之前 updateBucket() 一次」）——
         每段都重采样的话，桶里的颜料会跟着笔尖来回跳，
         手感就是"颜色被带跑、越涂越脏"。 */
      if (segs.length) {
        if (eng && eng.id === 'smudge') {
          const last = segs[segs.length - 1][1];
          MTG.brushes.updateBucket(B.activeCtx(), last.x, last.y, Math.max(2, B.eff().size / 2));
        }
        for (const [a, b, pr] of segs) B.effectSeg(eng, a, b, pr);
      }
      if (direct) B.paint();                 // 直写图层的笔刷：已经画上去了，只需重绘合成
      else if (added) B.renderStroke();
      else B.paint();
    },
    up(e) {
      if (!B.drawing) return;
      B.drawing = false;
      try { B.cv.releasePointerCapture(e.pointerId); } catch (err) {}

      if (MTG.state.tool === 'lasso') {
        if (B.lassoing && B.sel) {
          B.lassoing = false;
          if (B.sel.path.length > 3) {
            B.liftSel();                                 // 成区 → 内容抬起为可移动的浮动层
            if (B.sel && B.sel.float) MTG.toast('选区已建立：可整块拖动 · 右侧「选区」可填充 / 删除 / 落回');
          } else B.sel = null;                           // 只是点一下，不成区
        }
        B.selDrag = null;
        B.paint();
        MTG.ui && MTG.ui.syncSel && MTG.ui.syncSel();
        return;
      }

      const eng = B.engine();
      const direct = eng && (eng.kind === 'dab' || eng.kind === 'overlay' || eng.kind === 'effect');
      if (eng && eng.kind === 'fill') {
        B.commitFill();                              // 柳叶笔：松手把轮廓填成实心
      } else if (B.points && B.points.length && !direct) {
        if (B.points.length === 1)                       // 单点轻触 → 一个带 taper 的小点
          B.points.push([B.points[0][0] + 0.01, B.points[0][1] + 0.01, B.points[0][2]]);
        B.commitStroke();
      } else if (eng && (eng.kind === 'dab' || eng.kind === 'overlay')) {
        B.commitDabStroke(eng);                          // 整笔一次性落图层
      }
      B.points = null; B.outline = null; B.strokeTool = null;
      B.pickup = null;
      B.shapeRect = null;
      B.endUndo();                                  // 撤销：把本笔脏区收进栈
      B.dirty = true;
      MTG.markDirty();
      B.paintNow();
    },

    /* 直线 / 矩形：每次移动先把上一帧画过的区域从备份抠回原状，再重画 ——
       等价于旧版的「整层 snapshot → putImageData」，但只碰实际画到的那个矩形。 */
    redrawShape(a, b, e) {
      const x = B.activeCtx();
      const r = B.shapeRect;
      if (r && B._undoCv) {
        const w = r[2] - r[0], h = r[3] - r[1];
        x.save();
        x.globalCompositeOperation = 'destination-out';
        x.fillStyle = '#000';
        x.fillRect(r[0], r[1], w, h);
        x.globalCompositeOperation = 'source-over';
        x.drawImage(B._undoCv, r[0], r[1], w, h, r[0], r[1], w, h);
        x.restore();
      }
      const pad = Math.ceil(B.widthOf()) + 4;
      const box = [
        Math.min(a.x, b.x) - pad, Math.min(a.y, b.y) - pad,
        Math.max(a.x, b.x) + pad, Math.max(a.y, b.y) + pad
      ];
      B.markUndo(box[0], box[1], box[2], box[3]);
      B.shapeRect = box;
      B.drawShape(a, b, e);
    },

    drawShape(a, b, e) {
      const st = MTG.state;
      const x = B.activeCtx();
      x.save();
      x.strokeStyle = st.color;
      x.fillStyle = st.color;
      x.globalAlpha = B.eff().opacity / 100;
      x.lineWidth = B.widthOf();
      x.lineCap = 'round';
      x.beginPath();
      if (st.tool === 'line') { x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke(); }
      else if (st.tool === 'rect') {
        x.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        x.stroke();
      }
      x.restore();
    },

    /* ══════════ 帧：预览跟随播放头 ══════════ */
    /* 镜头序列：分镜轨上的片段按「轨道顺序 → 入点」排序，**含空镜头（还没画面的）**。
       镜号 = 这个序列里的序号 —— 时间轴标签与分镜表视图共用同一编号，保证一致。 */
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
      if (B.xf) B.xfEnd();                       // 切帧时收掉没落位的变换
      B.sel = null; B.lassoing = false; B.selDrag = null;
      B.bgx.clearRect(0, 0, W, H);
      B.fgx.clearRect(0, 0, W, H);
      B.undoStack.length = 0; B.redoStack.length = 0;
      B._pend = null;
      B.dirty = false;
      B.paint();
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
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise(res => {
        img.onload = res;
        img.onerror = res;
        img.src = url;
      });
      if (tk !== B._token) { URL.revokeObjectURL(url); return; }
      if (!img.naturalWidth) {                       // 解码失败：不要往画布上画坏图
        URL.revokeObjectURL(url);
        MTG.toast('分镜帧无法解码：' + b.path, true);
        return;
      }
      B.bgx.clearRect(0, 0, W, H);
      B.fgx.clearRect(0, 0, W, H);
      B.fgx.drawImage(img, 0, 0, W, H);
      URL.revokeObjectURL(url);
      MTG.state.currentBoardId = id;
      B.dirty = false;
      B.undoStack.length = 0; B.redoStack.length = 0;
      B.paint();
      B.preloadOnion();                                          // 预热前后帧，洋葱皮即开即有
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
        B.refx.clearRect(0, 0, W, H);
        B.refx.drawImage(img, 0, 0, W, H);
        B.showRef = true;
        B.paint();
        MTG.ui && MTG.ui.syncRef && MTG.ui.syncRef();
        MTG.toast('已载入参考层（不写入分镜帧）');
      };
      img.onerror = () => { URL.revokeObjectURL(url); MTG.toast('参考图无法解码：' + asset.path, true); };
      img.src = url;
    },

    /* 导出帧：背景层 + 线稿层，透明底（纸色只在预览时垫在下面）。
       透明底是洋葱皮染色与重影可见的前提：染色只落在笔画轮廓上。 */
    toBlob() {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d');
      x.drawImage(B.bg, 0, 0);
      x.drawImage(B.fg, 0, 0);
      return new Promise(res => c.toBlob(res, 'image/png'));
    },

    async flush() {
      if (B.sel && B.sel.float) B.commitSel();      // 浮动选区内容先落回图层，再存盘
      // 画到一半被迫存盘（切帧 / 退出）：先把这一笔落下去，别丢
      if (B.drawing && B.strokeTool === 'brush') {
        const eng = B.engine();
        if (eng && (eng.kind === 'dab' || eng.kind === 'overlay')) B.commitDabStroke(eng);
      }
      if (!B.dirty || !MTG.state.currentBoardId) return;
      const b = MTG.findBoard(MTG.state.currentBoardId);
      if (!b) return;
      const blob = await B.toBlob();
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
      B.bgx.clearRect(0, 0, W, H);
      B.fgx.clearRect(0, 0, W, H);
      B.undoStack.length = 0; B.redoStack.length = 0;
      B.dirty = false;
      const blob = await MTG.storage.readBlob(b.path);
      if (blob) {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        await new Promise(r => { img.onload = r; img.onerror = r; img.src = url; });
        if (img.naturalWidth) B.fgx.drawImage(img, 0, 0, W, H);
        URL.revokeObjectURL(url);
      }
      B.paint();
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
      B.dirty = false;
    }
  });
})();
