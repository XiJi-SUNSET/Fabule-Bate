/* story.js · 故事板视图（第三个工作台）
   故事板 ≠ 分镜表：
     分镜表是「填信息的表格」，故事板是「按叙事顺序铺开的连环画」——
     用来一眼检视节奏与画面连贯性（镜头之间接不接得上、情绪对不对），
     不做逐帧精修。闪电分镜把它叫「预览故事板」，并配了放映模式（按真实时长自动翻页）。
   这里同样提供：卡片网格 + 放映（空格暂停/继续、←→ 切镜、Esc 退出）。 */
(function () {
  'use strict';
  const MTG = window.MTG;
  const U = MTG.util;

  const READ_STORE = (k, d) => { try { return localStorage.getItem(k) || d; } catch (_) { return d; } };
  const S = (MTG.story = {
    active: false,
    /* 低项：格子大小/文字开关持久化（此前重启回默认，与导出口径也会不一致） */
    size: (function () { const v = READ_STORE('montage.story.size', 'md'); return ['sm', 'md', 'lg'].indexOf(v) >= 0 ? v : 'md'; })(),
    showText: READ_STORE('montage.story.text', '1') !== '0',
    sliding: false,
    idx: 0,
    shots: [],
    timer: 0,
    _showToken: 0,

    /* ── 渲染卡片 ── */
    render() {
      const box = document.getElementById('story-grid');
      const info = document.getElementById('story-info');
      if (!box) return;
      box.className = 'story-grid ' + S.size;
      box.innerHTML = '';
      const p = MTG.state.project;
      if (!p) {
        box.innerHTML = '<div class="empty-note">未打开工程<br>点左上「打开文件夹」选择（或新建）工程文件夹</div>';
        if (info) info.textContent = '';
        return;
      }
      const shots = MTG.board.orderedShots();
      if (!shots.length) {
        box.innerHTML = '<div class="empty-note">还没有镜头 —— 去「分镜表」新建镜头，再来这里看整体节奏</div>';
        if (info) info.textContent = '';
        return;
      }
      shots.forEach((shot, i) => box.appendChild(S.card(shot, i + 1)));
      if (info) info.textContent = shots.length + ' 个镜头 · 总长 ' + U.tc(shots.reduce((a, s) => a + (s.dur || 0), 0));
    },

    refreshCard(shot) {
      if (!S.active) return;
      const box = document.getElementById('story-grid');
      if (!box) return;
      for (const card of box.querySelectorAll('.story-card')) {
        if (card.dataset.id !== shot.id) continue;
        const number = Number(card.querySelector('.sc-no').textContent);
        card.replaceWith(S.card(shot, number));
        break;
      }
    },

    card(shot, no) {
      const m = shot.meta || {};
      const el = document.createElement('div');
      el.className = 'story-card' + (MTG.state.selectedClipIds.has(shot.id) ? ' selected' : '');
      el.dataset.id = shot.id;
      el.title = '点击绘制 / 编辑画面 · 双击跳到时间轴';

      const head = document.createElement('div');
      head.className = 'sc-head';
      const n = document.createElement('span');
      n.className = 'sc-no';
      n.textContent = String(no).padStart(2, '0');
      const dur = document.createElement('span');
      dur.className = 'sc-dur';
      dur.textContent = U.tc(shot.dur || 0);
      head.appendChild(n);
      head.appendChild(dur);
      if (m.trans) {
        const tr = document.createElement('span');
        tr.className = 'sc-trans';
        tr.textContent = m.trans;
        head.appendChild(tr);
      }
      el.appendChild(head);

      const pic = document.createElement('div');
      pic.className = 'sc-pic' + (shot.boardId ? '' : ' empty');
      const holder = document.createElement('span');
      pic.appendChild(holder);
      S.fill(shot, holder);
      el.appendChild(pic);

      const tags = document.createElement('div');
      tags.className = 'sc-tags';
      [m.size, m.move].forEach(v => {
        if (!v) return;
        const t = document.createElement('i');
        t.textContent = v;
        tags.appendChild(t);
      });
      el.appendChild(tags);

      if (S.showText) {
        const txt = document.createElement('div');
        txt.className = 'sc-txt';
        const rows = [['内容', m.content], ['对白', m.dialogue], ['音效', m.sfx], ['备注', m.remark]]
          .filter(r => r[1]);
        if (!rows.length) {
          const dim = document.createElement('i');
          dim.className = 'dim';
          dim.textContent = '（未填内容）';
          txt.appendChild(dim);
        } else {
          rows.forEach(([k, v]) => {
            const line = document.createElement('div');
            line.className = 'sc-line';
            const b = document.createElement('b');
            b.textContent = k;
            const s = document.createElement('span');
            s.textContent = v;
            line.appendChild(b);
            line.appendChild(s);
            txt.appendChild(line);
          });
        }
        el.appendChild(txt);
      }

      el.addEventListener('click', () => {
        MTG.state.selectedClipIds = new Set([shot.id]);
        S.syncSel();
      });
      el.addEventListener('dblclick', () => {
        MTG.ui.setView('timeline');
        MTG.setPlayhead(Math.max(0, shot.start) + 0.001);
      });
      /* 单击/双击画面都只开绘画弹窗，且双击必须拦住冒泡（S-6）：
         否则 dblclick 会触发卡片级的"跳时间轴"，弹窗开着视图却被切走。
         延迟 220ms 判定单击：期间出现 dblclick 就并成一次"开弹窗"。 */
      let picClickTimer = 0;
      pic.addEventListener('click', e => {
        e.stopPropagation();
        MTG.state.selectedClipIds = new Set([shot.id]);
        S.syncSel();
        clearTimeout(picClickTimer);
        picClickTimer = setTimeout(() => MTG.sheet.openPaint(shot), 220);
      });
      pic.addEventListener('dblclick', e => {
        e.stopPropagation();
        clearTimeout(picClickTimer);
        MTG.sheet.openPaint(shot);
      });

      const zoom = document.createElement('button');
      zoom.className = 'sc-zoom';
      zoom.textContent = '⤢';
      zoom.title = '放大这个镜头：看大图并编辑全部信息';
      zoom.onclick = e => { e.stopPropagation(); S.openDetail(shot, no); };
      el.appendChild(zoom);
      return el;
    },

    /* ── 镜头详情窗口：大图 + 全部信息（字段在这里也能直接改，改完卡片和时间轴同步） ── */
    openDetail(shot, no) {
      const S2 = S;
      let box = document.getElementById('story-detail');
      if (!box) {
        box = document.createElement('div');
        box.id = 'story-detail';
        box.className = 'st-detail hidden';
        document.body.appendChild(box);
        box.addEventListener('click', e => {
          if (e.target === box || e.target.closest('[data-act="close"]')) box.classList.add('hidden');
        });
      }
      const head = document.createElement('div');
      head.className = 'sd-head';
      const noEl = document.createElement('b');
      noEl.textContent = '镜头 ' + String(no || '').padStart(2, '0');
      const durEl = document.createElement('span');
      durEl.className = 'sd-dur';
      durEl.textContent = U.tc(shot.dur || 0);
      const spacer = document.createElement('div');
      spacer.className = 'tb-spacer';
      const mk = (label, act, fn) => {
        const b = document.createElement('button');
        b.className = 'btn tiny' + (act === 'close' || act === 'goto' ? ' ghost' : '');
        b.textContent = label;
        b.dataset.act = act;
        b.onclick = fn;
        return b;
      };
      head.appendChild(noEl);
      head.appendChild(durEl);
      head.appendChild(spacer);
      head.appendChild(mk('绘制画面', 'paint', () => { box.classList.add('hidden'); MTG.sheet.openPaint(shot); }));
      head.appendChild(mk('跳到时间轴', 'goto', () => {
        box.classList.add('hidden');
        MTG.ui.setView('timeline');
        MTG.setPlayhead(Math.max(0, shot.start) + 0.001);
      }));
      head.appendChild(mk('关闭', 'close', () => box.classList.add('hidden')));

      const body = document.createElement('div');
      body.className = 'sd-body';
      const picBox = document.createElement('div');
      picBox.className = 'sd-pic';
      picBox.title = '点击绘制 / 编辑画面';
      picBox.onclick = () => { box.classList.add('hidden'); MTG.sheet.openPaint(shot); };
      S2.fill(shot, picBox);
      const fields = document.createElement('div');
      fields.className = 'sd-fields';
      MTG.SHOT_FIELDS.forEach(f => {
        const row = document.createElement('div');
        row.className = 'sd-row';
        const lb = document.createElement('label');
        lb.textContent = f.title;
        const holder = document.createElement('div');
        holder.className = 'sd-ctl';
        const el = MTG.metaControl(shot, f, v => {
          shot.meta = shot.meta || {};
          shot.meta[f.key] = v;
          MTG.markDirty();
          MTG.timeline.refreshClipMeta(shot);
          S2.refreshCard(shot);
        });
        holder.appendChild(el);
        row.appendChild(lb);
        row.appendChild(holder);
        fields.appendChild(row);
      });
      body.appendChild(picBox);
      body.appendChild(fields);

      const wrap = document.createElement('div');
      wrap.className = 'sd-box';
      wrap.appendChild(head);
      wrap.appendChild(body);
      box.innerHTML = '';
      box.appendChild(wrap);
      box.classList.remove('hidden');
    },

    async fill(shot, holder) {
      if (!shot.boardId) {
        holder.textContent = '＋ 画';
        return;
      }
      const b = MTG.findBoard(shot.boardId);
      if (!b) return;
      const url = await MTG.board.thumbUrl(b);
      if (!holder.isConnected) return;
      holder.innerHTML = '';
      if (url) {
        const img = document.createElement('img');
        img.src = url;
        holder.appendChild(img);
      } else {
        holder.textContent = '▣';
      }
    },

    syncSel() {
      document.querySelectorAll('#story-grid .story-card').forEach(el =>
        el.classList.toggle('selected', MTG.state.selectedClipIds.has(el.dataset.id)));
    },

    /* ── 导出（基于 UI 模型：与屏幕上的故事板一致；M-13 收尾） ──
       桌面版经主进程系统对话框保存（export:storyPng / storyPdf），浏览器版直接下载。 */
    async buildPng() {
      const shots = MTG.board.orderedShots();
      const p = MTG.state.project;
      if (!p || !shots.length) { MTG.toast('还没有镜头，先做几张再导出', true); return null; }
      const dw = p.boardW || 1280, dh = p.boardH || 720;
      /* R5-10：导出必须与"所见"一致 —— 列数/格子大小随工具栏的「格子」选择，
         文字块随「显示文字」开关（此前固定 4 列 320px、无条件画文字） */
      const { cellW, perRow: maxPer } = S._exportMetrics();
      const perRow = Math.min(maxPer, shots.length);
      const gap = 14, pad = 24, headH = 84, textH = S.showText ? 88 : 12;
      const cellH = Math.round(cellW * dh / dw);
      const rows = Math.ceil(shots.length / perRow);
      const W = pad * 2 + perRow * cellW + (perRow - 1) * gap;
      const H = headH + pad + rows * (cellH + textH + gap);
      const cvs = document.createElement('canvas');
      cvs.width = W; cvs.height = H;
      const g = cvs.getContext('2d');
      g.fillStyle = '#17161d'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#f5f0ea';
      g.font = '600 24px system-ui, "Microsoft YaHei", sans-serif';
      g.fillText(p.name || '故事板', pad, 40);
      g.fillStyle = '#8b8798';
      g.font = '400 13px system-ui, "Microsoft YaHei", sans-serif';
      g.fillText(shots.length + ' 镜 · ' + dw + '×' + dh + ' · ' + new Date().toLocaleString('zh-CN'), pad, 64);
      const imgs = await Promise.all(shots.map(async (s) => {
        const b = s.boardId ? MTG.findBoard(s.boardId) : null;
        if (!b) return null;
        const u = await MTG.board.thumbUrl(b);
        if (!u) return null;
        return new Promise((res) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = () => res(null);
          im.src = u;
        });
      }));
      for (let i = 0; i < shots.length; i++) {
        const s = shots[i], m = s.meta || {};
        const cx = pad + (i % perRow) * (cellW + gap);
        const cy = headH + Math.floor(i / perRow) * (cellH + textH + gap);
        g.fillStyle = '#0d0c12'; g.fillRect(cx, cy, cellW, cellH);
        const img = imgs[i];
        if (img && img.width) {
          const k = Math.min(cellW / img.width, cellH / img.height);
          const w = Math.round(img.width * k), h = Math.round(img.height * k);
          g.drawImage(img, cx + ((cellW - w) >> 1), cy + ((cellH - h) >> 1), w, h);
        } else {
          g.fillStyle = '#4a4656';
          g.font = '400 13px system-ui, "Microsoft YaHei", sans-serif';
          g.textAlign = 'center';
          g.fillText('（空镜）', cx + cellW / 2, cy + cellH / 2 + 4);
          g.textAlign = 'left';
        }
        g.strokeStyle = '#2c2a36'; g.strokeRect(cx + 0.5, cy + 0.5, cellW - 1, cellH - 1);
        g.fillStyle = 'rgba(235,104,75,.92)'; g.fillRect(cx, cy, 30, 22);
        g.fillStyle = '#fff';
        g.font = '600 13px system-ui, sans-serif';
        g.fillText(String(i + 1), cx + (i < 9 ? 9 : 5), cy + 16);
        if (S.showText) {
          g.fillStyle = '#d7d3e0';
          g.font = '400 13px system-ui, "Microsoft YaHei", sans-serif';
          wrapText(g, [m.content, m.dialogue, m.remark].filter(Boolean).join('　'), cx, cy + cellH + 22, cellW, 18, 3);
        }
      }
      return cvs.toDataURL('image/png');
    },

    /* 导出用的格子指标：与工具栏「小/中/大」同一套语义（R5-10） */
    _exportMetrics() {
      const map = { sm: { cellW: 240, perRow: 5 }, md: { cellW: 320, perRow: 4 }, lg: { cellW: 440, perRow: 3 } };
      return map[S.size] || map.md;
    },

    async buildHtml() {
      const shots = MTG.board.orderedShots();
      const p = MTG.state.project;
      if (!p || !shots.length) { MTG.toast('还没有镜头，先做几张再导出', true); return null; }
      const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const tiles = [];
      for (let i = 0; i < shots.length; i++) {
        const s = shots[i], m = s.meta || {};
        const b = s.boardId ? MTG.findBoard(s.boardId) : null;
        let du = '';
        if (b) {
          try {
            const u = await MTG.board.thumbUrl(b);
            if (u) {
              const blob = await (await fetch(u)).blob();
              du = await new Promise((res) => {
                const r = new FileReader();
                r.onload = () => res(String(r.result));
                r.onerror = () => res('');
                r.readAsDataURL(blob);
              });
            }
          } catch (_) {}
        }
        /* 打印版式：字段 label/value 分栏（不再把内容/对白拼成一坨），空字段不占位 */
        const FIELDS = [
          ['画面内容', m.content], ['对白', m.dialogue], ['音效', m.sfx],
          ['景别', m.size], ['运镜', m.move], ['焦段', m.lens],
          ['转场', m.trans], ['备注', m.remark]
        ].filter(([, v]) => v != null && String(v).trim() !== '');
        const rowsHtml = FIELDS.map(([k, v]) =>
          '<tr><th>' + k + '</th><td>' + esc(v) + '</td></tr>').join('');
        tiles.push('<figure class="tile">'
          + (du ? '<img src="' + du + '" alt="">' : '<div class="ph">（空镜）</div>')
          + (S.showText
            ? '<figcaption><div class="cap-hd"><span>镜 ' + (i + 1) + '</span>'
              + '<span class="dur">' + (s.dur ? (+s.dur).toFixed(1) + 's' : '') + '</span></div>'
              + (rowsHtml ? '<table>' + rowsHtml + '</table>' : '<div class="blank">（无描述）</div>')
              + '</figcaption>'
            : '')
          + '</figure>');
      }
      /* PDF 是打印物：固定每行 2 卡（宽松可读），不再跟随屏上格子档位。
         PNG 长图（buildPng）保持"所见即所得"的列数语义。 */
      return '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
        + '<title>' + esc(p.name || '故事板') + '</title>'
        + '<style>'
        + 'body{margin:0;padding:16mm 14mm;background:#fff;color:#16151c;font:13px/1.65 system-ui,"Microsoft YaHei",sans-serif}'
        + 'h1{font-size:20px;margin:0 0 2mm}'
        + '.meta{color:#8a857a;font-size:11.5px;margin:0 0 7mm}'
        + '.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:7mm}'
        + '.tile{margin:0;border:1px solid #d9d5cf;border-radius:4px;overflow:hidden;page-break-inside:avoid;break-inside:avoid}'
        + '.tile img{display:block;width:100%;background:#fff;border-bottom:1px solid #eee}'
        + '.tile .ph{height:52mm;display:flex;align-items:center;justify-content:center;color:#aaa;border-bottom:1px solid #eee}'
        + 'figcaption{padding:3mm 3.5mm 2.5mm}'
        + '.cap-hd{display:flex;justify-content:space-between;align-items:baseline;font-weight:600;font-size:12.5px;margin-bottom:1.8mm}'
        + '.cap-hd .dur{font-weight:400;font-size:11px;color:#999}'
        + 'figcaption table{width:100%;border-collapse:collapse}'
        + 'figcaption th{width:15mm;text-align:left;vertical-align:top;font-weight:400;font-size:11px;color:#8a857a;padding:.7mm 2mm .7mm 0;white-space:nowrap}'
        + 'figcaption td{font-size:11.5px;color:#2f2c29;padding:.7mm 0;word-break:break-word;white-space:pre-wrap}'
        + '.blank{font-size:11px;color:#b5b0a6}'
        + '</style></head><body>'
        + '<h1>' + esc(p.name || '故事板') + '</h1>'
        + '<p class="meta">' + shots.length + ' 镜 · ' + (p.boardW || 1280) + '×' + (p.boardH || 720) + '</p>'
        + '<div class="grid">' + tiles.join('') + '</div>'
        + '</body></html>';
    },

    async exportPng() {
      /* R5-10：导出期间禁用按钮（避免并发点击叠对话框/叠写文件） */
      const btn = document.getElementById('st-export-png');
      if (btn && btn.disabled) return;
      if (btn) btn.disabled = true;
      try {
        const dataUrl = await S.buildPng();
        if (!dataUrl) return;
        const exp = window.fabula && window.fabula.exp;
        if (exp && exp.storyPng) {
          try {
            const r = await exp.storyPng(dataUrl);
            if (r && r.ok) MTG.toast('已导出故事板 PNG：' + r.path);
            else if (!(r && r.canceled)) MTG.toast('导出失败：' + ((r && r.error) || '未知错误'), true);
          } catch (e) { MTG.toast('导出失败：' + ((e && e.message) || e), true); }
          return;
        }
        const blob = await (await fetch(dataUrl)).blob();
        MTG.util.download(((MTG.state.project && MTG.state.project.name) || 'story') + '-故事板.png', blob);
      } finally { if (btn) btn.disabled = false; }
    },

    async exportPdf() {
      const btn = document.getElementById('st-export-pdf');
      if (btn && btn.disabled) return;
      if (btn) btn.disabled = true;
      try {
        const html = await S.buildHtml();
        if (!html) return;
        const exp = window.fabula && window.fabula.exp;
        if (exp && exp.storyPdf) {
          try {
            const r = await exp.storyPdf(html);
            if (r && r.ok) MTG.toast('已导出故事板 PDF：' + r.path);
            else if (!(r && r.canceled)) MTG.toast('导出失败：' + ((r && r.error) || '未知错误'), true);
          } catch (e) { MTG.toast('导出失败：' + ((e && e.message) || e), true); }
          return;
        }
        MTG.util.download(((MTG.state.project && MTG.state.project.name) || 'story') + '-故事板.html',
          new Blob([html], { type: 'text/html' }));
      } finally { if (btn) btn.disabled = false; }
    },

    /* ── 发布到服务器（外挂审阅副本，见 server/board-server.py） ──
       收集：镜头缩略图（dataURL）+ 字段 + 时长 + 镜号 → 主进程 POST。
       全程只读工程；服务器上的替换/便签是独立副本，永不回写。 */
    openPublish() {
      const m = document.getElementById('pub-modal');
      if (!m) return;
      const sv = document.getElementById('pub-server');
      const sc = document.getElementById('pub-secret');
      if (sv && !sv.value) sv.value = MTG.settings.get('boardServer') || 'http://123.57.165.181:8080';
      if (sc && !sc.value) sc.value = MTG.settings.get('boardSecret') || '';
      const lw = document.getElementById('pub-linkwrap');
      if (lw) lw.classList.add('hidden');
      const st = document.getElementById('pub-status');
      if (st) st.textContent = '发布后手机打开同一份内容；替换镜图与便签只存服务器副本，不回写工程。';
      m.classList.remove('hidden');
      if (sc && !sc.value) setTimeout(() => sc.focus(), 40);
    },
    closePublish() {
      const m = document.getElementById('pub-modal');
      if (m) m.classList.add('hidden');
    },
    async buildPublishPayload() {
      const shots = MTG.board.orderedShots();
      const p = MTG.state.project;
      const payload = { name: p.name || '故事板', size: (p.boardW || 1280) + '×' + (p.boardH || 720), shots: [] };
      for (let i = 0; i < shots.length; i++) {
        const s = shots[i], m = s.meta || {};
        const b = s.boardId ? MTG.findBoard(s.boardId) : null;
        let du = null;
        if (b) {
          try {
            const u = await MTG.board.thumbUrl(b);
            if (u) {
              const blob = await (await fetch(u)).blob();
              du = await new Promise((res) => {
                const r = new FileReader();
                r.onload = () => res(String(r.result));
                r.onerror = () => res(null);
                r.readAsDataURL(blob);
              });
            }
          } catch (_) {}
        }
        payload.shots.push({
          no: i + 1,
          dur: s.dur ? ((+s.dur).toFixed(1) + 's') : '',
          fields: {
            '画面内容': m.content || '', '对白': m.dialogue || '', '音效': m.sfx || '',
            '景别': m.size || '', '运镜': m.move || '', '焦段': m.lens || '',
            '转场': m.trans || '', '备注': m.remark || '',
          },
          img: du,
        });
      }
      return payload;
    },
    async publish() {
      const exp = window.fabula && window.fabula.exp;
      if (!exp || !exp.publishBoard) { MTG.toast('仅桌面版支持发布到服务器', true); return; }
      if (!MTG.state.project || !MTG.board.orderedShots().length) { MTG.toast('还没有镜头，先做几张再发布', true); return; }
      const sv = document.getElementById('pub-server');
      const sc = document.getElementById('pub-secret');
      const server = sv ? sv.value.trim() : '';
      const secret = sc ? sc.value.trim() : '';
      if (!server || !secret) { MTG.toast('先填服务器地址和访问密钥', true); return; }
      const st = document.getElementById('pub-status');
      const go = document.getElementById('pub-go');
      if (go && go.disabled) return;
      if (go) { go.disabled = true; go.textContent = '发布中…'; }
      try {
        if (st) st.textContent = '正在收集缩略图…';
        const payload = await S.buildPublishPayload();
        if (st) st.textContent = '上传中（' + payload.shots.length + ' 镜）…';
        MTG.settings.set('boardServer', server);
        MTG.settings.set('boardSecret', secret);
        const r = await exp.publishBoard(server, secret, payload);
        if (r && r.ok) {
          if (st) st.textContent = '已发布 ' + r.shots + ' 镜 ✓ 手机打开下方链接即可浏览';
          const li = document.getElementById('pub-link');
          if (li) li.value = r.url || '';
          const lid = document.getElementById('pub-link-direct');
          if (lid) lid.value = r.direct || '';
          const lw = document.getElementById('pub-linkwrap');
          if (lw) lw.classList.remove('hidden');
          MTG.toast('已发布：手机打开链接即可浏览');
        } else {
          const msg = (r && r.error) || '未知错误';
          if (st) st.textContent = '发布失败：' + msg;
          MTG.toast('发布失败：' + msg, true);
        }
      } catch (e) {
        const msg = (e && e.message) || String(e);
        if (st) st.textContent = '发布失败：' + msg;
        MTG.toast('发布失败：' + msg, true);
      } finally {
        if (go) { go.disabled = false; go.textContent = '发布'; }
      }
    },

    /* ── 放映 ── */
    play() {
      S.shots = MTG.board.orderedShots();
      if (!S.shots.length) { MTG.toast('还没有镜头可以放映', true); return; }
      S.sliding = true;
      S.paused = false;                 // 上次暂停退出后，新一轮放映必须重新开始计时（M-17）
      S.idx = 0;
      document.getElementById('story-slide').classList.remove('hidden');
      S.show();
      S.schedule();
      S.syncPlayBtn();
    },

    stop() {
      S.sliding = false;
      S.paused = false;                 // 暂停状态不跨会话泄漏（M-17）
      clearTimeout(S.timer);
      const el = document.getElementById('story-slide');
      if (el) el.classList.add('hidden');
    },

    paused: false,
    schedule() {
      clearTimeout(S.timer);
      const s = S.shots[S.idx];
      const ms = Math.max(300, (s && s.dur ? s.dur : 3) * 1000);
      S.timer = setTimeout(() => {
        if (!S.sliding || S.paused) return;
        if (S.idx >= S.shots.length - 1) { S.stop(); return; }
        S.idx++;
        S.show();
        S.schedule();
      }, ms);
    },

    show() {
      const s = S.shots[S.idx];
      if (!s) return;
      /* 令牌必须在所有分支之前统一递增（S-8）：空镜头/帧缺失分支也要作废
         在途的缩略图 promise —— 否则上一镜的图回来时会填进空镜头 */
      const tk = ++S._showToken;
      const img = document.getElementById('sl-img');
      const no = document.getElementById('sl-no');
      const meta = document.getElementById('sl-meta');
      const m = s.meta || {};
      if (no) no.textContent = '镜 ' + String(S.idx + 1).padStart(2, '0') + ' / ' + S.shots.length;
      if (meta) meta.textContent = [U.tc(s.dur || 0), m.size, m.move, m.content].filter(Boolean).join(' · ');
      if (!s.boardId) { img.removeAttribute('src'); return; }
      const b = MTG.findBoard(s.boardId);
      if (!b) { img.removeAttribute('src'); return; }
      MTG.board.thumbUrl(b).then(u => { if (u && tk === S._showToken) img.src = u; });
    },

    step(d) {
      if (!S.sliding) return;
      S.idx = Math.max(0, Math.min(S.shots.length - 1, S.idx + d));
      S.show();
      S.schedule();
    },

    togglePause() {
      S.paused = !S.paused;
      if (!S.paused) S.schedule(); else clearTimeout(S.timer);
      S.syncPlayBtn();
    },

    syncPlayBtn() {
      const b = document.getElementById('sl-play');
      if (!b) return;
      b.innerHTML = S.paused
        ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6.5" y="4.5" width="3.6" height="15" rx="1"/><rect x="13.9" y="4.5" width="3.6" height="15" rx="1"/></svg>';
    },

    init() {
      const $ = id => document.getElementById(id);
      $('st-slide').onclick = () => S.play();
      $('sl-close').onclick = () => S.stop();
      $('sl-prev').onclick = () => S.step(-1);
      $('sl-next').onclick = () => S.step(1);
      $('sl-play').onclick = () => S.togglePause();
      document.querySelectorAll('[data-size]').forEach(b => {
        b.onclick = () => {
          S.size = b.dataset.size;
          try { localStorage.setItem('montage.story.size', S.size); } catch (_) {}
          S.render();
          document.querySelectorAll('[data-size]').forEach(x => x.classList.toggle('active', x === b));
        };
      });
      const txt = $('st-text');
      if (txt) txt.onchange = () => {
        S.showText = txt.checked;
        try { localStorage.setItem('montage.story.text', S.showText ? '1' : '0'); } catch (_) {}
        S.render();
      };
      /* 低项：把持久化的状态恢复到工具栏（active / 勾选） */
      document.querySelectorAll('[data-size]').forEach(x => x.classList.toggle('active', x.dataset.size === S.size));
      if (txt) txt.checked = S.showText;
      const ep = $('st-export-png');
      if (ep) ep.onclick = () => S.exportPng();
      const ed = $('st-export-pdf');
      if (ed) ed.onclick = () => S.exportPdf();
      const pb = $('st-publish');
      if (pb) pb.onclick = () => S.openPublish();
      const pc = $('pub-close');
      if (pc) pc.onclick = () => S.closePublish();
      const pd = $('pub-done');
      if (pd) pd.onclick = () => S.closePublish();
      const pg = $('pub-go');
      if (pg) pg.onclick = () => S.publish();
      const pm = $('pub-modal');
      if (pm) pm.addEventListener('click', (e) => { if (e.target === pm) S.closePublish(); });

      document.addEventListener('keydown', e => {
        if (!S.sliding) return;
        if (e.code === 'Space') { e.preventDefault(); S.togglePause(); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); S.step(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); S.step(-1); }
        else if (e.key === 'Escape') { e.preventDefault(); S.stop(); }
      });
    }
  });

  /* 导出用的文本换行：按 canvas 实测宽度折行，超出行数截断 */
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
})();
