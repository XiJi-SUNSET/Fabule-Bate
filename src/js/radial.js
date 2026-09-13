/* radial.js · 轮盘菜单（pie / radial menu）
   按住设置里指定的呼出键（默认 V，也可右键）在画布上唤出：
   朝某个方向轻推 → 该扇区高亮 → 松手执行；在中心死区松手 = 取消。
   八个方向各绑一个动作，动作来自 settings.js 的同一张动作表（所以能绑工具 / 笔刷 / 任何命令）。 */
(function () {
  'use strict';
  const MTG = window.MTG;
  const U = MTG.util;
  const N = 8, R = 100, R0 = 36, HUB = 120;      // 外半径 / 内半径 / svg 半幅
  const STEP = 360 / N;

  /* deg：0 = 正上方，顺时针增大 */
  function polar(r, deg) {
    const a = (deg - 90) * Math.PI / 180;
    return [HUB + r * Math.cos(a), HUB + r * Math.sin(a)];
  }
  function sectorPath(i) {
    const a0 = i * STEP - STEP / 2, a1 = i * STEP + STEP / 2;
    const p1 = polar(R, a0), p2 = polar(R, a1), p3 = polar(R0, a1), p4 = polar(R0, a0);
    return 'M' + p1[0].toFixed(1) + ' ' + p1[1].toFixed(1) +
           'A' + R + ' ' + R + ' 0 0 1 ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1) +
           'L' + p3[0].toFixed(1) + ' ' + p3[1].toFixed(1) +
           'A' + R0 + ' ' + R0 + ' 0 0 0 ' + p4[0].toFixed(1) + ' ' + p4[1].toFixed(1) + 'Z';
  }

  const Rad = (MTG.radial = {
    el: null, svg: null, icons: null, hub: null,
    open: false, hover: -1, items: [], cx: 0, cy: 0,
    ptr: { x: 0, y: 0 },

    init() {
      const el = document.createElement('div');
      el.id = 'radial';
      el.className = 'radial hidden';
      el.innerHTML = '<svg class="radial-svg" viewBox="0 0 ' + (HUB * 2) + ' ' + (HUB * 2) + '"></svg>' +
                     '<div class="radial-icons"></div><div class="radial-hub"></div>';
      document.body.appendChild(el);
      Rad.el = el;
      Rad.svg = el.querySelector('.radial-svg');
      Rad.icons = el.querySelector('.radial-icons');
      Rad.hub = el.querySelector('.radial-hub');

      /* 指针位置：键盘呼出时轮盘就落在最后一次指针所在处 */
      window.addEventListener('pointermove', e => {
        Rad.ptr.x = e.clientX; Rad.ptr.y = e.clientY;
        if (Rad.open) Rad.hit(e.clientX, e.clientY);
      }, true);
      window.addEventListener('pointerup', () => { if (Rad.open) Rad.close(true); }, true);
      window.addEventListener('pointercancel', () => { if (Rad.open) Rad.close(false); }, true);
      window.addEventListener('blur', () => { if (Rad.open) Rad.close(false); });

      /* 右键呼出（可选）：画布上按住右键 */
      const cv = document.getElementById('ov');
      if (cv) {
        cv.addEventListener('pointerdown', e => {
          if (e.button !== 2 || !MTG.settings.get('radialRight')) return;
          if (!MTG.state.currentBoardId) return;
          e.preventDefault();
          e.stopPropagation();     /* 阻断引擎（同为 #ov 上的 bubble 监听）：否则笔右键会同时启动抓手平移 */
          Rad.show();
        }, true);
      }
    },

    /* 按设置重建扇区（每次呼出都重建，改了设置立刻生效） */
    build() {
      const st = MTG.settings;
      const ids = st.get('radial') || [];
      /* 严格保留 8 个槽位（无效 id → null，不用 filter）：filter 会让后面的项前移，
         扇区数量变少、方向与设置错位（"轮盘工具显示不全"的根因）。 */
      Rad.items = Array.from({ length: N }, (_, i) => (ids[i] ? (st.action(ids[i]) || null) : null));
      if (!Rad.items.some(Boolean)) return false;

      let s = '', ic = '';
      Rad.items.forEach((a, i) => {
        s += '<path class="rs' + (a ? '' : ' off') + '" data-i="' + i + '" d="' + sectorPath(i) + '"></path>';
        if (a) ic += '<i class="ri" data-i="' + i + '">' + (a.icon || '') + '</i>';
      });
      Rad.svg.innerHTML = s;
      Rad.icons.innerHTML = ic;
      /* 图标定位走 CSSOM 赋值：CSP 不收 innerHTML 串里的内联 style（会被整条拒绝） */
      Rad.icons.querySelectorAll('.ri').forEach(el => {
        const p = polar((R + R0) / 2, (+el.dataset.i) * STEP);
        el.style.left = (p[0] - 11) + 'px';
        el.style.top = (p[1] - 11) + 'px';
      });
      Rad.hub.textContent = '';
      return true;
    },

    show() {
      if (Rad.open) return;
      if (!Rad.build()) { MTG.toast('轮盘没有可执行的动作，去设置里配一下', true); return; }
      Rad.open = true;
      Rad.hover = -1;
      Rad.el.classList.remove('hidden');
      Rad.cx = U.clamp(Rad.ptr.x, R + 10, window.innerWidth - R - 10);
      Rad.cy = U.clamp(Rad.ptr.y, R + 10, window.innerHeight - R - 10);
      Rad.el.style.left = Rad.cx + 'px';
      Rad.el.style.top = Rad.cy + 'px';
      Rad.highlight(-1);
    },

    hit(x, y) {
      const dx = x - Rad.cx, dy = y - Rad.cy;
      const dist = Math.hypot(dx, dy);
      let i = -1;
      if (dist >= R0 * 0.62) {                       // 中心死区 = 取消
        let deg = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        if (deg < 0) deg += 360;
        i = Math.round(deg / STEP) % N;
      }
      Rad.highlight(i);
    },

    highlight(i) {
      if (i === Rad.hover) return;
      Rad.hover = i;
      Rad.svg.querySelectorAll('.rs').forEach(p => p.classList.toggle('on', +p.dataset.i === i));
      Rad.icons.querySelectorAll('.ri').forEach(p => p.classList.toggle('on', +p.dataset.i === i));
      Rad.hub.textContent = i >= 0 && Rad.items[i] ? Rad.items[i].label : '';
      Rad.hub.classList.toggle('empty', i < 0);
    },

    close(commit) {
      if (!Rad.open) return;
      const i = Rad.hover;
      Rad.open = false;
      Rad.el.classList.add('hidden');
      Rad.hover = -1;
      if (commit && i >= 0 && Rad.items[i]) MTG.settings.run(Rad.items[i].id);
    }
  });
})();
