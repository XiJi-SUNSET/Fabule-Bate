/* assets.js · 素材库（带分组 bins，同 Premiere 的素材箱）
   · 工程文件夹里的图片 / 音频 + 画板产出的分镜帧，统一列在这里
   · 分组：每条分镜轨自动配一个同名分组，新建帧默认归入所在轨道的分组；
     「＋ 分组」手动建组，双击组名重命名，条目拖到组头上即归组，✕ 删组不删素材
   · 拖拽条目到时间轴即生成片段；双击图片 → 载入参考层；双击音频 → 播放头处上轨
   · 素材只存「相对路径引用」，文件本体留在工程文件夹（同 Premiere 的 link 而非 embed） */
(function () {
  'use strict';
  const MTG = window.MTG;
  const U = MTG.util;

  const A = (MTG.assets = {
    filter: 'all',
    urlCache: new Map(),
    collapsed: new Set(),               // 折叠的分组 id（null = 未分组）
    selected: new Set(),                // 选中的条目 key（type:id）
    _order: [],                         // 当前渲染顺序的 key 列表（Shift 范围选择用）
    _lastKey: null,                     // 最近一次点选的 key（范围锚点）
    _rt: 0,                             // render 代际（H-14：并发 render 时后发者胜，防重复条目）
    _delArm: null,                      // 删除二次确认：待确认的条目 key（或 'batch'）
    _delTimer: null,
    _renaming: null,                    // 进行中的分组重命名 { gid, draft }（外部重渲染后据此恢复编辑态）

    /* 收集全部条目：分镜帧 + 素材，统一形状 */
    allItems() {
      const p = MTG.state.project;
      if (!p) return [];
      const boards = (p.boards || []).map(b => ({ type: 'board', id: b.id, name: b.name, path: b.path, kind: 'board', group: b.group == null ? null : b.group }));
      const assets = (p.assets || []).map(a => Object.assign({ type: 'asset', group: a.group == null ? null : a.group }, a));
      return boards.concat(assets);
    },

    async render() {
      /* H-14：render 是 async 且调用方常在未 await 的情况下连发 —— 两次并发交错
         （后一次已清空、前一次还在往里 append）会渲染出重复的分组头/条目。
         代际令牌：每个 await 边界后校验，过期立即退出。 */
      const tk = ++A._rt;
      const box = document.getElementById('asset-list');
      const p = MTG.state.project;
      if (!box) return;
      box.innerHTML = '';
      A._order = [];
      /* 点空白处清空选择（条目/组头自己的 click 处理各自 stopPropagation） */
      box.onclick = (e) => {
        const t = e.target;
        if (t === box || (t && t.classList && t.classList.contains('group-items'))) {
          if (!A.selected.size) return;
          A.selected.clear(); A._lastKey = null;
          A.paintSelection(); A.syncSelBar();
        }
      };
      if (!p) {
        box.innerHTML = '<div class="empty-note">未打开工程<br>点左上「打开文件夹」<br>选择（或新建）工程文件夹</div>';
        A.syncSelBar();
        return;
      }
      /* 清理已不存在条目的选中态（工程被外部改过 / 条目被移除） */
      const liveKeys = new Set(A.allItems().map(i => A.keyOf(i)));
      A.selected.forEach(k => { if (!liveKeys.has(k)) A.selected.delete(k); });
      if (A._lastKey && !liveKeys.has(A._lastKey)) A._lastKey = null;
      const groups = (p.groups || []).slice();
      const items = A.allItems().filter(i => A.filter === 'all' || i.kind === A.filter);
      const used = new Set();
      const sections = [];

      groups.forEach(g => {
        const list = items.filter(i => i.group === g.id);
        list.forEach(i => used.add(i.type + ':' + i.id));
        sections.push({ id: g.id, name: g.name, list, fixed: false });
      });
      const rest = items.filter(i => !used.has(i.type + ':' + i.id) || i.group == null);
      /* 低项：只要有分组就保留"未分组"节（哪怕为空）—— 它是"把条目拖出分组"的唯一落点 */
      sections.push({ id: null, name: '未分组', list: rest, fixed: true });

      let any = false;
      const hasGroups = sections.some(x => x.id);
      for (const s of sections) {
        if (tk !== A._rt) return;                        // 已有更新的 render 在跑：本次作废
        if (!s.list.length && !s.id && !hasGroups) continue;   // 纯空工程才不显示空的「未分组」
        any = true;
        box.appendChild(A.groupHead(s, s.list.length));
        if (A.collapsed.has(s.id)) continue;
        const wrap = document.createElement('div');
        wrap.className = 'group-items';
        wrap.dataset.gid = s.id == null ? '' : s.id;
        for (const it of s.list) {
          A._order.push(A.keyOf(it));
          wrap.appendChild(await A.item(it));
          if (tk !== A._rt) return;                      // item 里含 await（缩略图）：边界后复查
        }
        if (!s.list.length) wrap.innerHTML = '<div class="group-empty">空分组 · 把条目拖到这里</div>';
        box.appendChild(wrap);
      }
      if (tk !== A._rt) return;
      if (!any) box.innerHTML = '<div class="empty-note">还没有素材<br>点「导入」添加，或「新建帧」开始分镜</div>';
      A.syncSelBar();
      /* 恢复被外部重渲染打断的组名编辑（见 renameGroup 注释第 3 点） */
      if (A._renaming) {
        const rg = (p.groups || []).find(x => x.id === A._renaming.gid);
        const heads = box.querySelectorAll('.group-head');
        let nm2 = null;
        for (const h of heads) if (h.dataset.gid === A._renaming.gid) { nm2 = h.querySelector('.g-name'); break; }
        if (rg && nm2) A.renameGroup(rg, nm2, A._renaming.draft);
        else A._renaming = null;      // 组被删/被过滤：放弃恢复
      }
    },

    /* ── 选择状态（批量删除用） ── */
    keyOf(it) { return it.type + ':' + it.id; },
    selectedItems() {
      const all = A.allItems();
      return all.filter(i => A.selected.has(A.keyOf(i)));
    },
    syncSelBar() {
      const btn = document.getElementById('btn-del-selected');
      if (!btn) return;
      const n = A.selected.size;
      const armed = A._delArm === 'batch';
      btn.disabled = !n;
      btn.textContent = armed ? '确认删除 (' + n + ')' : (n ? '删除选中 (' + n + ')' : '删除选中');
      btn.classList.toggle('armed', armed);
      btn.title = n
        ? '移除选中的 ' + n + ' 项：条目与引用它们的片段会被删除，工程内副本移入回收站'
        : '先点选素材（Ctrl / Shift 可多选）';
      /* 选中时把底部提示换成"怎么删"（用户反馈：批量选中后不知按什么删） */
      const hint = document.getElementById('asset-hint');
      if (hint) {
        hint.textContent = n
          ? '已选中 ' + n + ' 项 · 按 Delete 或点「删除选中」移除（Esc 取消选择）'
          : '拖素材到下方时间轴 · 双击图片作参考';
      }
    },
    paintSelection() {
      document.querySelectorAll('#asset-list .asset-item').forEach(el => {
        el.classList.toggle('selected', A.selected.has(el.dataset.key));
      });
    },
    /* 单击选择：普通=单选，Ctrl/Cmd=切换，Shift=按显示顺序范围选择 */
    pick(it, e) {
      const key = A.keyOf(it);
      if (e.shiftKey && A._lastKey && A._order.indexOf(A._lastKey) >= 0) {
        const a = A._order.indexOf(A._lastKey), b = A._order.indexOf(key);
        A._order.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(k => A.selected.add(k));
      } else if (e.ctrlKey || e.metaKey) {
        if (A.selected.has(key)) A.selected.delete(key); else A.selected.add(key);
        A._lastKey = key;
      } else {
        A.selected.clear(); A.selected.add(key); A._lastKey = key;
      }
      A.paintSelection();
      A.syncSelBar();
    },
    clearSelection() {
      if (!A.selected.size) return;
      A.selected.clear(); A._lastKey = null;
      A.paintSelection(); A.syncSelBar();
    },
    /* M-14：批量删除同样二次确认（与单条 ✕ 同一套：按钮 3 秒内再点一次才执行） */
    removeSelected() {
      const items = A.selectedItems();
      if (!items.length) return;
      if (A._delArm !== 'batch') {
        A._delArm = 'batch';
        clearTimeout(A._delTimer);
        A._delTimer = setTimeout(() => { A._delArm = null; A.syncSelBar(); }, 3000);
        A.syncSelBar();
        MTG.toast('再点一次「删除选中」确认（共 ' + items.length + ' 项，工程内副本移入回收站）');
        return;
      }
      A._delArm = null;
      A.syncSelBar();
      return A.removeItems(items);
    },

    /* 移除条目（批量）：从工程清单删条目 + 连带引用片段 + 工程内磁盘副本移入回收站。
       之所以要删磁盘副本：这些文件是导入时复制进工程 assets/ 的托管副本，
       不删的话「扫描」会把它们当成新素材重新补录（用户反馈：删了又回来）。 */
    async removeItems(items, opts) {
      const p = MTG.state.project;
      const list = (items || []).filter(Boolean);
      if (!p || !list.length) return;
      const ids = new Set(list.map(i => i.id));

      /* 分镜帧：删条目/片段之外，还要清洋葱皮与缩略图 */
      for (const it of list) {
        if (it.type !== 'board') continue;
        MTG.board.onionCache.delete(it.id);
        MTG.board.dropThumb(it.id);
        if (MTG.state.currentBoardId === it.id) MTG.board.unload();
      }
      list.forEach(it => {
        A.dropUrl(it.id);
        A.selected.delete(A.keyOf(it));
        if (MTG.audio && MTG.audio.cache) MTG.audio.cache.delete(it.id);
      });
      p.boards = (p.boards || []).filter(b => !ids.has(b.id));
      p.assets = (p.assets || []).filter(a => !ids.has(a.id));
      const before = (p.clips || []).length;
      p.clips = (p.clips || []).filter(c =>
        !(c.boardId && ids.has(c.boardId)) && !(c.assetId && ids.has(c.assetId)));
      const clipsRemoved = before - p.clips.length;
      if (A._lastKey && A._order.indexOf(A._lastKey) >= 0 && !A.allItems().some(i => A.keyOf(i) === A._lastKey)) A._lastKey = null;

      MTG.markDirty();
      MTG.render();
      /* 播放中删除素材/片段：音频调度重排（被删的声不应继续） */
      if (MTG.audio && MTG.audio.rescheduleIfPlaying) MTG.audio.rescheduleIfPlaying();

      /* 磁盘副本：与保留条目同 path 的不删（防御同文件被多条引用） */
      const stillUsed = new Set();
      (p.boards || []).forEach(b => b.path && stillUsed.add(b.path));
      (p.assets || []).forEach(a => a.path && stillUsed.add(a.path));
      const delPaths = [...new Set(list.map(i => i.path).filter(Boolean))].filter(x => !stillUsed.has(x));
      let diskFailed = 0;
      for (const rel of delPaths) {
        const ok = await MTG.storage.trashFile(rel).catch(() => false);
        if (!ok) diskFailed++;
      }
      /* 主进程 fabula.json 的素材清单同步移除（否则 MCP / 导入记录里还留着） */
      const F = window.fabula && window.fabula.assets;
      if (F && F.remove && delPaths.length) {
        try { await F.remove(delPaths); } catch (e) { console.warn('[assets] 主进程清单同步失败', e); }
      }
      /* silent：调用方（如删镜头）自己有信息更全的提示，避免两条 toast 互相覆盖（R5-21） */
      if (!(opts && opts.silent)) {
        MTG.toast('已移除 ' + list.length + ' 项'
          + (clipsRemoved ? '，同时移除 ' + clipsRemoved + ' 个引用片段' : '')
          + (diskFailed ? '（' + diskFailed + ' 个磁盘文件删除失败）' : ''));
      }
    },

    /* 分组重命名（双击组头 / ✎ 按钮 / 编辑被打断后的恢复，统一走这里）。
       加固要点（用户两轮反馈"重命名没用"后的收敛）：
       1) 入口不唯一：双击必须精确命中 .g-name 太苛刻 —— 组头整行委托双击 + ✎ 显式按钮；
       2) IME：组合期间不提交（回车是"上屏"不是"确认"）；compositionend 后延迟一拍再读
          input.value（部分 IME 在该事件之后才把文本落进 value，立即读会拿到旧值）；
       3) 抗打断：编辑期间任何外部 MTG.render() 会整体重建素材库 —— 通过 _renaming
          记录草稿，render 尾部自动恢复编辑态（否则打字打到一半输入框消失 = "没用"）。 */
    renameGroup(s, nm, draft) {
      if (!s || !s.id || !nm) return;
      if (nm.querySelector('.g-rename')) return;      // 已在编辑态
      const input = document.createElement('input');
      input.value = draft != null ? draft : s.name;
      input.className = 'g-rename';
      nm.textContent = '';
      nm.appendChild(input);
      A._renaming = { gid: s.id, draft: input.value };
      let done = false, composing = false, enterDuringCompose = false;
      const commit = (cancel, delayed) => {
        if (done) return;
        if (delayed) { setTimeout(() => commit(cancel), 0); return; }   // 等 IME 把文本落进 value
        done = true;
        A._renaming = null;
        const v = cancel ? s.name : input.value.trim();
        if (!cancel && v && v !== s.name) {
          const p0 = MTG.state.project;
          const t = p0 && p0.groups.find(x => x.id === s.id);
          if (t) t.name = v;
          MTG.markDirty();
          MTG.toast('分组已重命名为「' + v + '」');
        }
        A.render();
      };
      input.oninput = () => { if (A._renaming && A._renaming.gid === s.id) A._renaming.draft = input.value; };
      input.onblur = () => {
        /* 外部重渲染（box.innerHTML=''）移除聚焦元素也会派发 blur —— 实测派发时机
           早于元素脱离文档（此刻 isConnected 仍为 true），若立即提交会把草稿当成
           "用户确认"、并让 render 尾部的编辑恢复失效（用户反馈"重命名没用"的隐藏源头）。
           延迟一拍再判定：元素仍在文档 = 用户主动失焦（提交）；已脱离 = 编辑被打断
           （跳过，由 render 尾部恢复编辑态与草稿）。 */
        setTimeout(() => { if (input.isConnected) commit(false); }, 0);
      };
      input.addEventListener('compositionstart', () => { composing = true; });
      input.addEventListener('compositionend', () => {
        composing = false;
        if (enterDuringCompose) { enterDuringCompose = false; commit(false, true); }
      });
      input.addEventListener('keydown', e2 => {
        if (composing || e2.isComposing || e2.keyCode === 229) {   // IME 组合中：交还输入法
          if (e2.key === 'Enter') enterDuringCompose = true;
          return;
        }
        if (e2.key === 'Enter') { e2.preventDefault(); commit(false); }
        if (e2.key === 'Escape') { e2.preventDefault(); commit(true); }
      });
      /* 聚焦双保险：双击的默认行为 / 外部 render 可能抢走焦点 */
      const focusIt = () => {
        if (done || document.activeElement === input) return;
        try { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
      };
      requestAnimationFrame(focusIt);
      setTimeout(focusIt, 80);
    },

    groupHead(s, count) {
      const head = document.createElement('div');
      head.className = 'group-head' + (s.id ? '' : ' ungrouped');
      head.dataset.gid = s.id == null ? '' : s.id;

      const fold = document.createElement('button');
      fold.className = 'g-fold';
      fold.textContent = A.collapsed.has(s.id) ? '▸' : '▾';
      fold.onclick = e => {
        e.stopPropagation();
        if (A.collapsed.has(s.id)) A.collapsed.delete(s.id); else A.collapsed.add(s.id);
        A.render();
      };

      const nm = document.createElement('span');
      nm.className = 'g-name';
      nm.textContent = s.name;
      if (s.id) nm.title = '双击重命名';      // 低项：未分组不可重命名，别给误导提示
      if (s.id) {
        /* 双击入口放在整行组头：只认 .g-name 太苛刻（双击落在计数/空隙上就毫无反应，
           用户两轮反馈"重命名没用"）。✎ 按钮是显式入口（系统双击速度慢/触控板也可靠）。 */
        head.addEventListener('dblclick', ev => {
          if (ev.target.closest && ev.target.closest('.g-fold, .g-x, .g-rename-btn, .g-rename')) return;
          A.renameGroup(s, nm);
        });
      }

      const cnt = document.createElement('span');
      cnt.className = 'g-count';
      cnt.textContent = count;

      head.appendChild(fold); head.appendChild(nm); head.appendChild(cnt);

      if (s.id) {
        const rn = document.createElement('button');
        rn.className = 'g-rename-btn';
        rn.textContent = '✎';
        rn.title = '重命名分组（也可以双击组名）';
        rn.onclick = e => { e.stopPropagation(); A.renameGroup(s, nm); };
        rn.addEventListener('mousedown', e => e.stopPropagation());
        head.appendChild(rn);

        const del = document.createElement('button');
        del.className = 'g-x';
        del.textContent = '✕';
        del.title = '删除分组（素材回到未分组）';
        del.onclick = e => {
          e.stopPropagation();
          const p = MTG.state.project;
          p.groups = p.groups.filter(g => g.id !== s.id);
          (p.boards || []).forEach(b => { if (b.group === s.id) b.group = null; });
          (p.assets || []).forEach(a => { if (a.group === s.id) a.group = null; });
          A.collapsed.delete(s.id);
          MTG.markDirty();
          A.render();
        };
        head.appendChild(del);
      }

      /* 条目拖到组头上 = 归入该组 */
      head.addEventListener('dragover', e => { e.preventDefault(); head.classList.add('drop-target'); });
      head.addEventListener('dragleave', () => head.classList.remove('drop-target'));
      head.addEventListener('drop', e => {
        e.preventDefault();
        e.stopPropagation();
        head.classList.remove('drop-target');
        const data = (e.dataTransfer.getData('text/plain') || '').split(':');
        if (data[0] !== 'board' && data[0] !== 'image' && data[0] !== 'audio') return;
        A.assignGroup(data[0], data[1], s.id);
      });
      return head;
    },

    assignGroup(kind, id, gid) {
      const p = MTG.state.project;
      if (!p) return;
      if (kind === 'board') {
        const b = p.boards.find(x => x.id === id);
        if (b) b.group = gid;
      } else {
        const a = p.assets.find(x => x.id === id);
        if (a) a.group = gid;
      }
      MTG.markDirty();
      A.render();
    },

    async item(it) {
      const el = document.createElement('div');
      el.className = 'asset-item';
      el.draggable = true;
      el.dataset.id = it.id;
      el.dataset.kind = it.kind;
      el.dataset.key = A.keyOf(it);
      if (A.selected.has(el.dataset.key)) el.classList.add('selected');

      const th = document.createElement('div');
      th.className = 'asset-thumb';
      if (it.kind === 'image' || it.kind === 'board') {
        const url = await A.thumb(it);
        if (url) { const im = document.createElement('img'); im.src = url; th.appendChild(im); }
        else th.textContent = '▣';
      } else {
        th.textContent = '♪';
      }

      const info = document.createElement('div');
      info.className = 'asset-info';
      const nm = document.createElement('div');
      nm.className = 'asset-name';
      nm.textContent = it.name;
      const sub = document.createElement('div');
      sub.className = 'asset-sub';
      if (it.kind === 'audio') {
        const d = MTG.audio.durationOf(it.id);
        sub.textContent = d ? U.tc(d) : '音频';
      } else {
        sub.textContent = it.kind === 'board' ? '分镜帧' : '图片';
      }
      info.appendChild(nm); info.appendChild(sub);

      const del = document.createElement('button');
      del.className = 'asset-del';
      del.textContent = '✕';
      del.title = '从工程移除（工程内副本移入回收站，引用片段一并移除）';
      del.onclick = async ev => {
        ev.stopPropagation();
        /* M-14：破坏性操作（连带删磁盘副本）先二次确认 —— 第一次点击进入确认态 */
        const key = A.keyOf(it);
        if (A._delArm !== key) {
          A._delArm = key;
          clearTimeout(A._delTimer);
          A._delTimer = setTimeout(() => { A._delArm = null; del.classList.remove('armed'); del.textContent = '✕'; }, 3000);
          del.classList.add('armed');
          del.textContent = '确认';
          MTG.toast('再点一次确认移除（工程内副本移入回收站）');
          return;
        }
        A._delArm = null;
        clearTimeout(A._delTimer);
        del.disabled = true;                 // 防连点重复提交（移除是异步的）
        try { await A.removeItems([it]); }
        catch (err) {                        // R5-20：失败必须复位按钮，否则 ✕ 永久灰掉
          del.disabled = false;
          MTG.toast('移除失败：' + ((err && err.message) || err), true);
        }
      };
      /* 删除按钮上按下鼠标不触发条目的选择逻辑 */
      del.addEventListener('mousedown', ev => ev.stopPropagation());

      el.appendChild(th); el.appendChild(info); el.appendChild(del);

      el.addEventListener('click', e => A.pick(it, e));
      el.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', it.kind + ':' + it.id);
        e.dataTransfer.effectAllowed = 'copyMove';
      });
      el.addEventListener('dblclick', async () => {
        if (it.kind === 'image') await MTG.board.loadAssetImage(it);
        else if (it.kind === 'board') {
          // 预览模型：把播放头移到该帧所在片段，画板自然切过去
          const c = MTG.state.project.clips.find(x => x.boardId === it.id);
          if (c) MTG.setPlayhead(c.start + 0.001);
          else MTG.toast('这一帧还没放到时间轴上');
        }
        else if (it.kind === 'audio') {
          A.addAudioAtPlayhead(it);
        }
      });
      return el;
    },

    async thumb(it) {
      if (A.urlCache.has(it.id)) return A.urlCache.get(it.id);
      if (!MTG.storage.ready) return null;
      const blob = await MTG.storage.readBlob(it.path);
      if (!blob) return null;
      const u = URL.createObjectURL(blob);
      A.urlCache.set(it.id, u);
      return u;
    },

    /* 换工程（或素材被移除）时释放 blob URL，避免旧内存常驻 */
    dropUrl(id) {
      const u = A.urlCache.get(id);
      if (u) { URL.revokeObjectURL(u); A.urlCache.delete(id); }
    },
    resetCaches() {
      A.urlCache.forEach(u => URL.revokeObjectURL(u));
      A.urlCache.clear();
      A.collapsed.clear();
      A.selected.clear();
      A._order = [];
      A._lastKey = null;
      A._rt++;                       // 作废在途 render（切工程时旧结果的 append 必须停）
      A._delArm = null;
      clearTimeout(A._delTimer);
      A.syncSelBar();
    },

    async addAudioAtPlayhead(asset) {
      const p = MTG.state.project;
      if (!p) return;
      /* 未解码则先解码：durationOf 未命中会回退 5 秒占位、波形空白；
         与拖放上轨路径（先解码再定时长）一致（M-18） */
      if (!MTG.audio.durationOf(asset.id) && MTG.storage.ready) {
        const blob = await MTG.storage.readBlob(asset.path);
        if (blob) { try { await MTG.audio.load(asset.id, blob); } catch (e) { console.warn('[assets] 音频解码失败', asset.name, e); } }
      }
      /* 低项：没有音频轨时此前落到分镜轨（片段再也拖不回来）—— 自动建一条音频轨 */
      let track = p.tracks.find(t => t.kind === 'audio');
      if (!track) {
        track = { id: U.uid('tr'), name: '音频 A' + (p.tracks.length + 1), kind: 'audio', h: 62, muted: false };
        p.tracks.push(track);
      }
      let dur = MTG.audio.durationOf(asset.id) || 5;
      const start = Math.max(0, MTG.state.playhead);
      const moved = MTG.timeline.makeRoom(track.id, start, dur);   // 同轨不重叠
      const clip = {
        id: U.uid('cl'), trackId: track.id, kind: 'audio', assetId: asset.id,
        name: asset.name, start, dur, offset: 0, gain: 1
      };
      p.clips.push(clip);
      MTG.state.selectedClipIds = new Set([clip.id]);
      MTG.timeline.render();
      MTG.markDirty();
      /* 播放中上轨：立即发声（PR 语义） */
      if (MTG.audio && MTG.audio.rescheduleIfPlaying) MTG.audio.rescheduleIfPlaying();
      MTG.toast('已把音频放到播放头：' + asset.name + (moved ? '，顺推 ' + moved + ' 个片段' : ''));
    },

    /* ── 导入 ── */
    async importFiles(fileList) {
      const p = MTG.state.project;
      if (!p || !MTG.storage.ready) { MTG.toast('请先打开工程文件夹', true); return; }
      let n = 0;
      for (const f of Array.from(fileList)) {
        const kind = U.kindOf(f.name);
        if (kind === 'other') { MTG.toast('跳过不支持的文件：' + f.name, true); continue; }
        /* 低项：落盘文件名净化，与主进程导入（projectStore.importAssets）同一规则 */
        const path = 'assets/' + kind + '/' + U.safeFileName(f.name);
        await MTG.storage.writeFile(path, f);
        const exist = p.assets.find(a => a.path === path);
        if (exist) {
          /* 同名导入 = 覆盖磁盘文件：旧缩略图 / 波形缓存必须作废，否则界面显示旧内容（M-19） */
          A.dropUrl(exist.id);
          MTG.audio.cache.delete(exist.id);
        } else {
          p.assets.push({ id: U.uid('as'), name: f.name, kind, path, group: null });
        }
        n++;
      }
      if (n) {
        MTG.markDirty();
        MTG.toast('已导入 ' + n + ' 个素材');
        await A.render();
        await MTG.audio.ensureLoaded(p.clips);
        /* H-9：同名覆盖导入时磁盘文件已换 —— 时间轴波形/缩略图要重画 */
        if (MTG.timeline && MTG.timeline.render) MTG.timeline.render();
      }
    },

    /* 精确补录主进程刚导入的文件（替代导入后的全盘 rescan）：
       只把本次复制进工程的路径入列——工程 assets/ 里的历史遗留文件
       不会跟着冒出来（用户反馈：导入一个文件却出现两条）。 */
    async mergeImported(paths) {
      const p = MTG.state.project;
      const list = (paths || []).map(x => String(x || '').replace(/\\/g, '/')).filter(Boolean);
      if (!p || !list.length) return 0;
      let n = 0, refreshed = 0;
      for (const rel of list) {
        const exist = p.assets.find(a => a.path === rel);
        if (exist) {
          /* 同名覆盖导入：磁盘文件已换新 → 缩略图/音频缓存作废，待会重新解码（H-9） */
          A.dropUrl(exist.id);
          if (MTG.audio && MTG.audio.cache) MTG.audio.cache.delete(exist.id);
          refreshed++;
          continue;
        }
        const kind = U.kindOf(rel);
        if (kind === 'other') continue;
        p.assets.push({ id: U.uid('as'), name: rel.split('/').pop(), kind, path: rel, group: null });
        n++;
      }
      if (n) MTG.markDirty();
      if (n || refreshed) {
        await A.render();
        await MTG.audio.ensureLoaded(p.clips);
        if (MTG.timeline && MTG.timeline.render) MTG.timeline.render();   // 波形/缩略图重画
      }
      return n;
    },

    /* 扫描工程文件夹：把磁盘上有、工程里没有的文件补进来 */
    async rescan() {
      const p = MTG.state.project;
      if (!p || !MTG.storage.ready) { MTG.toast('请先打开工程文件夹', true); return; }
      const files = await MTG.storage.listMedia();
      let n = 0;
      for (const f of files) {
        if (p.assets.some(a => a.path === f.path)) continue;
        p.assets.push({ id: U.uid('as'), name: f.name, kind: f.kind, path: f.path, group: null });
        n++;
      }
      /* 清理引用了但磁盘上已不存在的文件；引用它们的片段一并清掉，
         否则时间轴留下悬空片段（M-20） */
      const keep = new Set(files.map(f => f.path));
      const removed = new Set();
      p.assets = p.assets.filter(a => { if (keep.has(a.path)) return true; removed.add(a.id); return false; });
      if (removed.size) {
        p.clips = p.clips.filter(c => !(c.assetId && removed.has(c.assetId)));
        removed.forEach(id => { A.dropUrl(id); MTG.audio.cache.delete(id); });
      }
      MTG.markDirty();
      MTG.toast(n ? '扫描完成，新增 ' + n + ' 个素材' : '扫描完成，没有新素材');
      await A.render();
      await MTG.audio.ensureLoaded(p.clips);
    }
  });
})();
