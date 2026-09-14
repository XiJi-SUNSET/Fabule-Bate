/* sheet.js · 分镜表视图（一行一个镜头）
   与时间轴视图共享同一份工程数据（p.clips / p.boards）：
   · 行 = 分镜轨上的一个片段（镜头），镜号 = 镜头序列序号（与时间轴标签一致，见 board.orderedShots）
   · 镜头可先以「空镜头」形式存在（没有画面），点「画面」列 = 新建并进入绘画弹窗
   · 列按「叙事优先」排布（影视分镜表惯例），字段改动即时写回 clip.meta

   列布局（默认 11 列）：
     镜号 | 画面 | 画面内容 | 对白/旁白 | 音效/音乐 | 时长
         | 景别 | 运镜 | 焦段 | 转场 | 备注
   去掉 机位角度 / 承托设备 两列（旧数据已由 core.migrateProject 并入备注）；
   文本格自动随内容长高，长内容与备注可直接摊开阅读。

   绘画弹窗打开时，时间轴视图里的整块画板（#panel-board）被整体移入弹窗复用，关窗移回。 */
(function () {
  'use strict';
  const MTG = window.MTG;
  const U = MTG.util;

  /* 列清单：t = no/pic/dur/meta；meta 列用 f 查 SHOT_FIELDS 注册表 */
  const metaTitle = key => {
    const f = (MTG.SHOT_FIELDS || []).find(x => x.key === key);
    return f ? f.title : key;
  };
  const COLS = [
    { t: 'no', h: '镜号', w: 'c-no', tt: '按镜头序列自动编号' },
    { t: 'pic', h: '画面', w: 'c-pic', tt: '点击绘制 / 编辑该镜头画面' },
    { t: 'm', f: 'content', h: metaTitle('content'), w: 'c-content', tt: metaHint('content') },
    { t: 'm', f: 'dialogue', h: metaTitle('dialogue'), w: 'c-med', tt: metaHint('dialogue') },
    { t: 'm', f: 'sfx', h: metaTitle('sfx'), w: 'c-med', tt: metaHint('sfx') },
    { t: 'dur', h: '时长', w: 'c-dur', tt: '镜头时长：在时间轴拖动片段边缘修改' },
    { t: 'm', f: 'size', h: metaTitle('size'), w: 'c-sel' },
    { t: 'm', f: 'move', h: metaTitle('move'), w: 'c-sel' },
    { t: 'm', f: 'lens', h: metaTitle('lens'), w: 'c-sel' },
    { t: 'm', f: 'trans', h: metaTitle('trans'), w: 'c-sel', tt: metaHint('trans') },
    { t: 'm', f: 'remark', h: metaTitle('remark'), w: 'c-remark', tt: metaHint('remark') }
  ];
  function metaHint(key) {
    const f = (MTG.SHOT_FIELDS || []).find(x => x.key === key);
    return (f && f.hint) || '';
  }
  function reg(key) {
    return (MTG.SHOT_FIELDS || []).find(x => x.key === key) || { key, title: key, text: true };
  }

  const S = (MTG.sheet = {
    active: false,
    pmShot: null,                 // 绘画弹窗正在编辑的镜头
    _pmBusy: false,               // 弹窗初始化进行中（防 await 期间重入，M-22）

    /* ── 表头（一次性） ── */
    buildHead() {
      const head = document.getElementById('shot-head');
      if (!head) return;
      const tr = document.createElement('tr');
      COLS.forEach(c => {
        const th = document.createElement('th');
        th.className = c.w || '';
        th.textContent = c.h;
        if (c.tt) th.title = c.tt;
        tr.appendChild(th);
      });
      head.innerHTML = '';
      head.appendChild(tr);
    },

    colCount() { return COLS.length; },

    /* ── 渲染 ── */
    render() {
      const body = document.getElementById('shot-body');
      if (!body) return;
      if (MTG.tagMenu) MTG.tagMenu.close();      // 重绘前收起可能开着的标签面板
      body.innerHTML = '';
      const p = MTG.state.project;
      const span = S.colCount();
      if (!p) {
        body.innerHTML = '<tr><td colspan="' + span + '"><div class="empty-note">未打开工程<br>点左上「打开文件夹」选择（或新建）工程文件夹</div></td></tr>';
        S.info();
        return;
      }
      const shots = MTG.board.orderedShots();
      if (!shots.length) {
        body.innerHTML = '<tr><td colspan="' + span + '"><div class="empty-note">还没有镜头 —— 点「＋ 新建镜头」先排好镜头表，再逐个点「画面」补画面</div></td></tr>';
        S.info();
        return;
      }
      shots.forEach((shot, i) => {
        const row = S.row(shot, i + 1);
        body.appendChild(row);
        S.autoRows(row);
      });
      S.info();
    },

    info() {
      const el = document.getElementById('sheet-info');
      if (!el) return;
      const p = MTG.state.project;
      if (!p) { el.textContent = ''; return; }
      const shots = MTG.board.orderedShots();
      el.textContent = shots.length + ' 个镜头 · 总长 ' + U.tc(shots.reduce((a, s) => a + (s.dur || 0), 0));
    },

    row(shot, no) {
      const tr = document.createElement('tr');
      tr.dataset.id = shot.id;
      if (MTG.state.selectedClipIds.has(shot.id)) tr.classList.add('selected');

      COLS.forEach(col => {
        let cell;
        if (col.t === 'no') {
          cell = S.tdNo(no, shot);
        } else if (col.t === 'pic') {
          cell = S.tdPic(shot);
        } else if (col.t === 'dur') {
          cell = S.tdDur(shot);
        } else {
          cell = S.tdMeta(shot, col.f);
        }
        cell.className += col.w ? ' ' + col.w : '';
        tr.appendChild(cell);
      });

      tr.addEventListener('click', () => S.select(shot));
      tr.addEventListener('dblclick', () => {
        MTG.ui.setView('timeline');
        MTG.setPlayhead(Math.max(0, shot.start) + 0.001);
      });
      return tr;
    },

    tdNo(no, shot) {
      const td = document.createElement('td');
      const grip = document.createElement('i');
      grip.className = 'row-grip';
      grip.textContent = '⠿';
      grip.title = '按住拖动可调整镜头顺序';
      grip.addEventListener('pointerdown', e => S.startRowDrag(e, shot));
      const num = document.createElement('span');
      num.textContent = String(no).padStart(2, '0');
      td.appendChild(grip);
      td.appendChild(num);
      return td;
    },

    /* 行拖拽换位：按住镜号列的把手上下拖，落到目标行上/下方即插入 */
    startRowDrag(e, shot) {
      e.preventDefault();
      e.stopPropagation();
      const body = document.getElementById('shot-body');
      const rows = Array.from(body.querySelectorAll('tr[data-id]'));
      let target = null;
      const clear = () => rows.forEach(r => r.classList.remove('drop-above', 'drop-below'));
      const move = ev => {
        const over = rows.find(r => {
          const rc = r.getBoundingClientRect();
          return ev.clientY >= rc.top && ev.clientY <= rc.bottom;
        });
        clear();
        if (!over || over.dataset.id === shot.id) { target = null; return; }
        const rc = over.getBoundingClientRect();
        const below = ev.clientY > rc.top + rc.height / 2;
        over.classList.add(below ? 'drop-below' : 'drop-above');
        target = { id: over.dataset.id, below };
      };
      /* M-2：up/cancel 统一收尾（pointercancel 时曾把监听器留在 document 上） */
      const end = (commit) => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onCancel);
        clear();
        if (commit && target) S.dropRow(shot.id, target.id, target.below);
      };
      const onUp = () => end(true);
      const onCancel = () => end(false);
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onCancel);
    },

    dropRow(id, overId, below) {
      const shot = MTG.findClip(id);
      const over = MTG.findClip(overId);
      if (!shot || !over || shot === over) return;
      const arr = MTG.board.orderedShots().filter(s => s.trackId === over.trackId);
      if (!arr.length) return;
      const from = arr.indexOf(shot);
      let to = arr.indexOf(over) + (below ? 1 : 0);
      if (from >= 0 && from < to) to--;
      if (from >= 0 && from === to) return;
      if (from >= 0) arr.splice(from, 1);
      arr.splice(Math.max(0, Math.min(to, arr.length)), 0, shot);
      shot.trackId = over.trackId;                 // 允许拖到别的分镜轨
      let acc = arr[0].start;
      arr.forEach(s => { s.start = acc; acc += s.dur; });
      MTG.markDirty();
      MTG.render();
      MTG.toast('已把镜头移到第 ' + (arr.indexOf(shot) + 1) + ' 位');
    },

    tdPic(shot) {
      const td = document.createElement('td');
      const pic = document.createElement('div');
      const has = !!shot.boardId;
      pic.className = 'shot-pic' + (has ? '' : ' empty');
      pic.title = has ? '点击绘制 / 编辑该镜头画面' : '还没有画面 —— 点击新建并作画';
      const holder = document.createElement('span');
      pic.appendChild(holder);
      S.picCell(shot, holder);
      /* 单击 = 开绘画弹窗；双击画面同样只开弹窗、且必须拦住冒泡（S-6）——
         否则第一次 click 开弹窗、dblclick 又冒泡到行上触发"跳时间轴"，
         用户会看到"弹窗开着且视图被切走"（分镜表切走后工作台第三列还是残缺的）。
         延迟 220ms 判定单击：期间出现 dblclick 就并成一次"开弹窗"。 */
      let clickTimer = 0;
      pic.onclick = () => {
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => { S.openPaint(shot); }, 220);
      };
      pic.addEventListener('dblclick', e => {
        e.stopPropagation();
        clearTimeout(clickTimer);
        S.openPaint(shot);
      });
      td.appendChild(pic);
      return td;
    },

    /* 时长格：可直接改 —— 秒数（2.5）或 分:秒（1:30），回车/失焦即写入并同步时间轴 */
    tdDur(shot) {
      const td = document.createElement('td');
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'shot-in dur-in';
      inp.value = shot.dur ? U.tc(shot.dur) : '';
      inp.placeholder = '0:00.00';
      inp.title = '镜头时长：可直接输入秒数（如 2.5）或 分:秒（如 1:30），挡路的片段会自动顺推';
      const revert = () => { inp.value = shot.dur ? U.tc(shot.dur) : ''; };
      inp.addEventListener('change', () => {
        const v = S.parseDur(inp.value);
        if (v == null) { MTG.toast('时长格式不对：用秒数（2.5）或 分:秒（1:30）', true); revert(); return; }
        if (Math.abs(v - (shot.dur || 0)) < 1e-4) { revert(); return; }
        S.setDur(shot, v);
      });
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') inp.blur();
        else if (e.key === 'Escape') { revert(); inp.blur(); }
        e.stopPropagation();                       // 别让全局快捷键抢走输入
      });
      td.appendChild(inp);
      return td;
    },

    parseDur(str) {
      const s = (str || '').trim();
      if (!s) return null;
      if (/^\d+(\.\d+)?$/.test(s)) {                       // 纯秒数
        const n = parseFloat(s);
        return n > 0.01 && n < 3600 ? n : null;
      }
      const m = s.match(/^(\d{1,3}):([0-5]?\d(?:\.\d{1,2})?)$/);   // 分:秒
      if (m) {
        const n = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
        return n > 0.01 ? n : null;
      }
      return null;
    },

    /* 改时长：挡路的往右顺推（波纹），时间轴 / 分镜表 / 侧栏一起刷新 */
    setDur(shot, d) {
      const moved = MTG.timeline.makeRoom(shot.trackId, shot.start, d, shot.id);
      shot.dur = d;
      MTG.markDirty();
      MTG.timeline.render();                       // 时间轴立刻体现新长度
      if (S.active) S.render();                    // 分镜表重绘（时长列 + 总长）
      MTG.ui.syncShotPanel && MTG.ui.syncShotPanel();
      MTG.toast('时长改为 ' + U.tc(d) + (moved ? '，顺推 ' + moved + ' 个片段' : ''));
    },

    tdMeta(shot, key) {
      const td = document.createElement('td');
      const f = reg(key);
      const el = MTG.metaControl(shot, f, v => S.set(shot, key, v));
      el.className = 'shot-in';
      if (f.text) el.addEventListener('input', () => S.autoRows(el.closest('tr')));
      td.appendChild(el);
      return td;
    },

    /* 文本格随内容自动长高 */
    autoRows(tr) {
      if (!tr) return;
      tr.querySelectorAll('textarea.shot-in').forEach(ta => {
        ta.style.height = 'auto';
        ta.style.height = Math.max(46, ta.scrollHeight + 2) + 'px';
      });
    },

    async picCell(shot, holder) {
      if (!shot.boardId) {
        holder.innerHTML = '';
        const t = document.createElement('i');
        t.textContent = '＋ 画';
        holder.appendChild(t);
        return;
      }
      const b = MTG.findBoard(shot.boardId);
      if (!b) return;
      const url = await MTG.board.thumbUrl(b);
      if (!holder.isConnected) return;          // 行已被重绘，放弃本次填充
      holder.innerHTML = '';
      if (url) {
        const img = document.createElement('img');
        img.src = url;
        holder.appendChild(img);
      } else {
        holder.textContent = '▣';
      }
    },

    /* 字段改动：meta 就地写回片段，并同步时间轴标签 */
    set(shot, key, val) {
      shot.meta = shot.meta || {};
      shot.meta[key] = val;
      MTG.markDirty();
      if (MTG.timeline.el.tracks) MTG.timeline.render();
    },

    select(shot) {
      MTG.state.selectedClipIds = new Set([shot.id]);
      const body = document.getElementById('shot-body');
      if (body) body.querySelectorAll('tr').forEach(tr => tr.classList.toggle('selected', tr.dataset.id === shot.id));
    },

    /* ── 工具栏 ── */
    singleBoard() {
      if (MTG.state.selectedClipIds.size !== 1) return null;
      const id = [...MTG.state.selectedClipIds][0];
      const c = MTG.findClip(id);
      return (c && c.kind === 'board') ? c : null;
    },

    newShot() {
      const p = MTG.state.project;
      if (!p) { MTG.toast('请先打开工程文件夹', true); return; }
      let track = p.tracks.find(t => t.kind === 'board');
      if (!track) {
        track = { id: U.uid('tr'), name: '分镜 V' + (p.tracks.length + 1), kind: 'board', h: 78, muted: false, groupId: null };
        p.tracks.push(track);
      }
      const src = S.singleBoard();
      const shots = MTG.board.orderedShots();
      const at = src
        ? src.start + src.dur
        : (shots.length ? shots[shots.length - 1].start + shots[shots.length - 1].dur : 0);
      const moved = MTG.timeline.makeRoom(track.id, at, 3);
      const clip = {
        id: U.uid('cl'), trackId: track.id, kind: 'board', boardId: null,
        name: '镜头', start: at, dur: 3, offset: 0, meta: {}
      };
      p.clips.push(clip);
      MTG.state.selectedClipIds = new Set([clip.id]);
      MTG.markDirty();
      MTG.render();
      MTG.toast('已新建空镜头' + (moved ? '，顺推 ' + moved + ' 个片段' : '') + '——点「画面」列开始作画');
    },

    copyShot() {
      const src = S.singleBoard();
      if (!src) { MTG.toast('先在表格里选中一个镜头（点行即可）', true); return; }
      const p = MTG.state.project;
      const at = src.start + src.dur;
      const moved = MTG.timeline.makeRoom(src.trackId, at, src.dur || 3);
      const cp = JSON.parse(JSON.stringify(src));
      cp.id = U.uid('cl');
      cp.start = at;
      cp.meta = Object.assign({}, src.meta || {});
      if (cp.name && src.boardId) cp.name = src.name.replace(/\s*·\s*复.*$/, '') + ' · 复';
      p.clips.push(cp);
      MTG.state.selectedClipIds = new Set([cp.id]);
      MTG.markDirty();
      MTG.render();
      MTG.toast('已复制到该镜头之后' + (moved ? '（顺推 ' + moved + ' 个片段）' : '')
        + (cp.boardId ? '（画面与原镜头共用同一帧）' : ''));
    },

    /* 删除镜头：二次确认（同一按钮 3 秒内再点一次）+ 完整清理链（S-7）。
       旧实现只 filter 掉 clip —— boards/*.png 与素材库条目留下"删不掉的孤儿帧"，
       而且零确认、不可撤销。现在复用 assets.removeItems：连帧条目、引用片段、
       磁盘帧文件（回收站）、缩略图/洋葱皮缓存一起清。 */
    async delShot() {
      const c = S.singleBoard();
      if (!c) { MTG.toast('先在表格里选中一个镜头（点行即可）', true); return; }
      const btn = document.getElementById('sh-del');
      if (S._delArm !== c.id) {                       // 第一次点：进入确认态
        S._delArm = c.id;
        clearTimeout(S._delTimer);
        S._delTimer = setTimeout(() => S._delDisarm(), 3000);
        if (btn) { btn.classList.add('armed'); btn.textContent = '再点一次确认'; }
        MTG.toast('再点一次「删除」确认删除该镜头' + (c.boardId ? '（画面文件也会移入回收站）' : ''));
        return;
      }
      S._delDisarm();
      const p = MTG.state.project;
      const bid = c.boardId;
      p.clips = p.clips.filter(x => x !== c);
      MTG.state.selectedClipIds = new Set();
      MTG.markDirty();
      /* 帧文件只在没有其它片段引用时才删（复制镜头共享同一帧） */
      const stillUsed = !!(bid && p.clips.some(x => x.boardId === bid));
      if (bid && !stillUsed) {
        const b = MTG.findBoard(bid);
        if (b) await MTG.assets.removeItems([Object.assign({ type: 'board' }, b)]);
        else MTG.render();
      } else {
        MTG.render();
      }
      MTG.toast('已删除镜头' + (bid && !stillUsed ? '（帧文件已移入回收站）' : ''));
    },
    _delDisarm() {
      S._delArm = null;
      clearTimeout(S._delTimer);
      const btn = document.getElementById('sh-del');
      if (btn) { btn.classList.remove('armed'); btn.textContent = '删除'; }
    },

    /* 上/下移动 = 在该轨的镜头序列里换位，并让时间轴保持首尾相接 */
    moveShot(dir) {
      const c = S.singleBoard();
      if (!c) { MTG.toast('先在表格里选中一个镜头', true); return; }
      const trShots = MTG.board.orderedShots().filter(s => s.trackId === c.trackId);
      const i = trShots.indexOf(c);
      const j = i + dir;
      if (j < 0 || j >= trShots.length) {
        MTG.toast('已在镜头序列最' + (dir < 0 ? '前' : '后') + '端', true);
        return;
      }
      trShots.splice(i, 1);
      trShots.splice(j, 0, c);
      let acc = trShots[0].start;
      trShots.forEach(s => { s.start = acc; acc += s.dur; });
      MTG.markDirty();
      MTG.render();
      MTG.toast('已移动，该轨镜头顺位重排');
    },

    /* ── 绘画弹窗（复用 #panel-board 画板实例） ── */
    async openPaint(shot) {
      const p = MTG.state.project;
      if (!p) { MTG.toast('请先打开工程文件夹', true); return; }
      const B = MTG.board;
      if (S.pmShot || S._pmBusy) { MTG.toast('绘画窗口已打开，先「存帧并关闭」', true); return; }
      S._pmBusy = true;      // 防重入：await 期间双击会绕过 S.pmShot 检查，产生孤儿帧（M-22）
      try {
        // 空镜头：先落一张透明底帧，随后直接在上面画
        if (!shot.boardId) {
          try { await B.createBlankBoard(shot); } catch (e) { MTG.toast('新建帧失败：' + e.message, true); return; }
        }
        await B.flush();                                   // 当前画板若有未存笔迹，先落盘
        MTG.setPlayhead(Math.max(0, shot.start) + 0.001);  // 播放头进该镜头 → 画板自动加载
        await B.syncToPlayhead();
        if (!MTG.findBoard(shot.boardId)) { MTG.toast('帧文件丢失，无法绘画', true); return; }

        const no = MTG.board.orderedShots().indexOf(shot) + 1;
        document.getElementById('pm-title').textContent = '绘画 · 镜 ' + String(no).padStart(2, '0')
          + (shot.meta && shot.meta.size ? ' · ' + shot.meta.size : '');
        document.getElementById('pm-sub').textContent = shot.name + ' —— 画完点「存帧并关闭」写入该镜头帧文件';

        const panel = document.getElementById('panel-board');
        document.getElementById('pm-body').appendChild(panel);
        document.getElementById('paint-modal').classList.remove('hidden');
        S.pmShot = shot;
        /* 画板面板搬进弹窗后舞台尺寸骤变：先让引擎重建画布分辨率再适配（H-8） */
        requestAnimationFrame(() => { window.dispatchEvent(new Event('resize')); MTG.board.fitView(); });
      } finally {
        S._pmBusy = false;
      }
    },

    async closePaint(save) {
      const B = MTG.board;
      const panel = document.getElementById('panel-board');
      const modal = document.getElementById('paint-modal');
      if (save) {
        const ok = await B.flush();
        if (ok === false) {                             // 写盘失败：别关窗谎报成功（N-B6）
          MTG.toast('存帧失败，未关闭 —— 检查磁盘后重试', true);
          return;
        }
      } else {
        await B.reloadCurrent();                        // 放弃本次笔迹（从磁盘重读）
      }
      const ws = document.querySelector('.workspace');
      if (panel.parentNode !== ws) ws.appendChild(panel);
      modal.classList.add('hidden');
      if (S.pmShot && S.pmShot.boardId) B.dropThumb(S.pmShot.boardId);
      S.pmShot = null;
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));    // 面板搬回工作台：重建画布（H-8）
        MTG.board.fitView();
        MTG.ui.syncBoardMeta();
      });
      MTG.render();
    },

    init() {
      const $ = id => document.getElementById(id);
      S.buildHead();
      $('sh-new').onclick = () => S.newShot();
      $('sh-copy').onclick = () => S.copyShot();
      $('sh-del').onclick = () => S.delShot();
      $('sh-up').onclick = () => S.moveShot(-1);
      $('sh-down').onclick = () => S.moveShot(1);
      $('pm-save').onclick = () => S.closePaint(true);
      $('pm-cancel').onclick = () => S.closePaint(false);
    }
  });
})();
