/* picker.js · 三角形拾色器（外圈色相环 + 内接 HSV 三角）
   三角三顶点：顶=白(S0,V1) / 右下=纯色相(S1,V1) / 左下=黑(V0)
   任意点用重心坐标 (u,v,w) 反解：V = 1-w_black，S = w_hue / V
   纯 Canvas 实现，无依赖；支持 Pointer 拖拽（鼠标 / 触屏 / 数位板通用）。 */
(function () {
  'use strict';
  const MTG = window.MTG;
  const U = MTG.util;

  const P = (MTG.picker = {
    cv: null, ctx: null, size: 190, dpr: 1,
    ring: null, tri: null,          // 离屏：静态色相环 / 随色相重绘的三角
    geo: null,
    dragging: null,                 // 'ring' | 'tri'
    onChange: null,

    init(canvas) {
      P.cv = canvas;
      P.dpr = Math.min(window.devicePixelRatio || 1, 2);
      P.size = 190;
      canvas.width = P.size * P.dpr;
      canvas.height = P.size * P.dpr;
      canvas.style.width = P.size + 'px';
      canvas.style.height = P.size + 'px';
      P.ctx = canvas.getContext('2d');
      P.ctx.scale(P.dpr, P.dpr);

      const c = P.size / 2;
      P.geo = {
        cx: c, cy: c,
        rOut: c - 2, rIn: c - 20,
        R: c - 26                       // 三角外接圆半径
      };
      const g = P.geo;
      P.verts = {
        A: { x: c, y: c - g.R },                                     // 白
        B: { x: c + g.R * Math.cos(Math.PI / 6), y: c + g.R * Math.sin(Math.PI / 6) },  // 纯色
        C: { x: c - g.R * Math.cos(Math.PI / 6), y: c + g.R * Math.sin(Math.PI / 6) }   // 黑
      };

      P.ring = makeOff(P.size);
      P.tri = makeOff(P.size);
      P.drawRing();
      P.drawTriangle();
      P.paint();

      canvas.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;               // 右键 / 中键不拖色环（L-25）
        canvas.setPointerCapture(e.pointerId);
        P.dragging = P.hitTest(e);                // hitTest 已含内环/三角判定（原来的 || 分支是死代码，L-25）
        P.handle(e);
      });
      canvas.addEventListener('pointermove', e => { if (P.dragging) P.handle(e); });
      const end = e => {
        P.dragging = null;
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
        P.pushSwatch(MTG.state.color);        // 一次取色结束才记入最近色板（N-B3）
      };
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointercancel', end);
    },

    /* ── 命中与交互 ── */
    pos(e) {
      const r = P.cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    },
    dist(e) {
      const p = P.pos(e), g = P.geo;
      return Math.hypot(p.x - g.cx, p.y - g.cy);
    },
    hitTest(e) {
      const d = P.dist(e), g = P.geo;
      if (d > g.rIn) return 'ring';
      return inTriangle(P.pos(e), P.verts) ? 'tri' : 'ring';
    },
    handle(e) {
      const p = P.pos(e), g = P.geo, st = MTG.state;
      if (P.dragging === 'ring') {
        let deg = Math.atan2(p.y - g.cy, p.x - g.cx) * 180 / Math.PI;
        st.hsv.h = Math.round(((deg + 90) % 360 + 360) % 360);
        /* M-9：色相环拖动每帧都要重画全量三角（逐像素 190²）—— rAF 合帧，
           一帧内多次 pointermove 只重绘一次；三角拖动路径本身轻（一次 paint） */
        P.drawSoon();
      } else {
        const w = bary(p, P.verts);
        const V = U.clamp(1 - w.c, 0, 1);              // c = 黑顶点权重
        const S = V > 0 ? U.clamp(w.b / V, 0, 1) : 0;  // b = 纯色顶点权重
        st.hsv.s = Math.round(S * 100);
        st.hsv.v = Math.round(V * 100);
        st.color = U.hsv2hex(st.hsv.h, st.hsv.s, st.hsv.v);
        P.paint();
      }
      st.color = U.hsv2hex(st.hsv.h, st.hsv.s, st.hsv.v);
      P.onChange && P.onChange(st.color);
    },

    /* 三角重绘 + 合成：rAF 合帧版（M-9） */
    drawSoon() {
      if (P._rafDraw) return;
      P._rafDraw = requestAnimationFrame(() => {
        P._rafDraw = 0;
        P.drawTriangle();
        P.paint();
      });
    },

    /* ── 绘制 ── */
    paint() {
      const ctx = P.ctx, g = P.geo, st = MTG.state;
      ctx.clearRect(0, 0, P.size, P.size);
      ctx.drawImage(P.ring, 0, 0, P.size, P.size);
      ctx.drawImage(P.tri, 0, 0, P.size, P.size);

      // 色相环游标
      const a = (st.hsv.h - 90) * Math.PI / 180;
      const rr = (g.rOut + g.rIn) / 2;
      marker(ctx, g.cx + rr * Math.cos(a), g.cy + rr * Math.sin(a), '#fff');
      // 三角游标
      const pt = P.pointOf(st.hsv.s, st.hsv.v);
      marker(ctx, pt.x, pt.y, st.hsv.v > 55 ? '#20201e' : '#fff');
    },

    /* S/V → 三角内坐标（重心坐标插值） */
    pointOf(s, v) {
      const V = U.clamp(v / 100, 0, 1), S = U.clamp(s / 100, 0, 1);
      const wA = V * (1 - S), wB = V * S, wC = 1 - V;   // 白 / 纯色 / 黑
      const t = P.verts;
      return {
        x: t.A.x * wA + t.B.x * wB + t.C.x * wC,
        y: t.A.y * wA + t.B.y * wB + t.C.y * wC
      };
    },

    drawRing() {
      const ctx = P.ring.getContext('2d'), g = P.geo;
      ctx.clearRect(0, 0, P.size, P.size);
      const step = 1.2;
      for (let h = 0; h < 360; h += step) {
        const a0 = (h - 90 - step / 2) * Math.PI / 180;
        const a1 = (h - 90 + step / 2) * Math.PI / 180;
        ctx.beginPath();
        ctx.arc(g.cx, g.cy, g.rOut, a0, a1);
        ctx.arc(g.cx, g.cy, g.rIn, a1, a0, true);
        ctx.closePath();
        ctx.fillStyle = U.hsv2hex(h, 100, 100);
        ctx.fill();
      }
      // 内圈柔光，弱化锯齿
      ctx.globalCompositeOperation = 'destination-in';
      ctx.beginPath();
      ctx.arc(g.cx, g.cy, g.rOut, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    },

    drawTriangle() {
      const cvs = P.tri, ctx = cvs.getContext('2d'), n = P.size * P.dpr;
      const img = ctx.createImageData(n, n);
      const d = img.data;
      const h = MTG.state.hsv.h;
      const t = P.verts;

      /* 逐像素渲染：先把顶点换算到设备像素、把重心坐标的分母和不变量提出来，
         再只在三角的外接矩形内迭代 —— 色相环拖拽时每帧都要重画，这里是热点。 */
      const ax = t.A.x * P.dpr, ay = t.A.y * P.dpr;
      const bx = t.B.x * P.dpr, by = t.B.y * P.dpr;
      const cx = t.C.x * P.dpr, cy = t.C.y * P.dpr;
      const v0x = cx - ax, v0y = cy - ay;                  // A→C
      const v1x = bx - ax, v1y = by - ay;                  // A→B
      const d00 = v0x * v0x + v0y * v0y;
      const d01 = v0x * v1x + v0y * v1y;
      const d11 = v1x * v1x + v1y * v1y;
      const den = d00 * d11 - d01 * d01;
      if (!den) { ctx.putImageData(img, 0, 0); return; }

      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const x1 = Math.min(n - 1, Math.ceil(Math.max(ax, bx, cx)));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const y1 = Math.min(n - 1, Math.ceil(Math.max(ay, by, cy)));

      for (let y = y0; y <= y1; y++) {
        const v2y = y - ay;
        for (let x = x0; x <= x1; x++) {
          const v2x = x - ax;
          const d20 = v2x * v0x + v2y * v0y;
          const d21 = v2x * v1x + v2y * v1y;
          const wc = (d11 * d20 - d01 * d21) / den;        // 黑顶点权重
          const wb = (d00 * d21 - d01 * d20) / den;        // 纯色顶点权重
          if (wc < 0 || wb < 0 || 1 - wb - wc < 0) continue;   // 三角外留空
          const V = U.clamp(1 - wc, 0, 1);
          const S = V > 0 ? U.clamp(wb / V, 0, 1) : 0;
          const rgb = hsvRgb(h, S, V);
          const i = (y * n + x) * 4;
          d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    },

    /* 外部设置颜色。
       keepHsv=true：调用方（h/s/v 数字框）刚设过 hsv，别再 hex→hsv 反解 ——
       往返取整会让游标 ±1 抖动（M-9） */
    set(hex, keepHsv) {
      const st = MTG.state;
      st.color = hex;
      if (!keepHsv) st.hsv = U.hex2hsv(hex);
      P.drawTriangle();
      P.paint();
    },
    /* 记入最近色板（localStorage 环形 12 色；与 renderSwatches 的读取端闭环，N-B3） */
    pushSwatch(hex) {
      if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
      try {
        let list = JSON.parse(localStorage.getItem('montage.swatches') || '[]');
        if (!Array.isArray(list)) list = [];
        if (list[0] === hex) return;                 // 最近一个就是它：不重复写
        list = [hex].concat(list.filter(c => String(c).toLowerCase() !== hex.toLowerCase())).slice(0, 12);
        localStorage.setItem('montage.swatches', JSON.stringify(list));
        P.renderSwatches();
      } catch (_) {}
    },
    renderSwatches() {
      const box = document.getElementById('swatches');
      if (!box) return;
      let list = null;
      try { list = JSON.parse(localStorage.getItem('montage.swatches') || 'null'); } catch (e) {}
      if (!list || !list.length) {
        list = ['#eb684b', '#f08a6b', '#d95a3e', '#7bbbe3', '#b0906a',
                '#3d3a36', '#8a857a', '#f7e6da', '#ffffff', '#000000'];
      }
      box.innerHTML = '';
      list.forEach(c => {
        const i = document.createElement('i');
        i.style.background = c;
        i.title = c;
        i.onclick = () => { P.set(c); P.onChange && P.onChange(c); P.pushSwatch(c); };
        box.appendChild(i);
      });
    }
  });

  /* ── 几何辅助 ── */
  function makeOff(size) {
    const c = document.createElement('canvas');
    c.width = size * P.dpr; c.height = size * P.dpr;
    c.getContext('2d').scale(P.dpr, P.dpr);
    return c;
  }
  function marker(ctx, x, y, color) {
    ctx.beginPath();
    ctx.arc(x, y, 5.2, 0, Math.PI * 2);
    ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.fillStyle = 'rgba(0,0,0,.001)';
    ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 3.4, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1; ctx.stroke();
  }
  /* 重心坐标：返回三个顶点权重 A(白) B(纯色) C(黑) */
  function bary(p, t) {
    const v0 = { x: t.C.x - t.A.x, y: t.C.y - t.A.y };
    const v1 = { x: t.B.x - t.A.x, y: t.B.y - t.A.y };
    const v2 = { x: p.x - t.A.x, y: p.y - t.A.y };
    const d00 = v0.x * v0.x + v0.y * v0.y;
    const d01 = v0.x * v1.x + v0.y * v1.y;
    const d11 = v1.x * v1.x + v1.y * v1.y;
    const d20 = v2.x * v0.x + v2.y * v0.y;
    const d21 = v2.x * v1.x + v2.y * v1.y;
    const den = d00 * d11 - d01 * d01;
    if (!den) return { a: 1, b: 0, c: 0 };
    const c = (d11 * d20 - d01 * d21) / den;
    const b = (d00 * d21 - d01 * d20) / den;
    return { a: 1 - b - c, b, c };
  }
  function inTriangle(p, t) {
    const w = bary(p, t);
    return w.a >= -0.02 && w.b >= -0.02 && w.c >= -0.02;
  }
  function hsvRgb(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }
})();
