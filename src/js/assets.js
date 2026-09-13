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

    /* 收集全部条目：分镜帧 + 素材，统一形状 */
    allItems() {
      const p = MTG.state.project;
      if (!p) return [];
      const boards = (p.boards || []).map(b => ({ type: 'board', id: b.id, name: b.name, path: b.path, kind: 'board', group: b.group == null ? null : b.group }));
      const assets = (p.assets || []).map(a => Object.assign({ type: 'asset', group: a.group == null ? null : a.group }, a));
      return boards.concat(assets);
    },

    async render() {
      const box = document.getElementById('asset-list');
      const p = MTG.state.project;
      if (!box) return;
      box.innerHTML = '';
      if (!p) {
        box.innerHTML = '<div class="empty-note">未打开工程<br>点左上「打开文件夹」<br>选择（或新建）工程文件夹</div>';
        return;
      }
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
      if (rest.length || !sections.length) sections.push({ id: null, name: '未分组', list: rest, fixed: true });

      let any = false;
      for (const s of sections) {
        if (!s.list.length && !s.id) continue;           // 空的「未分组」不显示
        any = true;
        box.appendChild(A.groupHead(s, s.list.length));
        if (A.collapsed.has(s.id)) continue;
        const wrap = document.createElement('div');
        wrap.className = 'group-items';
        wrap.dataset.gid = s.id == null ? '' : s.id;
        for (const it of s.list) wrap.appendChild(await A.item(it));
        if (!s.list.length) wrap.innerHTML = '<div class="group-empty">空分组 · 把条目拖到这里</div>';
        box.appendChild(wrap);
      }
      if (!any) box.innerHTML = '<div class="empty-note">还没有素材<br>点「导入」添加，或「新建帧」开始分镜</div>';
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
      nm.title = '双击重命名';
      nm.ondblclick = () => {
        const input = document.createElement('input');
        input.value = s.name;
        input.className = 'g-rename';
        nm.textContent = '';
        nm.appendChild(input);
        input.focus(); input.select();
        const commit = () => {
          const v = input.value.trim();
          if (v && s.id) {
            const g = MTG.state.project.groups.find(x => x.id === s.id);
            if (g) { g.name = v; MTG.markDirty(); }
          }
          A.render();
        };
        input.onblur = commit;
        input.onkeydown = ev => { if (ev.key === 'Enter') input.blur(); if (ev.key === 'Escape') { input.value = s.name; input.blur(); } };
      };

      const cnt = document.createElement('span');
      cnt.className = 'g-count';
      cnt.textContent = count;

      head.appendChild(fold); head.appendChild(nm); head.appendChild(cnt);

      if (s.id) {
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
      del.title = '从工程移除（磁盘文件保留）';
      del.onclick = async ev => {
        ev.stopPropagation();
        if (it.type === 'board') {
          MTG.state.project.boards = MTG.state.project.boards.filter(b => b.id !== it.id);
          MTG.state.project.clips = MTG.state.project.clips.filter(c => c.boardId !== it.id);
          await MTG.storage.deleteFile(it.path);
          MTG.board.onionCache.delete(it.id);
          MTG.board.dropThumb(it.id);
          if (MTG.state.currentBoardId === it.id) MTG.board.unload();   // 删的正是正在编辑的帧
        } else {
          MTG.state.project.assets = MTG.state.project.assets.filter(a => a.id !== it.id);
          MTG.state.project.clips = MTG.state.project.clips.filter(c => c.assetId !== it.id);
        }
        A.dropUrl(it.id);
        MTG.markDirty();
        MTG.render();
      };

      el.appendChild(th); el.appendChild(info); el.appendChild(del);

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
      const track = p.tracks.find(t => t.kind === 'audio') || p.tracks[0];
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
        const path = 'assets/' + kind + '/' + f.name;
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
      }
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
