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

  const S = (MTG.story = {
    active: false,
    size: 'md',
    showText: true,
    sliding: false,
    idx: 0,
    shots: [],
    timer: 0,

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
      pic.addEventListener('click', e => {
        e.stopPropagation();
        MTG.state.selectedClipIds = new Set([shot.id]);
        S.syncSel();
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
          if (MTG.timeline.el.tracks) MTG.timeline.render();
          S2.render();                              // 卡片上的摘要跟着变
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

    /* ── 放映 ── */
    play() {
      S.shots = MTG.board.orderedShots();
      if (!S.shots.length) { MTG.toast('还没有镜头可以放映', true); return; }
      S.sliding = true;
      S.idx = 0;
      document.getElementById('story-slide').classList.remove('hidden');
      S.show();
      S.schedule();
      S.syncPlayBtn();
    },

    stop() {
      S.sliding = false;
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
      const img = document.getElementById('sl-img');
      const no = document.getElementById('sl-no');
      const meta = document.getElementById('sl-meta');
      const m = s.meta || {};
      if (no) no.textContent = '镜 ' + String(S.idx + 1).padStart(2, '0') + ' / ' + S.shots.length;
      if (meta) meta.textContent = [U.tc(s.dur || 0), m.size, m.move, m.content].filter(Boolean).join(' · ');
      if (!s.boardId) { img.removeAttribute('src'); return; }
      const b = MTG.findBoard(s.boardId);
      if (!b) { img.removeAttribute('src'); return; }
      MTG.board.thumbUrl(b).then(u => { if (u) img.src = u; });
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
      if (b) b.textContent = S.paused ? '▶' : '❙❙';
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
          S.render();
          document.querySelectorAll('[data-size]').forEach(x => x.classList.toggle('active', x === b));
        };
      });
      const txt = $('st-text');
      if (txt) txt.onchange = () => { S.showText = txt.checked; S.render(); };

      document.addEventListener('keydown', e => {
        if (!S.sliding) return;
        if (e.code === 'Space') { e.preventDefault(); S.togglePause(); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); S.step(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); S.step(-1); }
        else if (e.key === 'Escape') { e.preventDefault(); S.stop(); }
      });
    }
  });
})();
