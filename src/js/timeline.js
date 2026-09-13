/* timeline.js · 时间轴（本项目核心）
   对齐剪辑软件的心智模型：一条标尺 + 多条轨 + 可自由拖动的片段。
   · 片段可整体拖动改变入点、跨轨拖动；拖左右边缘裁剪（trim），带吸附
   · 音频片段绘制波形，卡点看得见；分镜 / 图片片段显示缩略图
   · 滚轮横向滚动，Ctrl+滚轮以光标为锚缩放；点标尺定位，拖动标尺擦洗
   工程文件只保存这里的 start / dur / offset / trackId —— 与 Premiere 同构。 */
(function () {
  'use strict';
  const MTG = window.MTG;
  const U = MTG.util;

  const TL = (MTG.timeline = {
    el: {},
    contentW: 1000,

    init() {
      TL.el = {
        scroll: document.getElementById('tl-scroll'),
        content: document.getElementById('tl-content'),
        tracks: document.getElementById('tl-tracks'),
        heads: document.getElementById('tl-heads'),
        ruler: document.getElementById('ruler'),
        playhead: document.getElementById('playhead'),
        headSpacer: document.getElementById('tl-head-spacer'),
        info: document.getElementById('tl-info')
      };

      /* 滚轮：Ctrl 缩放（以光标为锚），否则横向滚动 */
      TL.el.scroll.addEventListener('wheel', e => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const rect = TL.el.scroll.getBoundingClientRect();
          const x = e.clientX - rect.left + TL.el.scroll.scrollLeft;
          const t = TL.xToTime(x);
          const k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
          TL.setZoom(U.clamp(MTG.state.pxPerSec * k, 8, 400));
          const nx = TL.timeToX(t);
          TL.el.scroll.scrollLeft = nx - (e.clientX - rect.left);
        }
      }, { passive: false });

      /* 头部与内容垂直滚动同步 */
      TL.el.scroll.addEventListener('scroll', () => {
        TL.el.heads.style.transform = 'translateY(' + -TL.el.scroll.scrollTop + 'px)';
      });

      /* 框选矩形 */
      TL.marquee = document.createElement('div');
      TL.marquee.className = 'tl-marquee';
      TL.marquee.style.display = 'none';
      TL.el.content.appendChild(TL.marquee);

      /* 标尺：点击定位 + 拖动擦洗 */
      let scrubbing = false;
      const seek = e => {
        const rect = TL.el.ruler.getBoundingClientRect();
        const t = Math.max(0, TL.xToTime(e.clientX - rect.left));
        MTG.setPlayhead(TL.snapTime(t, true));
      };
      TL.el.ruler.addEventListener('pointerdown', e => {
        scrubbing = true; TL.el.ruler.setPointerCapture(e.pointerId); seek(e);
      });
      TL.el.ruler.addEventListener('pointermove', e => { if (scrubbing) seek(e); });
      TL.el.ruler.addEventListener('pointerup', e => {
        scrubbing = false; try { TL.el.ruler.releasePointerCapture(e.pointerId); } catch (err) {}
      });

      /* 从素材库拖入 */
      TL.el.tracks.addEventListener('dragover', e => {
        e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
        const tr = e.target.closest ? e.target.closest('.track') : null;
        document.querySelectorAll('.track.drop-target').forEach(t => t.classList.remove('drop-target'));
        if (tr) tr.classList.add('drop-target');
      });
      TL.el.tracks.addEventListener('dragleave', () => {
        document.querySelectorAll('.track.drop-target').forEach(t => t.classList.remove('drop-target'));
      });
      TL.el.tracks.addEventListener('drop', async e => {
        e.preventDefault();
        document.querySelectorAll('.track.drop-target').forEach(t => t.classList.remove('drop-target'));
        const data = e.dataTransfer.getData('text/plain') || '';
        const [kind, id] = data.split(':');
        if (!kind || !id) return;
        const rect = TL.el.content.getBoundingClientRect();
        const t = Math.max(0, TL.xToTime(e.clientX - rect.left));
        const overEl = document.elementFromPoint(e.clientX, e.clientY);
        const tr = overEl && overEl.closest ? overEl.closest('.track') : null;
        await TL.dropAsset(kind, id, tr ? tr.dataset.id : null, TL.snapTime(t));
      });
    },

    /* ── 坐标 ── */
    timeToX(t) { return t * MTG.state.pxPerSec; },
    xToTime(x) { return x / MTG.state.pxPerSec; },
    setZoom(pps) {
      const prev = MTG.state.pxPerSec;
      MTG.state.pxPerSec = pps;
      const z = document.getElementById('zoom');
      if (z) z.value = Math.round(pps);
      if (prev !== pps) TL.render();
    },

    /* ── 渲染 ── */
    render() {
      const p = MTG.state.project;
      const sl = TL.el.scroll.scrollLeft, st = TL.el.scroll.scrollTop;
      if (!p) {
        // 未打开工程：空状态
        TL.contentW = Math.max(TL.el.scroll.clientWidth, 600);
        TL.el.content.style.width = TL.contentW + 'px';
        TL.el.heads.innerHTML = '<div class="empty-note" style="padding:12px 8px">未打开工程<br>点左上「打开文件夹」<br>选择（或新建）工程文件夹</div>';
        TL.el.tracks.innerHTML = '';
        TL.drawRuler();
        TL.updatePlayhead();
        TL.el.scroll.scrollLeft = sl; TL.el.scroll.scrollTop = st;
        if (TL.el.info) TL.el.info.textContent = '';
        TL.syncOverlapBtn();
        TL._shotNo = null;
        return;
      }
      TL.contentW = Math.max(MTG.projectEnd() * MTG.state.pxPerSec + 120, TL.el.scroll.clientWidth);
      TL.el.content.style.width = TL.contentW + 'px';
      TL.el.headSpacer.style.width = '152px';

      // 镜号 = 镜头序列序号（含空镜头，与分镜表视图共用同一编号，保证一致）
      TL._shotNo = new Map();
      (MTG.board.orderedShots() || []).forEach((s, i) => TL._shotNo.set(s.id, i + 1));

      TL.renderHeads();
      TL.renderTracks();
      TL.drawRuler();
      TL.updatePlayhead();
      TL.el.scroll.scrollLeft = sl;
      TL.el.scroll.scrollTop = st;
      const mins = Math.floor(MTG.projectEnd() / 60), secs = Math.round(MTG.projectEnd() % 60);
      TL.el.info.textContent = p.clips.length + ' 个片段 · 总长 ' + mins + ':' + String(secs).padStart(2, '0');
      TL.syncOverlapBtn();
    },

    renderHeads() {
      const p = MTG.state.project;
      const box = TL.el.heads;
      box.innerHTML = '';
      p.tracks.forEach((tr, i) => {
        const d = document.createElement('div');
        d.className = 'tl-head' + (tr.muted ? ' muted' : '')
          + (MTG.state.activeTrackId === tr.id ? ' active' : '');
        d.dataset.id = tr.id;
        d.style.height = tr.h + 'px';
        d.style.display = 'flex';
        d.style.alignItems = 'center';
        /* 点轨道头 = 选定该轨：之后的「新建帧 / 放置素材」都落在这条轨上 */
        d.addEventListener('pointerdown', e => {
          if (e.target.closest('.th-grip') || e.target.closest('.th-btn')) return;
          MTG.state.activeTrackId = tr.id;
          box.querySelectorAll('.tl-head').forEach(h => h.classList.toggle('active', h.dataset.id === tr.id));
        });

        const grip = document.createElement('span');
        grip.className = 'th-grip';
        grip.textContent = '⠿';
        grip.title = '拖动重排轨道';
        grip.addEventListener('pointerdown', e => TL.startHeadDrag(e, i));

        const kind = document.createElement('span');
        kind.className = 'th-kind';
        kind.textContent = tr.kind === 'audio' ? 'A' : 'V';
        const nm = document.createElement('span');
        nm.className = 'th-name';
        nm.textContent = tr.name;
        nm.title = tr.name;

        const mute = document.createElement('button');
        mute.className = 'th-btn';
        mute.textContent = tr.muted ? '🔇' : '🔊';
        mute.title = '静音';
        mute.onclick = () => { tr.muted = !tr.muted; MTG.markDirty(); MTG.render(); };

        const del = document.createElement('button');
        del.className = 'th-btn';
        del.textContent = '✕';
        del.title = '删除轨道及其片段';
        del.onclick = () => {
          if (p.tracks.length <= 1) { MTG.toast('至少保留一条轨道', true); return; }
          p.tracks = p.tracks.filter(x => x.id !== tr.id);
          p.clips = p.clips.filter(c => c.trackId !== tr.id);
          MTG.markDirty(); MTG.render();
        };

        d.appendChild(grip); d.appendChild(kind); d.appendChild(nm);
        if (tr.kind === 'audio') d.appendChild(mute);
        d.appendChild(del);
        box.appendChild(d);
      });
      TL.syncHeadScroll();
    },

    /* 轨道多到超出可视高度时，左侧轨道头要跟着右侧一起滚，
       否则下面的轨道头会被裁掉，看着像「只显示前几条轨」。 */
    syncHeadScroll() {
      const apply = () => {
        if (TL.el.heads && TL.el.scroll) TL.el.heads.scrollTop = TL.el.scroll.scrollTop;
      };
      apply();                                  // 每次重绘后先对齐一次
      if (TL._headSync) return;
      TL._headSync = true;
      TL.el.scroll.addEventListener('scroll', apply);
      window.addEventListener('resize', apply);
    },

    /* 新建帧 / 放置素材落在哪条轨：优先选定的轨道，否则第一条分镜轨 */
    activeBoardTrack() {
      const p = MTG.state.project;
      if (!p) return null;
      const sel = p.tracks.find(t => t.id === MTG.state.activeTrackId && t.kind === 'board');
      return sel || p.tracks.find(t => t.kind === 'board') || p.tracks[0];
    },

    /* 轨道头：按住左侧把手上下拖动重排轨道 */
    startHeadDrag(e, fromIdx) {
      e.preventDefault();
      e.stopPropagation();
      const p = MTG.state.project;
      const items = Array.from(TL.el.heads.children);
      const grip = e.currentTarget;
      let to = fromIdx;
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}
      const move = ev => {
        let ins = 0;
        items.forEach((it, i) => {
          const r = it.getBoundingClientRect();
          if (ev.clientY > r.top + r.height / 2) ins = i + 1;
        });
        to = ins > fromIdx ? ins - 1 : ins;
        items.forEach((it, i) => it.classList.toggle('drop-before', i === to && to !== fromIdx));
      };
      const up = ev => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        try { grip.releasePointerCapture(ev.pointerId); } catch (err) {}
        items.forEach(it => it.classList.remove('drop-before'));
        if (to !== fromIdx) {
          const moved = p.tracks.splice(fromIdx, 1)[0];
          p.tracks.splice(to, 0, moved);
          MTG.markDirty();
        }
        MTG.render();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    },

    renderTracks() {
      const p = MTG.state.project;
      const box = TL.el.tracks;
      box.innerHTML = '';
      p.tracks.forEach(tr => {
        const row = document.createElement('div');
        row.className = 'track ' + tr.kind;
        row.style.height = tr.h + 'px';
        row.dataset.id = tr.id;
        row.dataset.kind = tr.kind;

        const marks = document.createElement('div');
        marks.className = 'track-marks';
        row.appendChild(marks);

        /* 轨道空白处：单击=定位播放头；按住拖动=框选片段（同 PR） */
        row.addEventListener('pointerdown', e => {
          if (e.target.closest && e.target.closest('.clip')) return;
          const rect = TL.el.content.getBoundingClientRect();
          const sx = e.clientX, sy = e.clientY;
          let active = false;
          try { row.setPointerCapture(e.pointerId); } catch (err) {}

          const seek = ev => MTG.setPlayhead(Math.max(0, TL.snapTime(TL.xToTime(ev.clientX - rect.left), true)));
          const mv = ev => {
            if (!active && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 6) {
              active = true;
              TL.marquee.style.display = 'block';
            }
            if (!active) { seek(ev); return; }               // 还没判定为框选前，继续擦洗
            const x0 = Math.min(sx, ev.clientX), x1 = Math.max(sx, ev.clientX);
            const y0 = Math.min(sy, ev.clientY), y1 = Math.max(sy, ev.clientY);
            TL.marquee.style.left = (x0 - rect.left) + 'px';
            TL.marquee.style.top = (y0 - rect.top) + 'px';
            TL.marquee.style.width = (x1 - x0) + 'px';
            TL.marquee.style.height = (y1 - y0) + 'px';
            MTG.state.selectedClipIds = TL.selectByRect(x0, x1, y0, y1);
          };
          const up = ev => {
            row.removeEventListener('pointermove', mv);
            row.removeEventListener('pointerup', up);
            try { row.releasePointerCapture(ev.pointerId); } catch (err) {}
            TL.marquee.style.display = 'none';
            if (active) { TL.syncSelection(); return; }      // 框选结束，保留选择
            // 单击：定位 + 清空选择
            MTG.state.selectedClipIds = new Set();
            TL.syncSelection();
            seek(ev);
          };
          row.addEventListener('pointermove', mv);
          row.addEventListener('pointerup', up);
        });
        /* 分镜轨空白处双击 = 在该时刻新建一帧 */
        row.addEventListener('dblclick', e => {
          if (e.target.closest && e.target.closest('.clip')) return;
          if (tr.kind !== 'board') return;
          const rect = TL.el.content.getBoundingClientRect();
          MTG.setPlayhead(Math.max(0, TL.xToTime(e.clientX - rect.left)));
          MTG.board.newFrame();
        });

        p.clips.filter(c => c.trackId === tr.id).forEach(c => row.appendChild(TL.clipEl(c, tr)));
        box.appendChild(row);
      });
      // 历史工程里可能已存在重叠：标红提示，由「整理重叠」按钮处理
      const bad = TL.overlaps();
      if (bad.size) box.querySelectorAll('.clip').forEach(el => el.classList.toggle('overlap', bad.has(el.dataset.id)));
    },

    clipEl(c, tr) {
      const el = document.createElement('div');
      const emptyShot = c.kind === 'board' && !c.boardId;
      el.className = 'clip ' + (c.kind || 'board') + (emptyShot ? ' empty-shot' : '')
        + (MTG.state.selectedClipIds.has(c.id) ? ' selected' : '');
      el.dataset.id = c.id;
      el.style.left = TL.timeToX(c.start) + 'px';
      el.style.width = Math.max(6, TL.timeToX(c.dur)) + 'px';

      if (c.kind === 'audio') {
        const cv = document.createElement('canvas');
        cv.className = 'clip-wave';
        el.appendChild(cv);
        TL.drawWave(cv, c, tr);
      } else if (!emptyShot) {
        const im = document.createElement('img');
        im.className = 'clip-thumb';
        im.draggable = false;
        el.appendChild(im);
        TL.fillThumb(im, c);
      }

      const lb = document.createElement('div');
      lb.className = 'clip-label';
      lb.textContent = TL.clipLabel(c);
      lb.title = emptyShot ? '空镜头：还没画画面' : (c.name || '');
      el.appendChild(lb);
      el.title = TL.clipTip(c);

      ['l', 'r'].forEach(side => {
        const h = document.createElement('div');
        h.className = 'clip-handle ' + side;
        h.dataset.side = side;
        el.appendChild(h);
      });

      el.addEventListener('pointerdown', e => {
        if (e.button === 2) return;
        // Shift/Ctrl+点击：增选 / 移除选择（不进入拖拽）
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          const s = MTG.state.selectedClipIds;
          if (s.has(c.id)) s.delete(c.id); else s.add(c.id);
          TL.syncSelection();
          return;
        }
        if (!MTG.state.selectedClipIds.has(c.id)) MTG.state.selectedClipIds = new Set([c.id]);
        TL.syncSelection();
        TL.startDrag(e, c, el, e.target.dataset && e.target.dataset.side);
      });
      el.addEventListener('dblclick', () => {
        // 预览模型：跳到片段起点，画板自然切到那一帧
        if (c.kind === 'board' && c.boardId) MTG.setPlayhead(c.start + 0.001);
      });
      return el;
    },

    async fillThumb(img, c) {
      let url = null;
      if (c.kind === 'board' && c.boardId) {
        const b = MTG.findBoard(c.boardId);
        if (b) url = await MTG.board.thumbUrl(b);
      } else if (c.assetId) {
        const a = MTG.findAsset(c.assetId);
        if (a) {
          url = await MTG.assets.thumb(a);
          if (!url) {                       // 缓存里的对象 URL 可能已失效，重取一次
            MTG.assets.dropUrl(a.id);
            url = await MTG.assets.thumb(a);
          }
        }
      }
      if (url) img.src = url;
      else if (img) img.classList.add('thumb-miss');   // 读不到就留个占位，不显示破图
    },

    /* 片段标签：分镜镜头 → 「镜号 · 景别 · 时长」；其它 → 名字 */
    clipLabel(c) {
      const m = c.meta || {};
      if (c.kind === 'board') {
        const bits = [];
        const no = TL._shotNo ? TL._shotNo.get(c.id) : null;
        if (no) bits.push(String(no).padStart(2, '0'));
        if (m.size) bits.push(m.size);
        bits.push(U.tc(c.dur));
        return bits.join(' · ');
      }
      return c.name || '片段';
    },

    /* 悬浮提示：把分镜表里填的镜头信息直接摊在时间轴片段上 */
    clipTip(c) {
      const m = c.meta || {};
      const cut = (s, n) => {
        s = (s || '').replace(/\s*\n+\s*/g, ' ').trim();
        return s.length > n ? s.slice(0, n) + '…' : s;
      };
      if (c.kind !== 'board') {
        return (c.name || '片段') + '\n' + U.tc(c.start) + ' → ' + U.tc(c.start + c.dur);
      }
      const no = TL._shotNo ? TL._shotNo.get(c.id) : null;
      const lines = [(no ? '镜 ' + String(no).padStart(2, '0') + ' · ' : '') + U.tc(c.dur)];
      if (m.size) lines.push('景别：' + m.size);
      if (m.move) lines.push('运镜：' + m.move);
      if (m.lens) lines.push('焦段：' + m.lens);
      if (m.trans) lines.push('转场：' + m.trans);
      if (m.content) lines.push('内容：' + cut(m.content, 70));
      if (m.dialogue) lines.push('对白：' + cut(m.dialogue, 50));
      if (m.sfx) lines.push('音效：' + cut(m.sfx, 50));
      if (m.remark) lines.push('备注：' + cut(m.remark, 50));
      return lines.join('\n');
    },

    drawWave(cv, c, tr) {
      const rec = MTG.audio.peek(c.assetId);
      const pps = MTG.state.pxPerSec;
      const w = Math.max(6, Math.round(c.dur * pps));
      const tk = tr || MTG.findTrack(c.trackId);
      const h = ((tk && tk.h) || 62) - 8;            // 轨道高减去 clip 上下留白
      cv.width = w; cv.height = h;
      const x = cv.getContext('2d');
      x.clearRect(0, 0, w, h);
      if (!rec) return;
      const total = rec.buffer.duration || 1;
      const peaks = rec.peaks;
      const mid = h / 2;
      x.fillStyle = getComputedStyle(document.body).getPropertyValue('--blue').trim() || '#7bbbe3';
      for (let px = 0; px < w; px++) {
        const t = (c.offset || 0) + (px / w) * c.dur;
        if (t > total) break;
        const i = Math.min(peaks.length - 1, Math.floor((t / total) * peaks.length));
        const amp = peaks[i] * (mid - 2);
        x.fillRect(px, mid - amp, 1, Math.max(1, amp * 2));
      }
      x.fillStyle = 'rgba(255,255,255,.25)';
      x.fillRect(0, mid, w, 1);
    },

    drawRuler() {
      const cv = TL.el.ruler;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = TL.contentW, h = 30;
      cv.width = w * dpr; cv.height = h * dpr;
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
      const x = cv.getContext('2d');
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, w, h);

      const pps = MTG.state.pxPerSec;
      const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
      let step = steps[steps.length - 1];
      for (const s of steps) { if (s * pps >= 66) { step = s; break; } }
      const minor = step / (step >= 5 ? 5 : 4);
      const css = getComputedStyle(document.body);
      const cText = css.getPropertyValue('--text-dim').trim() || '#8a857a';
      const cGrid = css.getPropertyValue('--grid').trim() || 'rgba(0,0,0,.2)';

      x.strokeStyle = cGrid;
      x.fillStyle = cText;
      x.font = '10px "Cascadia Mono", Consolas, monospace';
      x.lineWidth = 1;
      // 用整数序号推进：浮点累加会让「是否主刻度」判断漂移，导致主刻度漏画
      const end = w / pps;
      const per = Math.max(1, Math.round(step / minor));
      const count = Math.floor(end / minor);
      for (let i = 0; i <= count; i++) {
        const t = i * minor;
        const px = Math.round(t * pps) + 0.5;
        const isMajor = i % per === 0;
        x.beginPath();
        x.moveTo(px, isMajor ? h - 13 : h - 6);
        x.lineTo(px, h);
        x.stroke();
        if (isMajor) {
          x.fillText(fmt(t), px + 3, 11);
        }
      }
      x.beginPath();
      x.moveTo(0, h - 0.5); x.lineTo(w, h - 0.5);
      x.stroke();

      function fmt(t) {
        const m = Math.floor(t / 60), s = t % 60;
        if (step < 1) return m + ':' + s.toFixed(step < 0.5 ? 2 : 1).padStart(4, '0');
        return m + ':' + String(Math.round(s)).padStart(2, '0');
      }
    },

    updatePlayhead() {
      TL.el.playhead.style.left = TL.timeToX(MTG.state.playhead) + 'px';
    },

    /* ── 多选 ── */
    selectByRect(x0, x1, y0, y1) {
      const hits = new Set();
      TL.el.tracks.querySelectorAll('.clip').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.right > x0 && r.left < x1 && r.bottom > y0 && r.top < y1) hits.add(el.dataset.id);
      });
      return hits;
    },
    syncSelection() {
      TL.el.tracks.querySelectorAll('.clip').forEach(el => {
        el.classList.toggle('selected', MTG.state.selectedClipIds.has(el.dataset.id));
      });
    },

    /* 某条轨重排后，把该轨片段的 DOM 位置同步过来（拖动换位时实时刷新） */
    refreshTrack(trackId) {
      TL.el.tracks.querySelectorAll('.clip').forEach(el => {
        const c = MTG.findClip(el.dataset.id);
        if (c && c.trackId === trackId) el.style.left = TL.timeToX(c.start) + 'px';
      });
    },

    /* ── 吸附 ── */
    snapTime(t, soft) {
      if (!MTG.state.snap) return Math.max(0, t);
      const p = MTG.state.project;
      const tol = (soft ? 6 : 8) / MTG.state.pxPerSec;
      const cands = [0, MTG.state.playhead];
      p.clips.forEach(c => { cands.push(c.start, c.start + c.dur); });
      let best = t, bd = tol;
      cands.forEach(v => { const d = Math.abs(v - t); if (d < bd) { bd = d; best = v; } });
      return Math.max(0, best);
    },

    /* ══════════ 同轨不重叠 ══════════
       剪辑软件的基本约束：同一条轨道上片段必须首尾相接，不能互相压住。
       · 拖动：只能在左右邻居之间移动（组内整组横移时取公共区间）
       · 裁剪：左边缘不得越过左邻居，右边缘不得越过右邻居
       · 落位：素材拖入 / 新建帧 / 音频上轨一律先在该时刻「腾出」空间 */

    /* 某条轨道上的片段，按入点升序；exceptIds 里的片段视为透明 */
    trackClips(trackId, exceptIds) {
      const p = MTG.state.project;
      if (!p) return [];
      const skip = exceptIds && exceptIds.size ? exceptIds : null;
      return p.clips
        .filter(c => c.trackId === trackId && !(skip && skip.has(c.id)))
        .sort((a, b) => a.start - b.start);
    },

    /* 以片段的原始区间 [s, e] 为基准找左右邻居，返回它保持长度时的可用入点范围：
       lo = 左邻居的尾（可为 0），hi = 右邻居的头（无右邻居则 Infinity） */
    neighborBounds(trackId, s, e, selfId) {
      const list = TL.trackClips(trackId, selfId ? new Set([selfId]) : null);
      let lo = 0, hi = Infinity;
      for (const c of list) {
        const cs = c.start, ce = c.start + c.dur;
        if (ce <= s + 1e-6) lo = Math.max(lo, ce);
        else if (cs >= e - 1e-6) hi = Math.min(hi, cs);
      }
      return { lo, hi };
    },

    /* 一组片段整组横移时的公共位移区间（组内互为透明，各自按所在轨道算邻居） */
    groupDeltaRange(items) {
      const ids = new Set(items.map(i => i.c.id));
      let dmin = -Infinity, dmax = Infinity;
      for (const it of items) {
        const list = TL.trackClips(it.trackId, ids);
        let lo = 0, hi = Infinity;
        for (const c of list) {
          const cs = c.start, ce = c.start + c.dur;
          if (ce <= it.start + 1e-6) lo = Math.max(lo, ce);
          else if (cs >= it.start + it.dur - 1e-6) hi = Math.min(hi, cs);
        }
        dmin = Math.max(dmin, lo - it.start);
        dmax = Math.min(dmax, hi - it.dur - it.start);
      }
      return dmin > dmax ? { dmin: 0, dmax: 0 } : { dmin, dmax };
    },

    /* 在该轨 [time, time+dur) 处腾出空间：只把真正挡路的片段往后顺推。
       落在空位时不改动任何东西，返回顺推了多少个片段（用于提示）。 */
    makeRoom(trackId, time, dur, selfId) {
      const skip = selfId ? new Set([selfId]) : null;
      const end = time + dur;
      const hit = TL.trackClips(trackId, skip)
        .filter(c => c.start < end - 1e-6 && c.start + c.dur > time + 1e-6);
      if (!hit.length) return 0;

      // 整体平移，而不是逐个 max() —— 逐个推会压掉它们原本的相对间距，制造新的重叠
      let lead = Infinity;
      hit.forEach(c => { if (c.start < lead) lead = c.start; });
      const shift = end - lead;
      hit.forEach(c => { c.start += shift; });

      // 追尾修正：原布局有空隙时，平移后可能压到后面没冲突的片段，从 lead 起顺推一遍
      const tail = TL.trackClips(trackId, skip).filter(c => c.start >= lead - 1e-6);
      for (let i = 1; i < tail.length; i++) {
        const prevEnd = tail[i - 1].start + tail[i - 1].dur;
        if (tail[i].start < prevEnd - 1e-6) tail[i].start = prevEnd;
      }
      return hit.length;
    },

    /* 该轨上 [s, s+dur) 是否与已有片段冲突 */
    conflicts(trackId, s, dur, selfId) {
      return TL.trackClips(trackId, selfId ? new Set([selfId]) : null)
        .some(c => s < c.start + c.dur - 1e-6 && s + dur > c.start + 1e-6);
    },

    /* 该轨上从 wantStart 起、向后找到的第一个不与任何片段冲突的入点 */
    freeStart(trackId, wantStart, dur, selfId) {
      const list = TL.trackClips(trackId, selfId ? new Set([selfId]) : null);
      let s = Math.max(0, wantStart);
      for (let guard = 0; guard < 200; guard++) {
        let hit = false;
        for (const c of list) {
          const ce = c.start + c.dur;
          if (s < ce - 1e-6 && s + dur > c.start + 1e-6) { s = ce; hit = true; }
        }
        if (!hit) break;
      }
      return s;
    },

    /* 重叠检测：返回参与重叠的片段 id 集合（历史工程可能已经有重叠数据） */
    overlaps() {
      const p = MTG.state.project;
      const bad = new Set();
      if (!p) return bad;
      p.tracks.forEach(tr => {
        const list = TL.trackClips(tr.id, null);
        for (let i = 1; i < list.length; i++) {
          if (list[i].start < list[i - 1].start + list[i - 1].dur - 1e-6) {
            bad.add(list[i].id);
            bad.add(list[i - 1].id);
          }
        }
      });
      return bad;
    },

    /* 整理重叠：按轨道逐个顺推，保序且不删任何片段 */
    fixOverlaps() {
      const p = MTG.state.project;
      if (!p) return 0;
      let n = 0;
      p.tracks.forEach(tr => {
        const list = TL.trackClips(tr.id, null);
        for (let i = 1; i < list.length; i++) {
          const prevEnd = list[i - 1].start + list[i - 1].dur;
          if (list[i].start < prevEnd - 1e-6) { list[i].start = prevEnd; n++; }
        }
      });
      if (n) { MTG.markDirty(); MTG.render(); }
      return n;
    },

    syncOverlapBtn() {
      const btn = document.getElementById('btn-fix-overlap');
      if (!btn) return;
      const n = MTG.state.project ? TL.overlaps().size : 0;
      btn.classList.toggle('hidden', !n);
      if (n) btn.textContent = '整理重叠 · ' + n;
    },

    /* ── 拖拽：移动 / 裁剪（多选时整组横移） ── */
    startDrag(e, clip, el, side) {
      if (e.button === 2) return;
      e.stopPropagation();

      const p = MTG.state.project;
      let startX = e.clientX, startY = e.clientY;
      const o = { start: clip.start, dur: clip.dur, offset: clip.offset || 0, trackId: clip.trackId };
      let reordered = false;
      const assetDur = clip.kind === 'audio' ? (MTG.audio.durationOf(clip.assetId) || clip.dur + (clip.offset || 0)) : Infinity;
      const rows = Array.from(TL.el.tracks.children);

      // 组移动：拖的是选中组里的片段且组内不止一个 → 其余选中片段同步横移
      let group = null;
      if (!side && MTG.state.selectedClipIds.has(clip.id) && MTG.state.selectedClipIds.size > 1) {
        group = [...MTG.state.selectedClipIds]
          .map(id => MTG.findClip(id)).filter(Boolean)
          .filter(c => c !== clip)
          .map(c => ({ c, start: c.start, el: TL.el.tracks.querySelector('.clip[data-id="' + c.id + '"]') }));
      }

      // 邻居边界在拖动开始时算一次：拖拽过程中「顶到邻居就停」，不会越过去跳到另一侧；
      // 只有真正跨轨时才重算（见 move 里的跨轨分支）。
      let bounds = TL.neighborBounds(o.trackId, o.start, o.start + o.dur, clip.id);
      let groupItems = null, groupRange = null;
      if (group) {
        groupItems = [{ c: clip, start: o.start, dur: o.dur, trackId: o.trackId }]
          .concat(group.map(g => ({ c: g.c, start: g.start, dur: g.c.dur, trackId: g.c.trackId })));
        groupRange = TL.groupDeltaRange(groupItems);
      }
      // 当前在本轨序列里的位置（用于判定「是否想换位」）
      const insOf = () => {
        const others = TL.trackClips(clip.trackId, new Set([clip.id]));
        const mid = clip.start + clip.dur / 2;
        let n = 0;
        for (const c of others) if (mid > c.start + c.dur / 2) n++;
        return n;
      };
      let lastIns = insOf();

      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      el.classList.add('dragging');

      const move = ev => {
        const dt = (ev.clientX - startX) / MTG.state.pxPerSec;
        if (side === 'l') {
          let d = dt;
          d = Math.max(d, -o.offset);                 // 不能裁到素材起点之前
          d = Math.max(d, bounds.lo - o.start);       // 不能裁进左邻居
          d = Math.min(d, o.dur - 0.1);
          const ns = Math.max(0, o.start + d);
          const real = ns - o.start;                  // 受各处限制后的实际位移
          clip.start = ns;
          clip.offset = Math.max(0, o.offset + real);
          clip.dur = Math.max(0.1, o.dur - real);
        } else if (side === 'r') {
          const limitByAsset = assetDur - o.offset;
          const limitByNext = bounds.hi - o.start;    // 右边缘不能越过右邻居
          const maxDur = Math.min(limitByAsset, limitByNext);
          clip.dur = U.clamp(o.dur + dt, 0.1, isFinite(maxDur) ? Math.max(0.1, maxDur) : 1e6);
        } else {
          /* 换位：拖动越过某个邻居的中点 = 想换顺序。
             在该轨内重排并重新顺位（首尾相接），然后把拖拽基准重置到新位置，
             这样继续拖是相对新起点推进，不会一帧连跳好几格。 */
          if (!group) {
            const others = TL.trackClips(clip.trackId, new Set([clip.id]));
            const want = Math.max(0, o.start + dt);
            const mid = want + clip.dur / 2;
            let ins = 0;
            for (const c of others) if (mid > c.start + c.dur / 2) ins++;
            if (ins !== lastIns) {
              const arr = others.slice();
              arr.splice(ins, 0, clip);
              let acc = arr[0] === clip ? want : arr[0].start;
              arr.forEach(s => { s.start = acc; acc += s.dur; });
              lastIns = ins;
              reordered = true;
              TL.refreshTrack(clip.trackId);
              o.start = clip.start;
              startX = ev.clientX;
              bounds = TL.neighborBounds(clip.trackId, clip.start, clip.start + clip.dur, clip.id);
              el.style.left = TL.timeToX(clip.start) + 'px';
              return;
            }
          }
          let ns = Math.max(0, o.start + dt);
          if (MTG.state.snap) ns = TL.snapTime(ns);
          ns = Math.max(ns, bounds.lo);                                  // 夹在左邻居之后
          if (isFinite(bounds.hi)) ns = Math.min(ns, bounds.hi - clip.dur); // 夹在右邻居之前
          if (groupRange) ns = U.clamp(ns, o.start + groupRange.dmin, o.start + groupRange.dmax);
          const delta = ns - o.start;
          clip.start = ns;
          if (group) group.forEach(g => {             // 组内同步横移，各自不越过 0
            g.c.start = Math.max(0, g.start + delta);
            if (g.el) g.el.style.left = TL.timeToX(g.c.start) + 'px';
          });
          // 跨轨：找到指针所在轨道（仅被抓取的片段换轨）
          const y = ev.clientY;
          for (const row of rows) {
            const r = row.getBoundingClientRect();
            if (y >= r.top && y <= r.bottom) {
              const tr = MTG.findTrack(row.dataset.id);
              const k = clip.kind === 'audio' ? 'audio' : 'board';
              if (tr && tr.kind === k && tr.id !== clip.trackId) {
                clip.trackId = tr.id;
                lastIns = insOf();
                bounds = TL.neighborBounds(tr.id, o.start, o.start + o.dur, clip.id);
                if (groupItems) {                      // 组内成员留在原轨，只需更新被拖片段的轨
                  groupItems[0].trackId = tr.id;
                  groupRange = TL.groupDeltaRange(groupItems);
                }
                // 目标轨的这个位置已被占（比如整段压在一条长音频上）→ 向后滑到最近的空位
                let fixed = isFinite(bounds.hi)
                  ? U.clamp(clip.start, bounds.lo, bounds.hi - clip.dur)
                  : Math.max(clip.start, bounds.lo);
                if (TL.conflicts(tr.id, fixed, clip.dur, clip.id))
                  fixed = TL.freeStart(tr.id, fixed, clip.dur, clip.id);
                if (fixed !== clip.start) {
                  clip.start = fixed;
                  const d2 = fixed - o.start;
                  if (group) group.forEach(g => {
                    g.c.start = Math.max(0, g.start + d2);
                    if (g.el) g.el.style.left = TL.timeToX(g.c.start) + 'px';
                  });
                }
              }
              break;
            }
          }
        }
        clip.start = Math.max(0, clip.start);
        el.style.left = TL.timeToX(clip.start) + 'px';
        el.style.width = Math.max(6, TL.timeToX(clip.dur)) + 'px';
        if (clip.kind === 'audio') {
          const cv = el.querySelector('.clip-wave');
          if (cv) TL.drawWave(cv, clip, null);
        }
        if (clip.kind === 'board' && MTG.state.currentBoardId === clip.boardId) MTG.ui.syncBoardMeta();
      };

      const up = ev => {
        el.classList.remove('dragging');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        try { el.releasePointerCapture(ev.pointerId); } catch (err) {}
        const changed = reordered || o.start !== clip.start || o.dur !== clip.dur || o.trackId !== clip.trackId ||
          (group && group.some(g => g.start !== g.c.start));
        if (changed) MTG.markDirty();
        TL.render();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    },

    /* ── 拖入素材 → 生成片段 ── */
    async dropAsset(kind, id, trackId, time) {
      const p = MTG.state.project;
      if (!p) return;
      const wantKind = kind === 'audio' ? 'audio' : 'board';
      let tr = trackId ? MTG.findTrack(trackId)
        : (MTG.state.activeTrackId ? MTG.findTrack(MTG.state.activeTrackId) : null);
      if (!tr || tr.kind !== wantKind) tr = p.tracks.find(t => t.kind === wantKind);
      if (!tr) {
        tr = { id: U.uid('tr'), name: (wantKind === 'audio' ? '音频 A' : '分镜 V') + (p.tracks.length + 1), kind: wantKind, h: wantKind === 'audio' ? 62 : 78, muted: false };
        p.tracks.push(tr);
      }
      let clip = null, moved = 0;
      if (kind === 'audio') {
        const a = MTG.findAsset(id);
        if (!a) return;
        let dur = 5;
        if (MTG.storage.ready) {
          const blob = await MTG.storage.readBlob(a.path);
          if (blob) { try { const rec = await MTG.audio.load(a.id, blob); dur = rec.buffer.duration; } catch (e) {} }
        }
        moved = TL.makeRoom(tr.id, time, dur);        // 挡路的往右顺推，绝不重叠
        clip = { id: U.uid('cl'), trackId: tr.id, kind: 'audio', assetId: id, name: a.name, start: time, dur, offset: 0, gain: 1 };
      } else if (kind === 'board') {
        const b = MTG.findBoard(id);
        if (!b) return;
        moved = TL.makeRoom(tr.id, time, 3);
        clip = { id: U.uid('cl'), trackId: tr.id, kind: 'board', boardId: id, name: b.name, start: time, dur: 3, offset: 0 };
      } else {
        /* 把图片拖到分镜轨 = 新建一帧并把图贴进去（栅格化成帧）：
           这样画板才能预览它、也能直接接着画，而不是生成一个画板上看不见的图片片段。 */
        const a = MTG.findAsset(id);
        if (!a) return;
        const url = await MTG.assets.thumb(a);
        if (!url) { MTG.toast('读不到这张图', true); return; }
        const img = new Image();
        await new Promise(r => { img.onload = r; img.onerror = r; img.src = url; });
        if (!img.naturalWidth) { MTG.toast('这张图打不开', true); return; }
        const b = await MTG.board.frameFromImage(img, tr, a.name);
        moved = TL.makeRoom(tr.id, time, 3);
        clip = { id: U.uid('cl'), trackId: tr.id, kind: 'board', boardId: b.id, name: b.name, start: time, dur: 3, offset: 0 };
        MTG.toast('已新建 ' + b.name + ' 并贴入图片');
      }
      p.clips.push(clip);
      MTG.state.selectedClipIds = new Set([clip.id]);
      MTG.markDirty();
      TL.render();
      MTG.toast('已放置：' + clip.name + (moved ? '，顺推 ' + moved + ' 个片段' : ''));
    },

    addTrack(kind) {
      const p = MTG.state.project;
      if (!p) { MTG.toast('请先打开工程文件夹', true); return; }
      const n = p.tracks.filter(t => t.kind === kind).length + 1;
      const nt = {
        id: U.uid('tr'),
        name: (kind === 'audio' ? '音频 A' : '分镜 V') + n,
        kind, h: kind === 'audio' ? 62 : 78, muted: false, groupId: null
      };
      p.tracks.push(nt);
      if (kind === 'board') nt.groupId = MTG.ensureTrackGroup(nt);  // 每条分镜轨配一个素材分组
      MTG.markDirty();
      MTG.render();
    },

    deleteSelected() {
      const p = MTG.state.project;
      if (!p || !MTG.state.selectedClipIds.size) return;
      const ids = MTG.state.selectedClipIds;
      p.clips = p.clips.filter(c => !ids.has(c.id));
      MTG.state.selectedClipIds = new Set();
      MTG.markDirty();
      MTG.render();
    }
  });
})();
