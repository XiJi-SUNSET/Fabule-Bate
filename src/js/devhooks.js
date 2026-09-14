/* devhooks.js —— 开发 / 冒烟钩子（Electron 壳 main.js 的 --smoke-* 参数依赖面）
   ------------------------------------------------------------------
   这一层只做"转发 + 少量编排"，不含业务逻辑：
     __fabulaTest          引擎 ↔ 工程（IPC）跨层自检：建工程 → 导素材 →
                           引擎载图 → 合成指针画一笔 → 导出 PNG → writeShotImage 落盘
     __fabulaExport        fabula 工程模型（shots）的故事板导出：PNG dataURL / HTML
     __fabulaTheme         主题（light / dark / accent）
     __fabulaSetView       工作台切换（timeline / sheet / story）
     __fabulaTransport     播放（transport.js 的 MTG.audio）
     __fabulaSettingsPanel 设置面板（open / tab）
   浏览器环境（无 window.fabula）下除 Test / Export 外照常可用。 */
(function () {
  'use strict';
  const MTG = window.MTG;
  const $ = (id) => document.getElementById(id);

  /* ══════════ 视图 / 主题 / 设置面板 / 播放 ══════════ */
  window.__fabulaSetView = (v) => { MTG.ui.setView(v); return v; };

  window.__fabulaTheme = {
    set(mode) {
      const m = mode === 'light' ? 'light' : 'dark';
      MTG.settings.set('theme', m);
      MTG.settings.apply();
      return m;
    },
    mode() { return MTG.settings.get('theme'); },
    /* montage 没有主题色体系：保留接口（挂 data-accent，供将来 CSS 挂钩） */
    accent(name) { document.body.dataset.accent = String(name || ''); return name; },
  };

  window.__fabulaSettingsPanel = {
    open() { MTG.settings.open(); return true; },
    tab(name) {
      MTG.settings.open();
      if (name) { MTG.settings.ui.tab = name; MTG.settings.ui.render(); }
      return name || MTG.settings.ui.tab;
    },
  };

  window.__fabulaTransport = {
    play() { MTG.audio.play(); },
    pause() { MTG.audio.pause(); },
    stop() { MTG.audio.stop(); },
  };

  /* ══════════ 通用小工具 ══════════ */
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  async function desktopSnapshot() {
    if (!window.fabula) throw new Error('桌面钩子不可用（非 Electron 环境）');
    const cur = await window.fabula.project.current();
    if (!cur || !cur.root) throw new Error('未打开工程');
    return cur;
  }

  /* fabula://proj 取文件 → dataURL（经 blob 中转，与页面同源，画布不受污染） */
  async function fileDataUrl(rel) {
    const res = await fetch('fabula://proj/' + rel);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const rd = new FileReader();
      rd.onload = () => resolve(String(rd.result));
      rd.onerror = () => resolve(null);
      rd.readAsDataURL(blob);
    });
  }
  function loadImg(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }
  function wrapText(g, text, x, y, maxW, lineH, maxLines) {
    let line = '', n = 0;
    for (const ch of String(text)) {
      const t = line + ch;
      if (g.measureText(t).width > maxW && line) {
        g.fillText(line, x, y + n * lineH);
        if (++n >= maxLines) return;
        line = ch;
      } else line = t;
    }
    if (line) g.fillText(line, x, y + n * lineH);
  }
  function shotText(s) {
    const d = s.description || {};
    return [d.content, d.dialogue, d.notes].filter(Boolean).join('　');   // 备注在 description.notes（原 s.note 恒 undefined，L-18）
  }

  /* ══════════ 故事板导出（fabula 工程模型：shots） ══════════ */
  const STORY = { perRow: 4, cellW: 320, gap: 14, pad: 24, headH: 84, textH: 84 };

  async function buildStoryCanvas() {
    const cur = await desktopSnapshot();
    const p = cur.project, shots = p.shots || [];
    const dw = p.boardW || 1280, dh = p.boardH || 720;

    const cellH = Math.round(STORY.cellW * dh / dw);
    const rowCount = Math.max(1, Math.ceil(shots.length / STORY.perRow));
    const W = STORY.pad * 2 + STORY.perRow * STORY.cellW + (STORY.perRow - 1) * STORY.gap;
    const H = STORY.headH + STORY.pad + rowCount * (cellH + STORY.textH + STORY.gap);

    const cvs = document.createElement('canvas');
    cvs.width = W; cvs.height = H;
    const g = cvs.getContext('2d');
    if (!g) throw new Error('2d 上下文不可用');

    g.fillStyle = '#17161d'; g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#f5f0ea';
    g.font = '600 24px system-ui, "Microsoft YaHei", sans-serif';
    g.fillText(p.name || '故事板', STORY.pad, 40);
    g.fillStyle = '#8b8798';
    g.font = '400 13px system-ui, "Microsoft YaHei", sans-serif';
    g.fillText(shots.length + ' 镜 · ' + dw + '×' + dh + ' · ' + new Date().toLocaleString('zh-CN'), STORY.pad, 64);

    const imgs = await Promise.all(shots.map((s) => (s.image ? fileDataUrl(s.image).then(loadImg) : Promise.resolve(null))));

    for (let i = 0; i < shots.length; i++) {
      const cx = STORY.pad + (i % STORY.perRow) * (STORY.cellW + STORY.gap);
      const cy = STORY.headH + Math.floor(i / STORY.perRow) * (cellH + STORY.textH + STORY.gap);

      g.fillStyle = '#0d0c12'; g.fillRect(cx, cy, STORY.cellW, cellH);
      const img = imgs[i];
      if (img && img.width) {
        const k = Math.min(STORY.cellW / img.width, cellH / img.height);
        const w = Math.round(img.width * k), h = Math.round(img.height * k);
        g.drawImage(img, cx + ((STORY.cellW - w) >> 1), cy + ((cellH - h) >> 1), w, h);
      } else {
        g.fillStyle = '#4a4656';
        g.font = '400 13px system-ui, "Microsoft YaHei", sans-serif';
        g.textAlign = 'center';
        g.fillText('（空镜）', cx + STORY.cellW / 2, cy + cellH / 2 + 4);
        g.textAlign = 'left';
      }
      g.strokeStyle = '#2c2a36'; g.strokeRect(cx + 0.5, cy + 0.5, STORY.cellW - 1, cellH - 1);

      g.fillStyle = 'rgba(235,104,75,.92)'; g.fillRect(cx, cy, 30, 22);
      g.fillStyle = '#fff';
      g.font = '600 13px system-ui, sans-serif';
      g.fillText(String(i + 1), cx + 9, cy + 16);

      g.fillStyle = '#d7d3e0';
      g.font = '400 13px system-ui, "Microsoft YaHei", sans-serif';
      wrapText(g, shotText(shots[i]), cx, cy + cellH + 22, STORY.cellW, 18, 3);
    }
    return { cvs, cur, shots };
  }

  window.__fabulaExport = {
    async buildStoryPngDataUrl() {
      const { cvs } = await buildStoryCanvas();
      return cvs.toDataURL('image/png');
    },
    async buildStoryHtml() {
      const cur = await desktopSnapshot();
      const p = cur.project, shots = p.shots || [];
      const tiles = [];
      for (let i = 0; i < shots.length; i++) {
        const s = shots[i];
        const du = s.image ? await fileDataUrl(s.image) : null;
        tiles.push('<figure class="tile">'
          + (du ? '<img src="' + du + '" alt="">' : '<div class="ph">（空镜）</div>')
          + '<figcaption><b>' + (i + 1) + '</b>' + escapeHtml(shotText(s)) + '</figcaption></figure>');
      }
      return '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
        + '<title>' + escapeHtml(p.name || '故事板') + '</title>'
        + '<style>'
        + 'body{margin:0;padding:12mm;background:#fff;color:#16151c;font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif}'
        + 'h1{font-size:18px;margin:0 0 3mm}'
        + '.meta{color:#888;font-size:11px;margin:0 0 5mm}'
        + '.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:5mm}'
        + '.tile{margin:0;border:1px solid #ddd;border-radius:3px;overflow:hidden;page-break-inside:avoid}'
        + '.tile img{display:block;width:100%;background:#fff}'
        + '.tile .ph{height:38mm;display:flex;align-items:center;justify-content:center;color:#aaa}'
        + 'figcaption{padding:2mm;font-size:11px;color:#444}'
        + 'figcaption b{color:#d33}'
        + '</style></head><body>'
        + '<h1>' + escapeHtml(p.name || '故事板') + '</h1>'
        + '<p class="meta">' + shots.length + ' 镜 · ' + (p.boardW || 1280) + '×' + (p.boardH || 720) + '</p>'
        + '<div class="grid">' + tiles.join('') + '</div>'
        + '</body></html>';
    },
  };

  /* ══════════ __fabulaTest：引擎 ↔ 工程跨层自检 ══════════ */
  window.__fabulaTest = {
    /* 全链路：建/开工程 → 导素材 → 引擎载图 → 合成指针画一笔 → 导出 PNG → 落盘 shot 图 */
    async run(dirUrl, demoPng) {
      const out = { steps: [] };
      try {
        if (!window.fabula) throw new Error('非 Electron 环境：window.fabula 不存在');
        if (!dirUrl) throw new Error('缺少工程目录');

        /* 1. 建 / 开工程（冒烟目录通常为空：先 create；已有工程则回退 open） */
        let snap;
        try { snap = await window.fabula.project.create(dirUrl, '冒烟演示'); out.steps.push('create'); }
        catch (_) { snap = await window.fabula.project.openDir(dirUrl); out.steps.push('openDir'); }
        out.root = snap.root;

        /* 2. 导入演示参考图（复制进 assets/image/） */
        const imp = await window.fabula.assets.importPaths(demoPng ? [demoPng] : []);
        out.imported = imp.added;
        const asset = (imp.project.assets || [])[imp.project.assets.length - 1];
        if (!asset) throw new Error('素材导入失败：assets 为空');
        out.asset = asset.path;

        /* 3. 引擎载入参考图（fg 线稿层，与 board.js 帧加载同款调用） */
        const engine = window.__fabulaEngine;
        if (!engine) throw new Error('绘画引擎未加载（__fabulaEngine 缺失）');
        const blob = await (await fetch('fabula://proj/' + asset.path)).blob();
        await engine.loadImage(blob, { layer: 'fg', mode: 'stretch', clearUndo: true, fit: false });
        out.steps.push('loadImage');

        /* 4. 解除"未落帧不吃笔"（冒烟没有 montage 帧；直接放行，结束时恢复） */
        MTG.board.setIdle(false);

        /* 5. 合成指针事件画一笔（走真实笔刷管线：pointerdown → move → up） */
        engine.setTool('pen');
        engine.setColor('#d81e2e');
        const ov = $('ov'), r = ov.getBoundingClientRect();
        const x0 = r.left + r.width * 0.16, y0 = r.top + r.height * 0.74;
        const x1 = r.left + r.width * 0.84, y1 = r.top + r.height * 0.28;
        const pev = (type, x, y) => ov.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true,
          pointerId: 7, pointerType: 'mouse', isPrimary: true,
          button: 0, buttons: type === 'pointerup' ? 0 : 1,
          pressure: type === 'pointerup' ? 0 : 0.75,
          clientX: x, clientY: y,
        }));
        pev('pointerdown', x0, y0);
        const N = 24;
        for (let i = 1; i <= N; i++) pev('pointermove', x0 + (x1 - x0) * i / N, y0 + (y1 - y0) * i / N);
        pev('pointerup', x1, y1);
        engine.commitStroke();
        out.stroke = { canUndo: engine.canUndo() };
        if (!out.stroke.canUndo) throw new Error('笔画未入撤销栈（未落墨？）');
        out.steps.push('stroke');

        /* 6. 导出帧图 → writeShotImage 落盘（shots/sh_*.png），fabula 工程模型收编 */
        const dataUrl = engine.exportDataURL();
        if (!/^data:image\/png/.test(dataUrl || '')) throw new Error('导出失败：非 PNG dataURL');
        const shotId = 'sh_' + (Date.now() & 0xffffffff).toString(16).padStart(8, '0').slice(-8);
        const after = await window.fabula.project.writeShotImage(shotId, dataUrl);
        out.shot = shotId;
        out.shots = (after.project.shots || []).map((s) => s.id + ':' + (s.image || '-'));
        out.steps.push('writeShotImage');
      } catch (e) {
        out.error = (e && e.message) || String(e);
      } finally {
        try { MTG.board.setIdle(true); } catch (_) {}
      }
      return JSON.stringify(out);
    },

    /* 涂抹自检：先 pen 画一条竖线，再 smudge 横向涂抹一笔。
       验证：两笔都入撤销栈（步深 +2）、工具正确切换、不抛错。
       并采样涂抹前/后同一行像素（RGBA），用于判读拖拽是否连续无分层。 */
    async smudge() {
      const out = { steps: [] };
      try {
        MTG.board.setIdle(false);
        const engine = window.__fabulaEngine;
        const ov = $('ov'), r = ov.getBoundingClientRect();
        const pev = (type, x, y, opts) => ov.dispatchEvent(new PointerEvent(type, Object.assign({
          bubbles: true, cancelable: true, composed: true,
          pointerId: 7, pointerType: 'mouse', isPrimary: true,
          button: 0, buttons: type === 'pointerup' ? 0 : 1, pressure: 0.75,
          clientX: x, clientY: y,
        }, opts || {})));
        const undoCount = () => (window.__paintlab && window.__paintlab.stats ? window.__paintlab.stats.undo : -1);
        const toDoc = (cx, cy) => {
          const view = engine.getView();
          const glc = $('gl'), gr = glc.getBoundingClientRect();
          const k = glc.width / gr.width;
          return {
            x: ((cx - gr.left) * k - view.x) / view.scale,
            y: ((cy - gr.top) * k - view.y) / view.scale,
            k, scale: view.scale,
          };
        };
        /* 读文档坐标下某一行像素的 alpha（n 点采样），用于判读拖拽条的连续性 */
        const readRowAlpha = (clientY, cx0, cx1, n) => {
          const a = toDoc(cx0, clientY), b = toDoc(cx1, clientY);
          const res = window.__paintlab.readAlpha(a.x, a.y, b.x - a.x, 1);
          const arr = [];
          for (let i = 0; i < n; i++) {
            const p = Math.round(i * (res.w - 1) / (n - 1)) * 4;
            arr.push(res.raw[p + 3]);
          }
          return arr;
        };
        /* 同一路径上读一列（判断"层"是否沿垂直方向出现） */
        const readColAlpha = (clientX, cy0, cy1, n) => {
          const a = toDoc(clientX, cy0), b = toDoc(clientX, cy1);
          const res = window.__paintlab.readAlpha(a.x, a.y, 1, b.y - a.y);
          const arr = [];
          for (let i = 0; i < n; i++) {
            const p = Math.round(i * (res.h - 1) / (n - 1)) * res.w * 4;
            arr.push(res.raw[p + 3]);
          }
          return arr;
        };
        /* 1. pen 竖线（过画面中心，给涂抹留素材） */
        engine.setTool('pen');
        const xm = r.left + r.width * 0.5;
        const ya = r.top + r.height * 0.2, yb = r.top + r.height * 0.8;
        pev('pointerdown', xm, ya);
        for (let i = 1; i <= 12; i++) pev('pointermove', xm, ya + (yb - ya) * i / 12);
        pev('pointerup', xm, yb);
        engine.commitStroke();
        out.line = engine.canUndo();
        out.lineUndo = undoCount();
        out.steps.push('line');
        const xa = r.left + r.width * 0.3, xb = r.left + r.width * 0.7, ym = r.top + r.height * 0.5;
        const sx0 = r.left + r.width * 0.40, sx1 = r.left + r.width * 0.60;
        out.before = readRowAlpha(ym, sx0, sx1, 96);
        out.colBefore = readColAlpha(r.left + r.width * 0.52, r.top + r.height * 0.38, r.top + r.height * 0.62, 96);
        /* 2. smudge 横涂（穿过竖线中点） */
        engine.setTool('smudge');
        pev('pointerdown', xa, ym);
        for (let i = 1; i <= 24; i++) pev('pointermove', xa + (xb - xa) * i / 24, ym);
        pev('pointerup', xb, ym);
        engine.commitStroke();
        out.smudgeUndo = undoCount();
        out.smudgeAdded = out.smudgeUndo > out.lineUndo;
        out.tool = engine.tool();
        out.steps.push('smudge');
        out.after = readRowAlpha(ym, sx0, sx1, 96);
        out.colAfter = readColAlpha(r.left + r.width * 0.52, r.top + r.height * 0.38, r.top + r.height * 0.62, 96);
      } catch (e) { out.error = (e && e.message) || String(e); }
      finally { try { MTG.board.setIdle(true); } catch (_) {} }
      return JSON.stringify(out);
    },

    /* 主功能自检：画笔/涂抹的撤销重做、清层撤销（像素级验证） */
    async audit() {
      const out = {};
      try {
        MTG.board.setIdle(false);
        const engine = window.__fabulaEngine;
        const lab = window.__paintlab;
        const ov = $('ov'), r = ov.getBoundingClientRect();
        const pev = (type, x, y) => ov.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true,
          pointerId: 7, pointerType: 'mouse', isPrimary: true,
          button: 0, buttons: type === 'pointerup' ? 0 : 1, pressure: 0.75,
          clientX: x, clientY: y,
        }));
        const stroke = (x0, y0, x1, y1, n) => {
          pev('pointerdown', x0, y0);
          for (let i = 1; i <= (n || 12); i++) pev('pointermove', x0 + (x1 - x0) * i / (n || 12), y0 + (y1 - y0) * i / (n || 12));
          pev('pointerup', x1, y1);
          engine.commitStroke();
        };
        /* 客户端坐标 → 单点 alpha（读当前层 paintCur） */
        const pt = (clientX, clientY) => {
          const view = engine.getView();
          const glc = $('gl'), gr = glc.getBoundingClientRect();
          const k = glc.width / gr.width;
          const dx = ((clientX - gr.left) * k - view.x) / view.scale;
          const dy = ((clientY - gr.top) * k - view.y) / view.scale;
          const res = lab.readAlpha(dx, dy, 1, 1);
          return res.raw[3];
        };
        /* ── 1. 画笔：画→撤→重 ── */
        engine.setTool('pen'); engine.setColor('#d81e2e');
        const px = r.left + r.width * 0.30, py = r.top + r.height * 0.30;
        const qx = r.left + r.width * 0.50;
        const a0 = pt(qx, py);
        stroke(px, py, qx, py);
        const a1 = pt(qx, py);
        engine.undo();
        const a2 = pt(qx, py);
        const st1 = window.__paintlab.stats;
        out.afterUndo = st1.undo + '/' + st1.redo;
        engine.redo();
        const a3 = pt(qx, py);
        const st2 = window.__paintlab.stats;
        out.afterRedo = st2.undo + '/' + st2.redo;
        engine.undo();
        const a4 = pt(qx, py);
        engine.redo();
        const a5 = pt(qx, py);
        out.pen = { a0, a1, a2, a3, a4, a5, drawOK: a1 > 60, undoOK: a2 <= 8, redoOK: a3 > 60, redo2OK: a5 > 60 };
        /* ── 2. 涂抹：竖线→横涂→撤→重（取竖线中点） ── */
        engine.setTool('pen');
        const xm = r.left + r.width * 0.72, ya = r.top + r.height * 0.25, yb = r.top + r.height * 0.75;
        stroke(xm, ya, xm, yb, 16);
        const ym = r.top + r.height * 0.5;
        const s0 = pt(xm, ym);
        engine.setTool('smudge');
        stroke(r.left + r.width * 0.62, ym, r.left + r.width * 0.82, ym, 20);
        const s1 = pt(xm, ym);
        engine.undo();
        const s2 = pt(xm, ym);
        engine.redo();
        const s3 = pt(xm, ym);
        out.smudge = {
          s0, s1, s2, s3,
          changed: Math.abs(s1 - s0) > 4,
          undoRestores: Math.abs(s2 - s0) <= 6,
          redoReapplies: Math.abs(s3 - s1) <= 6,
        };
        /* ── 3. 清层 + 撤销（先补一笔确保有内容） ── */
        engine.setTool('pen');
        const cpy = r.top + r.height * 0.70;
        stroke(px, cpy, qx, cpy);
        const c0 = pt(qx, cpy);
        engine.clear('fg');
        const c1 = pt(qx, cpy);
        engine.undo();
        const c2 = pt(qx, cpy);
        out.clear = { c0, c1, c2, cleared: c0 > 60 && c1 <= 4, undoRestores: Math.abs(c2 - c0) <= 6 };
        out.undoDepth = window.__paintlab.stats.undo;
      } catch (e) { out.error = (e && e.message) || String(e); }
      finally { try { MTG.board.setIdle(true); } catch (_) {} }
      return JSON.stringify(out);
    },

    /* 桌面存储后端自检：create → electron 模式 → 写/读/列/删 全链路 */
    async storage(dirUrl) {
      const out = { steps: [] };
      try {
        if (!window.fabula) throw new Error('非 Electron 环境');
        if (!dirUrl) throw new Error('缺少目录');
        const snap = await window.fabula.project.create(dirUrl, '存储自检');
        out.root = snap.root;
        MTG.storage.mode = 'electron';
        MTG.storage.dirName = snap.root.split(/[\\/]/).filter(Boolean).pop() || '';
        out.ready = MTG.storage.ready;
        out.steps.push('create');
        await MTG.storage.writeFile('assets/image/st.png', new Blob(['store-ok'], { type: 'image/png' }));
        out.steps.push('writeFile');
        const blob = await MTG.storage.readBlob('assets/image/st.png');
        out.read = blob ? await blob.text() : null;
        out.steps.push('readBlob');
        const list = await MTG.storage.listMedia();
        out.listed = list.map((f) => f.path + ':' + f.kind);
        out.steps.push('listMedia');
        out.deleted = await MTG.storage.deleteFile('assets/image/st.png');
        out.steps.push('deleteFile');
        const again = await MTG.storage.readBlob('assets/image/st.png');
        out.goneAfterDelete = again === null;
      } catch (e) {
        out.error = (e && e.message) || String(e);
      }
      return JSON.stringify(out);
    },

    /* 压力管线探针（压感回归自检；对照 paint.js 的 shapePressure / 起笔门槛注释）：
       ① 起笔首帧忠实映射（无中性垫托）→ 零读数即 ≈0、不制造圆点；
          真实压力到达后平滑链追到 > 0.4；
       ② 真实极轻接触（raw 0.015 < 死区）→ 必须立即落笔（修复前被门槛吞掉）；
       ③ 正常压感 → 忠实映射（0.7 明显大于 0.2）；
       ④ 极轻零压起笔一笔 → 不得被判"无压感"（pressureSeen !== false）；
       ⑤ 极轻起笔后段用力 → 该笔跟随真实压力（> 0.4，而非速度驱动的 ~0.24）。
       仅测试/冒烟用。 */
    async penProbe() {
      const out = {};
      const ov = $('ov');
      const r = ov.getBoundingClientRect();
      const pev = (type, x, y, pressure) => ov.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId: 9, pointerType: 'pen', isPrimary: true,
        button: 0, buttons: type === 'pointerup' ? 0 : 1,
        pressure, clientX: x, clientY: y,
      }));
      const stroke = (x0, y0, press, n) => {
        pev('pointerdown', x0, y0, press);
        for (let i = 1; i <= n; i++) pev('pointermove', x0 + i * 4, y0, press);
        pev('pointerup', x0 + n * 4, y0, press);
      };
      const E = window.__fabulaEngine;
      const lab = window.__paintlab;
      /* 状态备份（R3 B-4）：探针会清层并画多笔，结束后恢复画布内容与原工具 */
      let snap = null, bakTool = null;
      try { snap = E.exportDataURL(); } catch (_) {}
      try { bakTool = E.tool(); } catch (_) {}
      try {
        MTG.board.setIdle(false);
        E.setTool('pen');
        /* ① 起笔首帧忠实映射（对齐旧版）：零读数起笔不得有"中性垫托"圆点
              （垫托会让首个 dab 比后续极轻段粗）；真实压力到达后应平滑追上。 */
        MTG.board.clearLayer('fg');
        const x = r.left + r.width * 0.25, y = r.top + r.height * 0.3;
        pev('pointerdown', x, y, 0);
        pev('pointermove', x + 8, y, 0);          // 位移 8 < 12：仍在门槛等待
        pev('pointermove', x + 18, y, 0);         // 位移 18：自愈放行，本帧即笔画首帧
        out.firstFrameMissingP = +E.PEN.lastShapeP.toFixed(3);
        out.firstFrameOK = E.PEN.lastShapeP <= 0.02;        // 忠实：无读数即 0（无圆点垫托）
        for (let i = 1; i <= 6; i++) pev('pointermove', x + 18 + i * 4, y, 0.5);   // 真实压力到达
        out.recoverP = +E.PEN.lastShapeP.toFixed(3);
        out.recoverOK = E.PEN.lastShapeP > 0.4;             // 平滑链快速追上真实压力
        pev('pointerup', x + 46, y, 0.5);
        /* ① 的恒 0 输入会让引擎按设计判"无压感"（自愈）——后续压感断言前重置判定，
           否则 ②③ 全走速度驱动，测不到压力映射 */
        E.PEN.pressureSeen = null;
        /* ② 极轻接触（0.015）：必须落笔进撤销栈 */
        const u0 = lab.stats.undo;
        stroke(r.left + r.width * 0.4, r.top + r.height * 0.5, 0.015, 3);
        out.lightStrokeOK = lab.stats.undo > u0;            // 修复前 false（被门槛吞）
        /* ③ 压感忠实映射（采样 8 点：起笔斜坡 4 帧放完后读末值） */
        stroke(r.left + r.width * 0.55, r.top + r.height * 0.5, 0.2, 8);
        out.mapLow = +E.PEN.lastShapeP.toFixed(3);
        stroke(r.left + r.width * 0.7, r.top + r.height * 0.5, 0.7, 8);
        out.mapHigh = +E.PEN.lastShapeP.toFixed(3);
        out.faithfulOK = out.mapHigh > out.mapLow + 0.15;
        /* ④ 极轻零压起笔一笔（>12 点）：不得被判"无压感"
              （修复前：pending 自愈当笔置 false → 这一笔直接变鼠标模式） */
        E.PEN.pressureSeen = null;
        E.PEN.zeroStrokes = 0;
        stroke(r.left + r.width * 0.85, r.top + r.height * 0.3, 0, 18);
        out.zeroStrokeSeen = E.PEN.pressureSeen;
        out.zeroStrokeOK = E.PEN.pressureSeen !== false;
        /* ⑤ 极轻起笔（0）→ 中段用力（0.6）：后段必须跟随真实压力，不是速度驱动 */
        E.PEN.pressureSeen = null;
        const x5 = r.left + r.width * 0.35, y5 = r.top + r.height * 0.72;
        pev('pointerdown', x5, y5, 0);
        for (let i = 1; i <= 6; i++) pev('pointermove', x5 + i * 4, y5, 0);        // 极轻段（触发自愈放行）
        for (let i = 7; i <= 12; i++) pev('pointermove', x5 + i * 4, y5, 0.6);     // 中段用力
        out.midStrokeP = +E.PEN.lastShapeP.toFixed(3);
        out.midStrokeOK = E.PEN.lastShapeP > 0.4;                                   // 修复前 ≈0.24（鼠标模式）
        pev('pointerup', x5 + 52, y5, 0.6);
        out.pressureSeen = E.PEN.pressureSeen;
      } catch (e) {
        out.error = (e && e.message) || String(e);
      } finally {
        try { MTG.board.setIdle(true); } catch (_) {}
        if (bakTool) { try { E.setTool(bakTool); } catch (_) {} }
        if (snap) {
          /* 恢复探针前的画布内容（含撤销栈复位到干净态）：会话状态不留污染 */
          try {
            const blob = await (await fetch(snap)).blob();
            await E.loadImage(blob, { layer: 'fg', mode: 'stretch', clearUndo: true, fit: false });
          } catch (_) {}
        }
      }
      return JSON.stringify(out);
    },

    /* 时间轴同轨拖拽换位探针：合成指针事件把第 1 个片段拖过第 2 个的中点，
       看片段顺序是否真的重排（验证"时间轴能不能拖拽排序"的现场事实）。 */
    tlDragProbe() {
      const out = {};
      /* 状态备份（R3 B-4）：探针造的片段/轨道/选中集/伪工程在 finally 还原 */
      const bak = {
        proj: MTG.state.project,
        sel: MTG.state.selectedClipIds,
        clips: null, tracksLen: 0,
      };
      if (bak.proj) {
        bak.clips = bak.proj.clips.map(c => ({ ref: c, start: c.start, dur: c.dur, trackId: c.trackId }));
        bak.tracksLen = bak.proj.tracks.length;
      }
      try {
        let p = MTG.state.project;
        if (!p) {
          p = MTG.state.project = {
            name: 'tl-probe', boardW: 1280, boardH: 720, fps: 12,
            tracks: [], clips: [], assets: [], boards: [], tagOptions: {}
          };
        }
        /* 确保存在一条含 ≥2 片段的轨道（冒烟环境工程常为空） */
        const seeded = p.tracks.some(tr => p.clips.filter(c => c.trackId === tr.id).length >= 2);
        if (!seeded) {
          if (!p.tracks.length) p.tracks.push({ id: 'tr-v', kind: 'board', name: '画面' });
          const tid = p.tracks[0].id;
          p.clips.push(
            { id: 'cl-a', trackId: tid, kind: 'board', boardId: null, name: 'A', start: 0, dur: 2, offset: 0, meta: {} },
            { id: 'cl-b', trackId: tid, kind: 'board', boardId: null, name: 'B', start: 2, dur: 2, offset: 0, meta: {} },
            { id: 'cl-c', trackId: tid, kind: 'board', boardId: null, name: 'C', start: 4, dur: 2, offset: 0, meta: {} }
          );
          MTG.state.selectedClipIds = new Set();
          MTG.timeline.render();
        }
        let trackId = null, list = null;
        for (const tr of p.tracks) {
          const l = p.clips.filter(c => c.trackId === tr.id).sort((a, b) => a.start - b.start);
          if (l.length >= 2) { trackId = tr.id; list = l; break; }
        }
        if (!list) { out.error = '没有含 ≥2 个片段的轨道'; return JSON.stringify(out); }

        const c1 = list[0], c2 = list[1];
        out.before = list.map(c => c.id).join(',');
        const el = MTG.timeline.el.tracks.querySelector('.clip[data-id="' + c1.id + '"]');
        if (!el) { out.error = 'clip 元素缺失'; return JSON.stringify(out); }

        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 99, pointerType: 'mouse',
          button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y
        }));
        fire('pointerdown', cx, cy);
        /* 拖到"越过 c2 中点"所需的像素：两中点距离 + 余量 */
        const need = ((c2.start + c2.dur / 2) - (c1.start + c1.dur / 2)) * MTG.state.pxPerSec + 30;
        for (let k = 1; k <= 6; k++) fire('pointermove', cx + need * k / 6, cy);
        fire('pointerup', cx + need, cy);

        const after = p.clips.filter(c => c.trackId === trackId).sort((a, b) => a.start - b.start).map(c => c.id).join(',');
        out.after = after;
        out.reordered = out.before !== out.after;
        out.c1Start = +c1.start.toFixed(2);
        out.pxPerSec = MTG.state.pxPerSec;
      } catch (e) {
        out.error = (e && e.message) || String(e);
      } finally {
        const p2 = MTG.state.project;
        if (!bak.proj) {
          MTG.state.project = null;                    // 原本无工程：连伪工程一起还原
        } else if (p2 && bak.clips) {
          for (const b of bak.clips) {                 // 元素级还原（引用不变，UI 侧一致）
            b.ref.start = b.start; b.ref.dur = b.dur; b.ref.trackId = b.trackId;
          }
          p2.clips.length = 0;
          for (const b of bak.clips) p2.clips.push(b.ref);   // 丢掉探针新加的片段
          if (Array.isArray(p2.tracks)) p2.tracks.length = bak.tracksLen;
          MTG.state.selectedClipIds = bak.sel;
        }
        try { MTG.timeline.render(); } catch (_) {}
      }
      return JSON.stringify(out);
    },

    /* 轮盘右键探针：radialRight 开启时，笔右键应呼出轮盘且不启动抓手（视图不动） */
    radialProbe() {
      const out = {};
      /* 状态备份（R3 B-4）：radialRight / currentBoardId / 伪工程与伪 board 在 finally 还原 */
      const bak = {
        proj: MTG.state.project,
        board: MTG.state.currentBoardId,
        radialRight: MTG.settings.get('radialRight'),
        pushedBoard: false,
      };
      try {
        MTG.settings.set('radialRight', true);
        /* 冒烟环境常无当前画板：造最小场景（轮盘呼出要求有画板） */
        if (!MTG.state.currentBoardId) {
          const p = MTG.state.project || (MTG.state.project = {
            name: 'radial-probe', boardW: 1280, boardH: 720, fps: 12,
            tracks: [], clips: [], assets: [], boards: [], tagOptions: {}
          });
          if (!Array.isArray(p.boards)) p.boards = [];
          p.boards.push({ id: 'bd-radial', path: 'boards/radial-probe.png', w: 1280, h: 720 });
          bak.pushedBoard = true;
          MTG.state.currentBoardId = 'bd-radial';
        }
        const ov = document.getElementById('ov');
        const r = ov.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const v0 = window.__fabulaEngine.getView();
        const fire = (type, x, y) => ov.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', isPrimary: true,
          button: 2, buttons: type === 'pointerup' ? 0 : 2, clientX: x, clientY: y
        }));
        fire('pointerdown', cx, cy);
        out.hasBoard = !!MTG.state.currentBoardId;
        out.radialOpen = MTG.radial.open;
        for (let k = 1; k <= 4; k++) fire('pointermove', cx + k * 12, cy);
        fire('pointerup', cx + 48, cy);
        const v1 = window.__fabulaEngine.getView();
        out.viewMoved = Math.abs(v1.x - v0.x) + Math.abs(v1.y - v0.y) > 0.5;
        out.radialOpenOK = out.radialOpen === true || !out.hasBoard;   // 无画板时轮盘本就不呼出
        out.panOK = out.viewMoved === false;                           // 抓手不得连带启动
      } catch (e) { out.error = (e && e.message) || String(e); }
      finally {
        /* 还原（R3 B-4）：伪 board 从原工程里移除；project / currentBoardId / 设置回原值 */
        if (bak.pushedBoard && bak.proj && Array.isArray(bak.proj.boards)) {
          const i = bak.proj.boards.findIndex(b => b.id === 'bd-radial');
          if (i >= 0) bak.proj.boards.splice(i, 1);
        }
        MTG.state.project = bak.proj;
        MTG.state.currentBoardId = bak.board;
        try { MTG.settings.set('radialRight', bak.radialRight); } catch (_) {}
      }
      return JSON.stringify(out);
    },

    /* 自写抑制探针（诊断"播放/保存被误报外部更新"）：
       以与 board.flush 相同的路径写一次当前帧图 → 等 watch 去抖 →
       读渲染端收到的最近一次广播。期望：files 为空（自写被吞，无外部误报）。 */
    async mediaSuppressProbe() {
      const out = {};
      try {
        /* 冒烟环境常无当前帧：造最小场景（写帧图路径需要 board 记录） */
        if (!MTG.state.currentBoardId) {
          const p = MTG.state.project || (MTG.state.project = {
            name: 'suppress-probe', boardW: 1280, boardH: 720, fps: 12,
            tracks: [], clips: [], assets: [], boards: [], tagOptions: {}
          });
          if (!Array.isArray(p.boards)) p.boards = [];
          if (!p.boards.some(x => x.id === 'bd-suppress')) {
            p.boards.push({ id: 'bd-suppress', path: 'boards/suppress-probe.png', w: 1280, h: 720 });
          }
          MTG.state.currentBoardId = 'bd-suppress';
        }
        if (!window.fabula || !window.fabula.project) { out.error = '非桌面环境'; return JSON.stringify(out); }
        const b = MTG.state.currentBoardId ? MTG.findBoard(MTG.state.currentBoardId) : null;
        if (!b) { out.error = '无当前帧'; return JSON.stringify(out); }
        window.__lastChangedInfo = null;
        const blob = await MTG.board.toBlob();
        if (!blob) { out.error = 'toBlob 失败'; return JSON.stringify(out); }
        /* 直调 preload 桥（与 storage.writeFile 的 electron 分支等价）：走主进程
           project:writeFile → markSelfMedia 登记 → watch 抑制，全链路一致 */
        await window.fabula.project.writeFile(b.path, new Uint8Array(await blob.arrayBuffer()));
        out.wrote = b.path;
        await new Promise(r => setTimeout(r, 1500));
        out.info = window.__lastChangedInfo;
        out.suppressed = !(out.info && out.info.files && out.info.files.length);
      } catch (e) { out.error = (e && e.message) || String(e); }
      return JSON.stringify(out);
    },

    /* 状态快照：引擎 / 画板 / 工程 / 错误层 四面 */
    async status() {
      const out = { engine: null, board: null, project: null, err: '' };
      const engine = window.__fabulaEngine;
      if (engine) {
        const v = engine.getView ? engine.getView() : null;
        const st = window.__paintlab ? window.__paintlab.stats : null;
        out.engine = {
          tool: engine.tool(),
          doc: engine.docSize(),
          canUndo: engine.canUndo(),
          canRedo: engine.canRedo(),
          hasBackdrop: engine.hasBackdrop ? engine.hasBackdrop() : null,
          view: v ? { scale: +(+v.scale).toFixed(3), x: Math.round(v.x), y: Math.round(v.y) } : null,
          stroke: st ? { dabs: st.dabs, points: st.points, undo: st.undo } : null,
        };
      }
      if (MTG && MTG.board) {
        out.board = {
          idle: !!MTG.board._idle,
          dirty: !!MTG.board.dirty,
          cur: (MTG.state && MTG.state.currentBoardId) || null,
          tool: (MTG.state && MTG.state.tool) || null,
        };
      }
      if (window.fabula) {
        try {
          const cur = await window.fabula.project.current();
          out.project = {
            root: cur.root,
            name: cur.project.name,
            shots: (cur.project.shots || []).length,
            assets: (cur.project.assets || []).length,
          };
        } catch (e) { out.project = { error: e.message }; }
      }
      const errEl = $('err');
      if (errEl && errEl.style.display && errEl.style.display !== 'none') {
        out.err = String(errEl.textContent || '').slice(0, 300);
      }
      return JSON.stringify(out);
    },
  };
})();
