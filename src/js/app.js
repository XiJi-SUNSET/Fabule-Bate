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
      if (!hex) hex = MTG.state.color;          // 无参调用兜底（引擎 onColor 路径）
      MTG.state.color = hex;
      $('swatch').style.background = hex;
      const hsv = MTG.state.hsv;
      $('f-h').value = hsv.h; $('f-s').value = hsv.s; $('f-v').value = hsv.v;
      if (document.activeElement !== $('f-hex')) $('f-hex').value = hex;
      /* 推给绘画引擎：拾色器 / 数字字段 / 色板改色必须真正落到画笔。
         判重防回声：引擎 setColor → onColor → syncColor 时颜色已相同，不再回推。 */
      const e = window.__fabulaEngine;
      if (e && e.setColor && e.getColor && /^#[0-9a-fA-F]{6}$/.test(hex)) {
        const cur = e.getColor();
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        const same = Math.abs(cur[0] - r) < 0.004 && Math.abs(cur[1] - g) < 0.004 && Math.abs(cur[2] - b) < 0.004;
        if (!same) e.setColor(hex);
      }
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
    /* 笔刷选中态：右侧笔刷条 + 工具栏笔刷按钮（引擎侧切笔也会回掉到这里）。
       高亮以**引擎当前工具**为准并与工具互斥：选抓手时笔刷必须全部熄灭。 */
    syncBrushUI() {
      const BRUSHES = ['pen', 'pencil', 'marker', 'gouache', 'airbrush'];
      const eng = window.__fabulaEngine;
      const toolNow = eng ? eng.tool() : 'pen';
      const isBrush = BRUSHES.indexOf(toolNow) >= 0;
      const box = $('brush-list');
      if (box) {
        box.querySelectorAll('.brush-chip').forEach(el => el.classList.toggle('active', isBrush && el.dataset.brush === toolNow));
      }
      document.querySelectorAll('.tool[data-brush]').forEach(b => b.classList.toggle('active', isBrush && b.dataset.brush === toolNow));
      MTG.ui.buildBrushParams();               // 属性面板随工具切换重铺（同工具内不重建）
    },
    setBrush(id) {
      MTG.board.setBrush(id);
      MTG.ui.buildBrushUI();
      MTG.ui.buildBrushParams();
      MTG.ui.syncBrushSliders();
      setTool('brush');
    },
    /* 当前工具的属性面板（PS 式）：数据源 = 引擎 panelRows()，按工具动态生成。
       画笔 → 笔刷参数；涂抹 → 涂抹率/蘸色率/上色率；模糊 → 强度/半径；…… */
    buildBrushParams() {
      const box = $('brush-params');
      if (!box) return;
      const eng = window.__fabulaEngine;
      const toolId = (MTG.board.engine() || {}).id || '';
      /* 同一工具不重建（避免滑动参数时打断拖动），换工具才重铺 */
      if (MTG.ui._propsTool === toolId && box.children.length) return;
      MTG.ui._propsTool = toolId;
      box.innerHTML = '';
      if (!eng || !eng.panelRows) return;
      let rows = [];
      try { rows = eng.panelRows() || []; } catch (_) { return; }
      const SKIP = { size: 1, opacity: 1 };            // 大小/不透明走块内固定滑杆
      /* 常用参数直接展示；其余（间距/倾角/颗粒/散布…）压缩进「更多参数」折叠区 */
      const COMMON = {
        hardness: 1, flow: 1, stabilize: 1,
        smudgeStrength: 1, smudgeDrag: 1, smudgeColor: 1,
        blurStrength: 1, blurRadius: 1, warpStrength: 1, fillTolerance: 1,
      };
      const more = document.createElement('details');
      more.className = 'tp-more';
      more.innerHTML = '<summary>更多参数</summary>';
      let moreCount = 0;
      const persist = () => {
        try { if (MTG.brushes && MTG.board.bp) MTG.brushes.saveParams(toolId, MTG.board.bp); } catch (_) {}
      };
      rows.forEach(r => {
        if (r.kind === 'probe') return;
        if (r.kind === 'sect') {
          if (r.group === 'core') return;              // "笔刷"组标题由块标题承担
          const h = document.createElement('div');
          h.className = 'tp-sect';
          h.textContent = r.title;
          more.appendChild(h); moreCount++;
          return;
        }
        if (r.kind === 'note') {
          const n = document.createElement('div');
          n.className = 'tp-note';
          n.textContent = r.text;
          more.appendChild(n); moreCount++;
          return;
        }
        if (SKIP[r.key]) return;
        const row = document.createElement('div');
        row.className = 'slider-row';
        const lb = document.createElement('label');
        lb.textContent = r.label;
        row.appendChild(lb);
        if (r.kind === 'check') {
          const inp = document.createElement('input');
          inp.type = 'checkbox';
          inp.checked = !!r.obj[r.key];
          inp.onchange = () => { r.obj[r.key] = inp.checked; persist(); };
          row.appendChild(inp);
        } else {
          const inp = document.createElement('input');
          inp.type = 'range';
          inp.min = r.min; inp.max = r.max; inp.step = r.step;
          inp.value = r.obj[r.key];
          const val = document.createElement('span');
          const fmt = () => (eng.fmtPanelVal ? eng.fmtPanelVal(r) : String(r.obj[r.key]));
          val.textContent = fmt();
          inp.oninput = () => {
            r.obj[r.key] = +inp.value;
            val.textContent = fmt();
            persist();
          };
          row.appendChild(inp); row.appendChild(val);
        }
        (COMMON[r.key] ? box : more).appendChild(row);
        if (!COMMON[r.key]) moreCount++;
      });
      if (moreCount) box.appendChild(more);
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
  /* 切工程与外部同步互斥（N-A6）：切工程在多个 await 之间若到达广播，
     两路 loadProject/applyProject 会交错、极端时序回写旧快照。 */
  let switchingProject = false;
  let externalPending = null;      // 同步进行中又到达的广播：补跑一次（N-B1）

  function flushPendingExternal() {
    if (!externalPending) return;
    const next = externalPending;
    externalPending = null;
    setTimeout(() => { reloadExternal(next).catch((err) => console.warn('[app] 外部变更同步失败', err)); }, 60);
  }

  async function openFolder() {
    if (switchingProject) return;
    switchingProject = true;
    try { await openFolderInner(); }
    finally { switchingProject = false; flushPendingExternal(); }
  }

  async function openFolderInner() {
    /* 切工程前先把当前工程的未存笔迹落盘：openDialog 一返回，主进程的工程根就换了，
       之后再 flush 会把旧工程的笔迹写进新工程（旧工程最后几笔静默丢失） */
    if (MTG.storage.ready && MTG.state.project) {
      try {
        await saveTick();                        // 走串行闸（R3 B-12）：与落笔 debounce 不并发
      } catch (err) {
        console.warn('[app] 切工程前保存失败', err);
      }
    }
    const mode = await MTG.storage.openFolder();
    if (!mode) return;
    // 切换工程：先把上一个工程的缓存（blob URL / 洋葱皮 / 缩略图）全部释放
    MTG.board.resetCaches();
    MTG.assets.resetCaches();
    let proj = null;
    try {
      proj = await MTG.storage.loadProject();
    } catch (err) {
      if (err && err.parseFailed) {
        MTG.toast('工程文件损坏，已中止打开（不覆盖原文件）', true);   // 别把损坏文件当新工程重建（M-1）
        return;
      }
      throw err;
    }
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

  /* 自动保存统一入口：落笔 debounce（4s）与设置的间隔两条触发源共用同一份串行逻辑，
     避免两条路径并发写 montage.json 交错撕裂（L-6） */
  let saving = false, saveAgain = false;
  async function saveTick() {
    if (saving) { saveAgain = true; return; }
    saving = true;
    try {
      if (MTG.board.dirty) await MTG.board.flush();
      if (MTG.state.dirty && MTG.storage.ready && MTG.state.project) {
        await MTG.storage.saveProject(MTG.state.project);
        MTG.ui.syncProject();
      }
    } catch (err) {
      console.warn('[app] 自动保存失败', err);
    } finally {
      saving = false;
      if (saveAgain) { saveAgain = false; saveTick(); }
    }
  }
  /* 等待进行中的串行保存结束（R3 B-12）：需要"明确结果"的保存路径
     （手动保存/关窗/外部合并回写）先过这道闸，避免与 saveTick 并发写。 */
  async function waitSaveIdle() {
    for (let i = 0; i < 100 && saving; i++) await new Promise(r => setTimeout(r, 120));
  }
  const autosave = U.debounce(saveTick, 4000);
  const origMark = MTG.markDirty;
  MTG.markDirty = function () { origMark(); autosave(); };

  /* 鼠标交互区的笔输入归一化（用户需求：时间轴等区域"只有鼠标一种模式"）。
     做法：捕获阶段把 pen 的 pointer 序列重放为 pointerType:'mouse' 的事件并拦下
     原始笔事件 —— 此后所有监听者（拖拽/擦洗/多选/未来的 pointerType 分支）
     看到的统一是 mouse 语义，笔的悬停噪声、侧键、驱动差异都不再影响这些区域。
     浏览器因 preventDefault 不再合成兼容鼠标事件，故 click/dblclick 由本层补发
     （down/up 同一目标才发 click；同目标两次 click 间隔 <500ms 补 dblclick）。
     画布（#ov）不在范围内：压感/倾斜/笔尾橡皮保留原生。 */
  function penToMouse(area) {
    if (!area || area.__penToMouse) return;
    area.__penToMouse = true;
    let downTarget = null;
    let lastClick = { t: 0, target: null };
    const send = (e) => {
      const ev = new PointerEvent(e.type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId: e.pointerId, pointerType: 'mouse', isPrimary: true,
        button: e.button, buttons: e.buttons,
        clientX: e.clientX, clientY: e.clientY,
        pressure: e.buttons ? 0.5 : 0, tiltX: 0, tiltY: 0, twist: 0, width: 1, height: 1,
      });
      ev.__penReplay = true;
      e.target.dispatchEvent(ev);
    };
    area.addEventListener('pointerdown', (e) => {
      if (e.__penReplay || e.pointerType !== 'pen') return;
      e.preventDefault(); e.stopPropagation();
      if (e.button !== 0) return;                 // 侧键/右键：这些区域不做任何事
      downTarget = e.target;
      send(e);
    }, true);
    area.addEventListener('pointermove', (e) => {
      if (e.__penReplay || e.pointerType !== 'pen') return;
      e.preventDefault(); e.stopPropagation();
      if (downTarget) send(e);                    // 只有按下拖动才重放（悬停移动无需）
    }, true);
    area.addEventListener('pointerup', (e) => {
      if (e.__penReplay || e.pointerType !== 'pen') return;
      e.preventDefault(); e.stopPropagation();
      if (e.button !== 0) { downTarget = null; return; }
      send(e);
      const t = (downTarget === e.target) ? e.target : null;   // 同目标才算点击
      downTarget = null;
      if (!t) return;
      t.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY,
      }));
      const now = Date.now();
      if (lastClick.target === t && now - lastClick.t < 500) {
        t.dispatchEvent(new MouseEvent('dblclick', {
          bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY,
        }));
        lastClick = { t: 0, target: null };
      } else {
        lastClick = { t: now, target: t };
      }
    }, true);
    area.addEventListener('pointercancel', (e) => {
      if (e.__penReplay || e.pointerType !== 'pen') return;
      e.preventDefault(); e.stopPropagation();
      downTarget = null;
    }, true);
  }

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
      await waitSaveIdle();                         // 与自动保存串行（R3 B-12）
      await MTG.board.flush();                      // 画板内容先落进帧 PNG
      await MTG.storage.saveProject(MTG.state.project);
      MTG.toast('工程已保存');
    };
    $('btn-export').onclick = async () => {
      const p = MTG.state.project;
      if (!p) { MTG.toast('请先打开工程文件夹', true); return; }
      const exp = window.fabula && window.fabula.exp;
      if (exp && exp.shotFiles) {
        /* 桌面版导出（M-13）：系统对话框选目录，按镜头顺序输出 01.png…；先落盘保证是最新内容 */
        try {
          await MTG.board.flush();
          if (MTG.state.dirty) await MTG.storage.saveProject(p);
          const rels = MTG.board.orderedBoardClips()
            .map(c => (MTG.findBoard(c.boardId) || {}).path).filter(Boolean);
          if (!rels.length) { MTG.toast('时间轴还没有带画面的镜头', true); return; }
          const r = await exp.shotFiles(rels);
          if (r && r.ok) MTG.toast('已导出 ' + r.count + ' 张到 ' + r.dir);
          else if (!(r && r.canceled)) MTG.toast('导出失败：' + ((r && r.error) || '未知错误'), true);
        } catch (err) {
          MTG.toast('导出失败：' + ((err && err.message) || err), true);
        }
        return;
      }
      /* 浏览器模式：下载工程 JSON */
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
    $('btn-import-media').onclick = async () => {
      const imp = window.fabula && window.fabula.assets && window.fabula.assets.importDialog;
      if (imp) {
        /* 桌面版导入（M-14）：走系统对话框（含 magic 嗅探与复制进 assets/），
           落盘后 rescan 让渲染端模型看到新素材 */
        try {
          const r = await imp();
          if (!r) return;                             // 用户取消
          await MTG.assets.rescan();
          MTG.toast('已导入 ' + (r.added || 0) + ' 个素材' + (r.skipped ? '，跳过 ' + r.skipped + ' 个' : ''));
        } catch (err) {
          MTG.toast('导入失败：' + ((err && err.message) || err), true);
        }
        return;
      }
      $('file-media').click();
    };
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
      };
    };
    bindSlider('b-size', 'size');
    bindSlider('b-opacity', 'opacity');
    /* 压感相关滑杆/复选已删：它们写的引擎键不存在（N-A8）；压感参数在设置面板「笔刷」页 */

    /* 洋葱皮 */
    const onion = () => { MTG.board.preloadOnion(); MTG.ui.syncBoardMeta(); };
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
    $('ref-show').onchange = e => { MTG.board.showRef = e.target.checked; };
    $('ref-clear').onclick = () => MTG.board.clearRef();

    /* 画幅 */
    const sizeSel = $('board-size'), custom = $('size-custom');
    const applySize = (w2, h2) => {
      const p = MTG.state.project;
      if (!p) { MTG.toast('请先打开工程文件夹', true); return; }
      const rawW = Math.round(+w2), rawH = Math.round(+h2);
      const badW = !isFinite(rawW) || rawW <= 0, badH = !isFinite(rawH) || rawH <= 0;
      w2 = U.clamp(badW ? 1280 : rawW, 64, 4096);
      h2 = U.clamp(badH ? 720 : rawH, 64, 4096);
      const adjusted = badW || badH || rawW !== w2 || rawH !== h2;   // 0/NaN/越界会被静默改写，提示要说清（L-8）
      if (p.boardW === w2 && p.boardH === h2) return;
      MTG.board.applySize(w2, h2);
      p.boardW = w2; p.boardH = h2;
      MTG.markDirty();
      MTG.toast('画幅已改为 ' + w2 + '×' + h2
        + (adjusted ? '（原输入无效或超出 64–4096，已按此值处理）' : '') + '，已有帧按新画幅缩放显示');
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
    ['brush', 'eraser', 'line', 'rect', 'eyedrop', 'hand', 'zoom', 'lasso', 'smudge', 'blur', 'warp'].forEach(t => {
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
        if (!MTG.board.spacePanned && Date.now() - MTG.board.spaceDownAt < 260) {
          MTG.audio.playing ? MTG.audio.pause() : MTG.audio.play();
        }
        MTG.board.spacePanned = false;
      }
    });

    /* 关窗落盘（H-5）：Electron 主进程在真正关闭前先广播 app:before-close，
       渲染端 flush 完成后再放行 —— 异步写在 beforeunload 里不可靠，这里才等得到。
       无桥环境（纯浏览器）保留 beforeunload 尽力而为。 */
    if (window.fabula && window.fabula.app && window.fabula.app.onBeforeClose) {
      window.fabula.app.onBeforeClose(async () => {
        try {
          await waitSaveIdle();                        // 与自动保存串行（R3 B-12）
          await MTG.board.flush();
          if (MTG.state.dirty && MTG.storage.ready) await MTG.storage.saveProject(MTG.state.project);
        } catch (err) { console.warn('[app] 关窗保存失败', err); }
        try { window.fabula.app.closeReady(); } catch (_) {}
      });
    } else {
      window.addEventListener('beforeunload', () => {
        if (!MTG.board.dirty && !MTG.state.dirty) return;
        MTG.board.flush();                             // 尽力而为：浏览器不保证异步完成
        /* 串行保存进行中则跳过本次兜底（R3 B-12）：并发全量写会撕裂文件 */
        if (!saving && MTG.storage.ready) MTG.storage.saveProject(MTG.state.project);
      });
    }

    /* Agent / 外部进程改动 fabula.json → 主进程广播 → 这里重载（H-1）。
       只认 external：自己写盘的回环不触发。 */
    if (window.fabula && window.fabula.project && window.fabula.project.onChanged) {
      window.fabula.project.onChanged((info) => {
        try { window.__lastChangedInfo = info; } catch (_) {}   // 诊断探针读取（mediaSuppressProbe）
        if (!info || !info.external) return;
        reloadExternal(info).catch((err) => console.warn('[app] 外部变更同步失败', err));
      });
    }
    window.addEventListener('resize', U.debounce(() => { MTG.timeline.render(); MTG.board.fitView(); }, 150));
    /* 鼠标交互区：笔按鼠标语义工作（时间轴/分镜表/故事板；画布保留原生压感） */
    penToMouse(document.querySelector('.timeline'));
    penToMouse(document.getElementById('view-sheet'));
    penToMouse(document.getElementById('view-story'));
  }

  /* 外部（Agent/MCP/手改）改动工程文件后的同步（H-1/H-2）：
     · montage.json 变了 → 与内存**合并**（本地优先、外部新增并集），两边都不丢；
     · fabula.json 变了 → 只提示（它现在只承载冒烟自检模型）。 */
  let externalReloading = false;
  async function reloadExternal(info) {
    const sources = (info && Array.isArray(info.sources)) ? info.sources
      : (info && info.external ? ['fabula'] : []);
    if (!sources.length) return;
    /* 与切工程互斥；同步进行中到达的广播记下补跑（N-A6/N-B1） */
    if (switchingProject || externalReloading) { externalPending = info || {}; return; }
    if (!MTG.storage.ready) return;
    if (!sources.includes('montage')) {
      if (sources.includes('media')) { await refreshMedia(info && info.files); return; }   // 纯换图：轻量刷新（N-A5）
      MTG.toast && MTG.toast('外部更新了工程数据（fabula.json）');
      return;
    }
    externalReloading = true;
    try {
      let disk = null;
      try {
        disk = await MTG.storage.loadProject();
      } catch (err) {
        if (err && err.parseFailed) {   // 外部可能正写到一半：留给下一轮通知，不打断
          MTG.toast && MTG.toast('工程文件暂不可解析（可能正在写入），稍后自动重试', true);
          return;
        }
        throw err;
      }
      if (!disk) return;
      MTG.migrateProject(disk);
      const mem = MTG.state.project;
      const dirty = !!(MTG.board.dirty || MTG.state.dirty);
      if (mem && MTG.board.dirty) await MTG.board.flush();   // 帧图未存：先写 PNG（与 JSON 无关，不覆盖 Agent 的改动）
      /* 本地无未存编辑（最常见）：直接采纳磁盘版；双方都改过：并集合并 */
      const merged = (mem && dirty) ? mergeProjects(mem, disk) : disk;
      if (mem && JSON.stringify(merged) === JSON.stringify(mem)) {
        MTG.toast && MTG.toast('检测到外部更新（内容与本地一致）');
        return;
      }
      MTG.board.resetCaches();
      MTG.assets.resetCaches();
      MTG.state.project = merged;
      MTG.state.selectedClipIds = new Set();
      if (!mem) MTG.state.playhead = 0;
      if (mem && dirty) {
        await waitSaveIdle();                    // 与自动保存串行（R3 B-12）
        await MTG.storage.saveProject(merged);   // 合并结果写回：Agent 的新增与本地编辑一起持久化
      }
      await applyProject();
      await MTG.assets.rescan();
      MTG.render();
      MTG.toast && MTG.toast(dirty
        ? '已同步 Agent 更新（本地编辑已合并且保留）'
        : '已同步 Agent 更新：' + merged.name);
    } finally {
      externalReloading = false;
      flushPendingExternal();          // 期间积压的广播：补跑一次（N-B1）
    }
  }

  /* Agent 换了画面/素材文件（JSON 未变）：作废缓存并轻量刷新，不重载工程模型（N-A5）。
     · 只有「当前帧文件确实在外部改动清单里」才重读它并提示 —— 其余静默刷新；
     · 重读保留撤销栈（外部刷新不该清掉用户的撤销历史）；
     · 用户自己的保存（flush）已由主进程自写抑制吞掉，不会走到这里。 */
  async function refreshMedia(files) {
    const list = Array.isArray(files) ? files : [];
    /* 缓存失效（R3 B-11/B-13）：
       · 缩略图（各帧图都可能涉及）与洋葱皮：全清；
       · 洋葱皮 in-flight：代际 +1 作废（慢加载回来的旧图不得回填脏缓存）；
       · 素材库：只精确淘汰清单里真正被改的素材（dropUrl + 波形缓存），
         不整表 resetCaches —— 后者会连 collapsed 折叠状态一起清掉。 */
    MTG.board.thumbCache.forEach((u) => URL.revokeObjectURL(u));
    MTG.board.thumbCache.clear();
    MTG.board.onionCache.clear();
    MTG.board.onionLoading.clear();
    MTG.board._ogen++;
    for (const rel of list) {
      const a = (MTG.state.project && MTG.state.project.assets || []).find(x => x.path === rel);
      if (a) {
        MTG.assets.dropUrl(a.id);
        if (MTG.audio && MTG.audio.cache) MTG.audio.cache.delete(a.id);
      }
    }
    const b = MTG.state.currentBoardId ? MTG.findBoard(MTG.state.currentBoardId) : null;
    const curChanged = !!(b && list.includes(b.path));
    if (curChanged && !MTG.board.dirty) {
      try { await MTG.board.reloadCurrent(true); } catch (err) { console.warn('[app] 重读当前帧失败', err); }
    }
    MTG.board.rebuildBackdrop();
    MTG.timeline.render();
    await MTG.assets.render();
    if (MTG.sheet && MTG.sheet.active) MTG.sheet.render();
    if (MTG.story && MTG.story.active) MTG.story.render();
    if (curChanged && !MTG.board.dirty) MTG.toast && MTG.toast('当前镜头画面已被外部更新');
  }

  /* 并集合并（H-2）：以本地为基（用户正在编辑的字段优先），把磁盘上按 id
     新增的 tracks/groups/boards/assets/clips 补进来。删除冲突无法区分，保留本地。 */
  function mergeProjects(mem, disk) {
    const out = JSON.parse(JSON.stringify(mem));
    const union = (key) => {
      const have = new Set((out[key] || []).map((x) => x.id));
      for (const it of (disk[key] || [])) {
        if (!have.has(it.id)) (out[key] = out[key] || []).push(it);
      }
    };
    union('tracks'); union('groups'); union('boards'); union('assets');
    const cids = new Set((out.clips || []).map((c) => c.id));
    for (const c of (disk.clips || [])) if (!cids.has(c.id)) out.clips.push(c);
    /* tagOptions：按 key 做选项并集（R3 B-14）——当前 MCP 不写，但合并语义要完整 */
    out.tagOptions = out.tagOptions || {};
    for (const [k, list] of Object.entries(disk.tagOptions || {})) {
      if (!Array.isArray(list)) continue;
      const cur = Array.isArray(out.tagOptions[k]) ? out.tagOptions[k] : (out.tagOptions[k] = []);
      for (const v of list) if (!cur.includes(v)) cur.push(v);
    }
    return out;
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
    MTG.toast('笔刷大小 ' + next);
  }

  /* 自动保存：按设置间隔自动落笔存盘 + 存工程；设置里改了间隔立即重排 */
  let autosaveTimer = null;
  function setupAutosave() {
    clearInterval(autosaveTimer);
    const sec = +MTG.settings.get('autosave') || 0;
    if (!sec) return;
    autosaveTimer = setInterval(() => {
      if (!MTG.state.project) return;
      saveTick();                    // 与落笔 debounce 共用串行保存（L-6）
    }, sec * 1000);
  }

  function setTool(t) {
    // 离开套索工具时把还浮着的选区内容落回画面，避免存盘时丢失
    if (MTG.board.sel && MTG.board.sel.float && t !== 'lasso') MTG.board.commitSel();
    MTG.state.tool = t;
    MTG.board.setTool(t);                    // 通知引擎（此前漏了转发：点工具按钮引擎毫无反应）
    document.querySelectorAll('.tool[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    const st = $('stage');                   // 导航类工具用系统光标（抓取/缩放），其余交给引擎自绘
    if (st) {
      st.classList.toggle('tool-hand', t === 'hand');
      st.classList.toggle('tool-zoom', t === 'zoom');
    }
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

  /* 布局变化（拖分割条 / 弹窗搬 DOM）后重建引擎画布：#gl/#ov 的像素尺寸跟随舞台。
     引擎同步监听 window resize；rAF 节流保证每帧最多一次（H-8）。 */
  function sizeBoardSoon() {
    if (sizeBoardSoon._p) return;
    sizeBoardSoon._p = requestAnimationFrame(() => {
      sizeBoardSoon._p = 0;
      window.dispatchEvent(new Event('resize'));
    });
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
      sizeBoardSoon();          // 布局变了：重建引擎画布尺寸（H-8）
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
    MTG.ui.syncColor(MTG.state.color);      // 启动时推一次：首帧画笔色与 UI 一致
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
