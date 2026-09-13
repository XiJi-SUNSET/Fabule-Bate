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
    return [d.content, d.dialogue, s.note].filter(Boolean).join('　');
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
