/* app.js · 装配与交互
   把存储 / 时间轴 / 画板 / 素材库 / 播放引擎接到一起，处理顶栏、快捷键、分割条与面板同步。 */
(function () {
  'use strict';
  const MTG = window.MTG;
  const U = MTG.util;
  const $ = id => document.getElementById(id);

  /* ══════════ 全局渲染 ══════════ */
  MTG.render = function () {
    MTG.timeline.render();
    MTG.assets.render();
    MTG.ui.syncBoardMeta();
    MTG.ui.syncProject();
    MTG.board.syncToPlayhead().catch(e => console.warn('[board] 切帧失败', e));
    if (MTG.sheet && MTG.sheet.active) MTG.sheet.render();
    if (MTG.story && MTG.story.active) MTG.story.render();
  };

  MTG.setPlayhead = function (t, keepPlaying) {
    MTG.state.playhead = Math.max(0, t);
    MTG.timeline.updatePlayhead();
    $('timecode').textContent = U.tc(MTG.state.playhead);
    if (!keepPlaying) MTG.ui.syncBoardMeta();   // 播放中避免每帧重绘面板
    if (!keepPlaying && MTG.audio.playing) MTG.audio.pause();
    // 画板即预览器：播放头落在不同帧上时自动切帧
    MTG.board.syncToPlayhead().catch(e => console.warn('[board] 切帧失败', e));
  };

  /* ══════════ UI 同步 ══════════ */
  MTG.ui = {
    onPlayState(on) {
      const b = $('btn-play');
      b.innerHTML = on
        ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6.5" y="4.5" width="3.6" height="15" rx="1"/><rect x="13.9" y="4.5" width="3.6" height="15" rx="1"/></svg>'
        : '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg>';
      b.classList.toggle('on', on);
    },
    syncProject() {
      const p = MTG.state.project;
      const d = MTG.storage.describe();
      $('proj-name').textContent = p ? p.name : '未打开工程';
      $('proj-mode').textContent = d.tag;
      $('proj-mode').title = d.bin === 'disk'
        ? '工程文件 montage.json 在文件夹内，素材原地存放，浏览器不存任何缓存'
        : '点「打开工程文件夹」：选择一个文件夹，有 montage.json 就打开，没有就新建工程';
    },
    syncColor(hex) {
      MTG.state.color = hex;
      $('swatch').style.background = hex;
      const hsv = MTG.state.hsv;
      $('f-h').value = hsv.h; $('f-s').value = hsv.s; $('f-v').value = hsv.v;
      if (document.activeElement !== $('f-hex')) $('f-hex').value = hex;
    },
    syncHistory() {
      $('btn-undo').disabled = !MTG.board.undoStack.length;
      $('btn-redo').disabled = !MTG.board.redoStack.length;
    },
    syncBoardMeta() {
      const p = MTG.state.project, st = MTG.state;
      const hint = $('board-empty');
      if (!hint) return;
      if (!p) {
        hint.style.display = '';
        hint.textContent = '未打开工程 —— 点左上「打开工程文件夹」';
        if (MTG.board.setIdle) MTG.board.setIdle(true);        // 画板置灰：光标提示不可画
        MTG.ui.syncShotPanel();
        return;
      }
      const b = MTG.findBoard(st.currentBoardId);
      if (MTG.board.setIdle) MTG.board.setIdle(!b);
      hint.style.display = b ? 'none' : '';
      const s = MTG.board.shotAt(st.playhead);
      hint.textContent = s && !s.boardId
        ? '空镜头 —— 点工具条「新建帧」为它补画面'
        : (p.boards.length ? '播放头停在片段之外' : '还没有分镜帧 —— 点「新建帧」开始');
      MTG.board.syncCursor();
      MTG.ui.syncShotPanel();
    },

    /* 时间轴视图里的「镜头信息」面板：编辑播放头所在镜头的字段（与分镜表同一份 meta） */
    syncShotPanel() {
      const box = $('shot-panel');
      const hint = $('shot-panel-hint');
      if (!box) return;
      const p = MTG.state.project;
      const shot = p ? MTG.board.shotAt(MTG.state.playhead) : null;
      const id = shot ? shot.id : null;
      if (!shot || id !== MTG.ui._panelShotId || !box.children.length) {
        MTG.ui._panelShotId = id;
        if (MTG.tagMenu) MTG.tagMenu.close();     // 重建前收起标签面板
        box.innerHTML = '';
        if (!shot) { if (hint) hint.textContent = '播放头不在任何镜头上'; return; }
        MTG.SHOT_FIELDS.forEach(f => {
          const row = document.createElement('div');
          row.className = 'shot-field';
          const lb = document.createElement('span');
          lb.textContent = f.title;
          row.appendChild(lb);
          const holder = document.createElement('div');
          holder.dataset.key = f.key;
          const el = MTG.metaControl(shot, f, v => {
            shot.meta = shot.meta || {};
            shot.meta[f.key] = v;
            MTG.markDirty();
            if (MTG.timeline.el.tracks) MTG.timeline.render();
          });
          el.className = 'sp-ctl';
          holder.appendChild(el);
          row.appendChild(holder);
          box.appendChild(row);
        });
      }
      // 只更新值、不重建控件，避免打字时焦点丢失
      box.querySelectorAll('[data-key]').forEach(holder => {
        const el = holder.firstChild;
        if (!el) return;
        const v = (shot && shot.meta && shot.meta[holder.dataset.key]) || '';
        if (document.activeElement !== el) el.value = v;
      });
      if (hint) hint.textContent = '';
    },
    syncRef() {
      const el = $('ref-show');
      if (el) el.checked = MTG.board.showRef;
    },

    /* ── 笔刷 ── */
    buildBrushUI() {
      const box = $('brush-list');
      if (!box || !MTG.brushes) return;
      box.innerHTML = '';
      MTG.brushes.list.forEach(b => {
        const el = document.createElement('button');
        el.className = 'brush-chip' + (b.id === MTG.board.brushId ? ' active' : '');
        el.dataset.brush = b.id;
        el.title = b.label;
        el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" '
          + 'stroke-linecap="round" stroke-linejoin="round">' + (b.icon || '') + '</svg><span>' + b.label + '</span>';
        el.onclick = () => MTG.ui.setBrush(b.id);
        box.appendChild(el);
      });
      MTG.ui.syncBrushUI();
    },
    /* 笔刷选中态：右侧笔刷条 + 工具栏笔刷按钮（引擎侧切笔也会回掉到这里） */
    syncBrushUI() {
      const cur = MTG.board.brushId;
      const box = $('brush-list');
      if (box) box.querySelectorAll('.brush-chip').forEach(el => el.classList.toggle('active', el.dataset.brush === cur));
      document.querySelectorAll('.tool[data-brush]').forEach(b => b.classList.toggle('active', b.dataset.brush === cur));
    },
    setBrush(id) {
      MTG.board.setBrush(id);
      MTG.ui.buildBrushUI();
      MTG.ui.buildBrushParams();
      MTG.ui.syncBrushSliders();
      setTool('brush');
    },
    /* 各笔刷自带的额外参数（大小/不透明走已有的两个滑杆） */
    buildBrushParams() {
      const box = $('brush-params');
      if (!box || !MTG.brushes) return;
      box.innerHTML = '';
      const eng = MTG.board.engine();
      if (!eng) return;
      ['flow', 'hardness', 'grain', 'scatter'].forEach(key => {
        if (eng.params.indexOf(key) < 0) return;
        const meta = MTG.brushes.paramMeta[key];
        const row = document.createElement('div');
        row.className = 'slider-row';
        const lb = document.createElement('label');
        lb.textContent = meta.label;
        const inp = document.createElement('input');
        inp.type = 'range';
        inp.min = meta.min; inp.max = meta.max; inp.step = meta.step;
        inp.value = Math.round((MTG.board.bp[key] || 0) * 100);
        const val = document.createElement('span');
        val.textContent = inp.value;
        inp.oninput = () => {
          MTG.board.bp[key] = (+inp.value) / 100;
          val.textContent = inp.value;
          MTG.brushes.saveParams(MTG.board.brushId, MTG.board.bp);
        };
        row.appendChild(lb); row.appendChild(inp); row.appendChild(val);
        box.appendChild(row);
      });
    },
    syncBrushSliders() {
      const bp = MTG.board.bp;
      if (!bp) return;
      [['b-size', 'size'], ['b-opacity', 'opacity']].forEach(([id, key]) => {
        const el = $(id);
        if (!el) return;
        el.value = Math.round(bp[key]);
        const s = $(id + '-v');
        if (s) s.textContent = el.value;
      });
    },

    /* ── 套索选区 ── */
    syncSel() {
      const blk = $('sel-block');
      if (blk) blk.classList.toggle('hidden', !(MTG.board.sel && MTG.board.sel.path));
    },
    /* 切换工作台：时间轴 ⇄ 分镜表（同一份工程数据，只换渲染形态） */
    setView(v) {
      document.getElementById('view-timeline').classList.toggle('hidden', v !== 'timeline');
      document.getElementById('view-sheet').classList.toggle('hidden', v !== 'sheet');
      document.getElementById('view-story').classList.toggle('hidden', v !== 'story');
      MTG.sheet.active = v === 'sheet';
      MTG.story.active = v === 'story';
      if (v === 'sheet') MTG.sheet.render();
      else if (v === 'story') MTG.story.render();
      else MTG.timeline.render();
      const grp = document.getElementById('view-switch');
      if (grp) grp.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === v));
      /* 画板从隐藏切回：引擎的画布尺寸取自 clientWidth，隐藏期间没法量。
         回到时间轴视图时补一次尺寸重建；画布此前从未量过（首个显示帧）才顺带适配窗口。 */
      if (v === 'timeline') {
        requestAnimationFrame(() => {
          const glc = document.getElementById('gl');
          const neverSized = !glc || glc.width <= 1;
          window.dispatchEvent(new Event('resize'));
          if (neverSized && MTG.board && MTG.board.fitView) MTG.board.fitView();
        });
      }
    }
  };

  /* ══════════ 工程打开 / 保存 ══════════ */
  async function openFolder() {
    const mode = await MTG.storage.openFolder();
    if (!mode) return;
    // 切换工程：先把上一个工程的缓存（blob URL / 洋葱皮 / 缩略图）全部释放
    MTG.board.resetCaches();
    MTG.assets.resetCaches();
    let proj = await MTG.storage.loadProject();
    if (!proj) {
      proj = MTG.newProject(MTG.storage.dirName);
      await MTG.storage.saveProject(proj);
      MTG.toast('已在「' + MTG.storage.dirName + '」创建新工程');
    } else {
      MTG.toast('已打开工程：' + proj.name);
    }
    MTG.migrateProject(proj);
    MTG.state.selectedClipIds = new Set();
    MTG.state.playhead = 0;
    MTG.state.project = proj;
    await applyProject();
    await MTG.assets.rescan();
    MTG.render();
  }

  async function applyProject() {
    await MTG.audio.ensureLoaded(MTG.state.project.clips);
    MTG.board.applySize(MTG.state.project.boardW, MTG.state.project.boardH);
    MTG.board.fitView();
    syncBoardSize();
    MTG.board.unload();
    // 刚打开工程时把播放头停在第一个分镜帧上，避免画板一片空白
    const first = MTG.board.orderedBoardClips()[0];
    if (first && MTG.state.playhead < first.start) MTG.state.playhead = first.start + 0.001;
    await MTG.board.syncToPlayhead();
  }

  const autosave = U.debounce(async () => {
    if (MTG.board.dirty) await MTG.board.flush();
    if (MTG.state.dirty && MTG.storage.ready && MTG.state.project) {
      await MTG.storage.saveProject(MTG.state.project);
      MTG.ui.syncProject();
    }
  }, 4000);
  const origMark = MTG.markDirty;
  MTG.markDirty = function () { origMark(); autosave(); };

  /* ══════════ 事件绑定 ══════════ */
  function bind() {
    $('btn-open').onclick = openFolder;
    /* 工作台切换：时间轴 / 分镜表（用 click 而不是 select 的 change，跨环境更可靠） */
    $('view-switch').addEventListener('click', e => {
      const b = e.target && e.target.closest ? e.target.closest('[data-view]') : null;
      if (b) MTG.ui.setView(b.dataset.view);
    });
    $('btn-save').onclick = async () => {
      if (!MTG.storage.ready) { MTG.toast('请先打开工程文件夹', true); return; }
      await MTG.board.flush();                      // 画板内容先落进帧 PNG
      await MTG.storage.saveProject(MTG.state.project);
      MTG.toast('工程已保存');
    };
    $('btn-export').onclick = () => {
      const p = MTG.state.project;
      if (!p) return;
      U.download((p.name || 'montage') + '.montage.json', new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }));
      MTG.toast('已导出工程 JSON（二进制素材需随文件夹一起拷贝）');
    };

    /* 播放控制 */
    $('btn-play').onclick = () => { MTG.audio.playing ? MTG.audio.pause() : MTG.audio.play(); };
    $('btn-stop').onclick = () => MTG.audio.stop();
    $('btn-goto-start').onclick = () => MTG.setPlayhead(0);

    /* 时间轴缩放 */
    $('zoom').oninput = e => MTG.timeline.setZoom(+e.target.value);
    $('btn-zoom-in').onclick = () => MTG.timeline.setZoom(U.clamp(MTG.state.pxPerSec * 1.35, 8, 400));
    $('btn-zoom-out').onclick = () => MTG.timeline.setZoom(U.clamp(MTG.state.pxPerSec / 1.35, 8, 400));
    $('snap').onchange = e => { MTG.state.snap = e.target.checked; };

    $('btn-add-audio-track').onclick = () => MTG.timeline.addTrack('audio');
    $('btn-add-board-track').onclick = () => MTG.timeline.addTrack('board');
    $('btn-fix-overlap').onclick = () => {
      const n = MTG.timeline.fixOverlaps();
      MTG.toast(n ? '已顺推整理 ' + n + ' 处重叠' : '没有重叠片段');
    };

    /* 素材库 */
    $('btn-import-media').onclick = () => $('file-media').click();
    $('file-media').onchange = async e => {
      await MTG.assets.importFiles(e.target.files);
      e.target.value = '';
    };
    $('btn-rescan').onclick = () => MTG.assets.rescan();
    $('btn-add-group').onclick = () => {
      const p = MTG.state.project;
      if (!p) { MTG.toast('请先打开工程文件夹', true); return; }
      p.groups = p.groups || [];
      p.groups.push({ id: MTG.util.uid('g'), name: '新分组 ' + (p.groups.length + 1) });
      MTG.markDirty();
      MTG.assets.render();
    };
    document.querySelectorAll('.asset-filter .seg').forEach(b => {
      b.onclick = () => {
        document.querySelectorAll('.asset-filter .seg').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        MTG.assets.filter = b.dataset.kind;
        MTG.assets.render();
      };
    });

    /* 画板工具 */
    document.querySelectorAll('.tool[data-tool]').forEach(b => {
      b.onclick = () => setTool(b.dataset.tool);
    });
    /* 工具栏笔刷按钮：点选直接切到该支笔刷 */
    document.querySelectorAll('.tool[data-brush]').forEach(b => {
      b.onclick = () => MTG.ui.setBrush(b.dataset.brush);
    });
    document.querySelectorAll('.layer-switch .layer').forEach(b => {
      b.onclick = () => {
        MTG.state.layer = b.dataset.layer;
        document.querySelectorAll('.layer-switch .layer').forEach(x => x.classList.toggle('active', x === b));
      };
    });
    $('btn-undo').onclick = () => MTG.board.undo();
    $('btn-redo').onclick = () => MTG.board.redo();
    $('btn-new-board').onclick = () => MTG.board.newFrame();
    $('btn-save-board').onclick = () => MTG.board.saveFrame();
    $('sel-fill').onclick = () => MTG.board.fillSel();
    $('sel-del').onclick = () => MTG.board.deleteSel();
    $('sel-commit').onclick = () => { MTG.board.commitSel(); MTG.toast('已把选区内容落回画面'); };
    $('sel-cancel').onclick = () => { MTG.board.commitSel(); MTG.toast('已取消选区'); };
    $('btn-clear-board').onclick = () => {
      MTG.board.clearLayer(MTG.state.layer, true);
      MTG.toast('已清空当前层');
    };

    /* 笔刷参数 */
    const bindSlider = (id, key) => {
      const el = $(id);
      el.oninput = () => {
        MTG.state.brush[key] = +el.value;
        if (MTG.board.bp) {                       // 同步到当前笔刷自己的参数
          MTG.board.bp[key] = +el.value;
          MTG.brushes.saveParams(MTG.board.brushId, MTG.board.bp);
        }
        $(id + '-v').textContent = el.value;
        if (key === 'size') MTG.board.refreshRing();   // 大小滑杆 → 光标环直径即时更新
      };
    };
    bindSlider('b-size', 'size');
    bindSlider('b-opacity', 'opacity');
    bindSlider('b-pressure', 'pressure');
    $('b-pt').onchange = e => { MTG.state.brush.usePressure = e.target.checked; };

    /* 洋葱皮 */
    const onion = () => { MTG.board.preloadOnion(); MTG.board.paint(); MTG.ui.syncBoardMeta(); };
    $('onion-on').onchange = e => { MTG.board.onion.on = e.target.checked; $('btn-onion').classList.toggle('active', e.target.checked); onion(); };
    $('btn-onion').onclick = () => {
      MTG.board.onion.on = !MTG.board.onion.on;
      $('onion-on').checked = MTG.board.onion.on;
      $('btn-onion').classList.toggle('active', MTG.board.onion.on);
      onion();
    };
    const bindOnion = (id, key) => {
      const el = $(id);
      el.oninput = () => { MTG.board.onion[key] = +el.value; $(id + '-v').textContent = el.value; onion(); };
    };
    bindOnion('onion-before', 'before');
    bindOnion('onion-after', 'after');
    bindOnion('onion-opacity', 'opacity');

    /* 参考层 */
    $('ref-show').onchange = e => { MTG.board.showRef = e.target.checked; MTG.board.paint(); };
    $('ref-clear').onclick = () => MTG.board.clearRef();

    /* 画幅 */
    const sizeSel = $('board-size'), custom = $('size-custom');
    const applySize = (w2, h2) => {
      const p = MTG.state.project;
      if (!p) { MTG.toast('请先打开工程文件夹', true); return; }
      w2 = U.clamp(Math.round(w2) || 1280, 64, 4096);
      h2 = U.clamp(Math.round(h2) || 720, 64, 4096);
      if (p.boardW === w2 && p.boardH === h2) return;
      MTG.board.applySize(w2, h2);
      p.boardW = w2; p.boardH = h2;
      MTG.markDirty();
      MTG.toast('画幅已改为 ' + w2 + '×' + h2 + '，已有帧按新画幅缩放显示');
    };
    sizeSel.onchange = () => {
      if (sizeSel.value === 'custom') { custom.classList.remove('hidden'); return; }
      custom.classList.add('hidden');
      const parts = sizeSel.value.split('x');
      applySize(+parts[0], +parts[1]);
    };
    $('size-apply').onclick = () => applySize(+$('size-w').value, +$('size-h').value);

    /* 画布导航 */
    $('z-in').onclick = () => MTG.board.zoomCenter(1.25);
    $('z-out').onclick = () => MTG.board.zoomCenter(1 / 1.25);
    $('z-fit').onclick = () => MTG.board.fitView();
    $('z-100').onclick = () => MTG.board.zoom100();

    /* 拾色器字段 */
    const onField = () => {
      const h = U.clamp(+$('f-h').value || 0, 0, 360);
      const s = U.clamp(+$('f-s').value || 0, 0, 100);
      const v = U.clamp(+$('f-v').value || 0, 0, 100);
      MTG.state.hsv = { h, s, v };
      const hex = U.hsv2hex(h, s, v);
      MTG.picker.set(hex);
      MTG.ui.syncColor(hex);
    };
    ['f-h', 'f-s', 'f-v'].forEach(id => { $(id).oninput = onField; });
    $('f-hex').onchange = () => {
      let v = $('f-hex').value.trim();
      if (!/^#?[0-9a-fA-F]{6}$/.test(v)) { MTG.toast('HEX 格式不对，例：#eb684b', true); return; }
      if (!v.startsWith('#')) v = '#' + v;
      MTG.picker.set(v);
      MTG.ui.syncColor(v);
    };

    $('btn-theme').onclick = () => {
      const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
      MTG.settings.set('theme', next);      // 先存盘
      MTG.settings.apply();                 // set 只落盘：主题生效必须再走 apply（与设置面板路径一致）
      MTG.timeline.render();
    };

    /* 分割条 */
    dragSplitter($('split-v'), dx => {
      const w = U.clamp(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--assets-w')) + dx, 180, 520);
      document.documentElement.style.setProperty('--assets-w', w + 'px');
    }, true);
    /* 右侧两列也能拖宽度：工具列 / 镜头信息列
       注意方向：分割条往右拖 = 左侧变宽、右侧列变窄，所以两边都是「原宽 − dx」 */
    dragSplitter($('split-side'), dx => {
      const el = $('side-tools');
      if (el) el.style.width = U.clamp(el.getBoundingClientRect().width - dx, 190, 460) + 'px';
    }, true);
    dragSplitter($('split-shot'), dx => {
      const el = document.querySelector('.board-side.side-shot');
      if (el) el.style.width = U.clamp(el.getBoundingClientRect().width - dx, 190, 460) + 'px';
    }, true);
    dragSplitter($('split-h'), dy => {
      const h = U.clamp(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--tl-h')) - dy, 140, 560);
      document.documentElement.style.setProperty('--tl-h', h + 'px');
      MTG.timeline.render();
    }, false);

    /* 设置面板 */
    $('btn-settings').onclick = () => MTG.settings.open();

    /* 播放头跳到相邻分镜片段（上一镜 / 下一镜） */
    const stepShot = dir => {
      const list = MTG.board.orderedBoardClips ? MTG.board.orderedBoardClips() : [];
      if (!list || !list.length) { MTG.toast('时间轴上还没有分镜片段', true); return; }
      const t = MTG.state.playhead + dir * 0.001;
      let target = null;
      if (dir > 0) target = list.find(c => (c.start || 0) > t);
      else for (let i = list.length - 1; i >= 0; i--) if ((list[i].start || 0) < t) { target = list[i]; break; }
      if (!target) { MTG.toast(dir > 0 ? '已经是最后一镜' : '已经是第一镜'); return; }
      MTG.setPlayhead((target.start || 0) + 0.001);
    };

    /* 动作执行器：快捷键与轮盘菜单共用同一张表（见 js/settings.js） */
    const acts = {
      'cmd.save': () => $('btn-save').click(),
      'cmd.undo': () => MTG.board.undo(),
      'cmd.redo': () => MTG.board.redo(),
      'cmd.play': () => { MTG.audio.playing ? MTG.audio.pause() : MTG.audio.play(); },
      'cmd.home': () => MTG.setPlayhead(0),
      'cmd.prev': () => stepShot(-1),
      'cmd.next': () => stepShot(1),
      'cmd.del': () => {
        if (MTG.board.sel) MTG.board.deleteSel();          // 画板有选区 → 删选区内容
        else MTG.timeline.deleteSelected();
      },
      'cmd.fit': () => MTG.board.fitView(),
      'cmd.z100': () => MTG.board.zoom100(),
      'cmd.zoomin': () => MTG.board.zoomCenter(1.25),
      'cmd.zoomout': () => MTG.board.zoomCenter(1 / 1.25),
      'cmd.newFrame': () => MTG.board.newFrame(),
      'cmd.saveFrame': () => MTG.board.saveFrame(),
      'cmd.clear': () => MTG.board.clearLayer(MTG.state.layer, true),
      'cmd.onion': () => $('btn-onion').click(),
      'cmd.ref': () => {
        const el = $('ref-show');
        if (el) { el.checked = !el.checked; el.onchange({ target: el }); }
      },
      'cmd.theme': () => $('btn-theme').click(),
      'cmd.settings': () => MTG.settings.open(),
      'cmd.transform': () => MTG.board.startTransform(),
      'cmd.brushUp': () => stepBrush(1),
      'cmd.brushDown': () => stepBrush(-1),
      'cmd.radial': () => MTG.radial.show()
    };
    ['brush', 'eraser', 'line', 'rect', 'eyedrop', 'hand', 'zoom', 'lasso'].forEach(t => {
      acts['tool.' + t] = () => setTool(t);
    });
    (MTG.brushes ? MTG.brushes.list : []).forEach(b => {
      acts['brush.' + b.id] = () => MTG.ui.setBrush(b.id);
    });
    MTG.settings.bindActions(acts);

    /* 快捷键：表驱动，按键在设置里改 */
    document.addEventListener('keydown', e => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (MTG.story && MTG.story.sliding) return;      // 放映中按键交给故事板处理

      if (MTG.board.xf && (e.key === 'Enter' || e.key === 'Escape')) {    // 变换中：回车落位 / Esc 放弃
        e.preventDefault();
        if (e.key === 'Enter') MTG.board.xfCommit(); else MTG.board.xfCancel();
        return;
      }
      if (MTG.board.sel && (e.key === 'Enter' || e.key === 'Escape')) {   // 选区固定键：不参与自定义
        MTG.board.commitSel();
        MTG.toast(e.key === 'Enter' ? '已把选区内容落回画面' : '已取消选区');
        return;
      }

      const combo = MTG.settings.comboOf(e);
      if (!combo) return;
      const aid = MTG.settings.actionFor(combo);
      if (!aid) return;
      if (MTG.settings.isOpen()) { if (aid === 'cmd.settings') MTG.settings.close(); return; }   // 面板开着时不误触发
      e.preventDefault();

      if (aid === 'cmd.radial') { MTG.radial.show(); return; }    // 按住呼出，松手才执行
      if (aid === 'cmd.play') {                                   // 空格：按住 = 抓手，轻点 = 播放
        if (!e.repeat && !MTG.board.spaceHeld) {
          MTG.board.spaceHeld = true;
          MTG.board.spaceDownAt = Date.now();
          MTG.board.spacePanned = false;
          MTG.board.syncCursor();
        }
        return;
      }
      MTG.settings.run(aid, e);
    });

    document.addEventListener('keyup', e => {
      const combo = MTG.settings.comboOf(e);
      if (MTG.radial.open && combo === MTG.settings.get('radialKey')) { MTG.radial.close(true); return; }
      if (MTG.board.spaceHeld && combo === MTG.settings.keyOf('cmd.play')) {
        MTG.board.spaceHeld = false;
        MTG.board.syncCursor();
        if (!MTG.board.spacePanned && Date.now() - MTG.board.spaceDownAt < 260) {
          MTG.audio.playing ? MTG.audio.pause() : MTG.audio.play();
        }
        MTG.board.spacePanned = false;
      }
    });

    window.addEventListener('beforeunload', async () => {
      await MTG.board.flush();                       // 落笔先存盘，再存工程
      if (MTG.state.dirty && MTG.storage.ready) await MTG.storage.saveProject(MTG.state.project);
    });
    window.addEventListener('resize', U.debounce(() => { MTG.timeline.render(); MTG.board.fitView(); }, 150));
  }

  /* [ / ] 调笔刷大小：小笔小步、大笔大步，跟 PS 一样 */
  function stepBrush(dir) {
    const st = MTG.state;
    if (!st.currentBoardId) return;
    const cur = MTG.board.bp ? MTG.board.bp.size : st.brush.size;
    const step = cur < 10 ? 1 : cur < 40 ? 2 : cur < 100 ? 5 : 10;
    const next = U.clamp(Math.round(cur + dir * step), 1, 200);
    if (next === cur) return;
    st.brush.size = next;
    if (MTG.board.bp) {
      MTG.board.bp.size = next;
      MTG.brushes.saveParams(MTG.board.brushId, MTG.board.bp);
    }
    const el = $('b-size');
    if (el) { el.value = next; $('b-size-v').textContent = next; }
    MTG.board.refreshRing();
    MTG.toast('笔刷大小 ' + next);
  }

  /* 自动保存：按设置间隔自动落笔存盘 + 存工程；设置里改了间隔立即重排 */
  let autosaveTimer = null;
  function setupAutosave() {
    clearInterval(autosaveTimer);
    const sec = +MTG.settings.get('autosave') || 0;
    if (!sec) return;
    autosaveTimer = setInterval(async () => {
      if (!MTG.state.project) return;
      try {
        await MTG.board.flush();
        if (MTG.state.dirty && MTG.storage.ready) {
          await MTG.storage.saveProject(MTG.state.project);
          MTG.state.dirty = false;
        }
      } catch (e) {}
    }, sec * 1000);
  }

  function setTool(t) {
    // 离开套索工具时把还浮着的选区内容落回画面，避免存盘时丢失
    if (MTG.board.sel && MTG.board.sel.float && t !== 'lasso') MTG.board.commitSel();
    MTG.state.tool = t;
    document.querySelectorAll('.tool[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    MTG.board.syncCursor();
    MTG.board.refreshRing();
  }

  /* 画幅选择器与工程同步：预设匹配就选中，否则进入自定义 */
  function syncBoardSize() {
    const p = MTG.state.project;
    if (!p) return;
    const sel = $('board-size'), custom = $('size-custom');
    const v = p.boardW + 'x' + p.boardH;
    if (Array.from(sel.options).some(o => o.value === v)) {
      sel.value = v;
      custom.classList.add('hidden');
    } else {
      sel.value = 'custom';
      custom.classList.remove('hidden');
      $('size-w').value = p.boardW;
      $('size-h').value = p.boardH;
    }
  }

  /* 分割条拖动：horizontal=true 时取 dx */
  function dragSplitter(el, fn, horizontal) {
    let last = 0, on = false;
    el.addEventListener('pointerdown', e => {
      on = true; last = horizontal ? e.clientX : e.clientY;
      el.setPointerCapture(e.pointerId); el.classList.add('dragging');
    });
    el.addEventListener('pointermove', e => {
      if (!on) return;
      const cur = horizontal ? e.clientX : e.clientY;
      fn(cur - last);
      last = cur;
    });
    const up = e => {
      on = false; el.classList.remove('dragging');
      try { el.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /* ══════════ 启动 ══════════ */
  async function boot() {
    document.body.dataset.theme = MTG.state.theme;

    // v0.2 遗留清理：老版本曾把工程/素材塞进 IndexedDB，导致浏览器缓存清不掉。
    // 现在只认工程文件夹，启动时顺手把旧数据库删干净。
    try { indexedDB.deleteDatabase('montage-db'); } catch (e) {}
    try { localStorage.removeItem('montage.project'); } catch (e) {}

    MTG.picker.init($('picker'));
    MTG.picker.onChange = hex => MTG.ui.syncColor(hex);
    MTG.picker.set(MTG.state.color);
    MTG.picker.renderSwatches();
    MTG.board.init();
    /* 引擎启动时还没读到统一偏好（settings 在其后加载），这里补套一次 */
    if (window.__fabulaEngine && window.__fabulaEngine.applyPenPrefs) {
      window.__fabulaEngine.applyPenPrefs();
    }
    MTG.timeline.init();
    MTG.sheet.init();
    MTG.story.init();
    bind();
    MTG.settings.apply();          // 个性化设置：主题 / 画布底色 / 光标环…
    MTG.radial.init();             // 轮盘菜单
    setupAutosave();

    // 不再自动建工程：像 PR 一样，先打开（或新建）工程文件夹
    MTG.state.project = null;
    MTG.render();
    MTG.ui.syncColor(MTG.state.color);
    MTG.ui.syncHistory();
    MTG.ui.syncProject();
    MTG.ui.syncShotPanel();
    MTG.ui.buildBrushUI();
    MTG.ui.buildBrushParams();
    MTG.ui.syncBrushSliders();
    MTG.ui.syncSel();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
