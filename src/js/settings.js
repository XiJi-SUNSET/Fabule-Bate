/* settings.js · 个性化设置 / 快捷键 / 轮盘菜单配置
   · 偏好存 localStorage（montage.settings.v1），与工程无关：换工程、换设备习惯都保留
   · 快捷键是「动作表驱动」：这里只管定义动作、记录按键、命中后回抛动作 id，
     实际干什么由 app.js 注册的执行器决定（settings 不碰业务，避免循环依赖）
   · 轮盘：8 个扇区，每格绑一个动作，按住自定义键在画布上呼出 */
(function () {
  'use strict';
  const MTG = window.MTG;
  const KEY = 'montage.settings.v1';

  const DEFAULTS = {
    /* 外观 */
    theme: 'dark',
    /* 画板 */
    paper: '#f5f0ea',        // 画布底色
    showRing: true,          // 笔尖光标环
    showRingNum: true,       // 环上标尺寸数字
    invertWheel: false,      // 滚轮缩放反向
    maxUndo: 16,             // 撤销栈深
    gpuEffect: true,         // 涂抹 / 模糊走 WebGL2（关掉则强制 CPU 路径）
    /* 笔刷 */
    smoothing: 50,           // 笔迹平滑（perfect-freehand 的 smoothing/streamline）
    stabilizer: 30,          // 抖动修正（0–100）：越大越稳，代价是笔尖略微滞后
    pressureCurve: 'linear', // 笔压曲线：soft（轻压更灵敏）/ linear / hard（重压才明显）
    /* 通用 */
    autosave: 0,             // 自动保存间隔（秒），0 = 关
    snap: true,              // 时间轴吸附
    uiFont: 12,              // 界面基础字号（px）
    paperTex: 100,           // 纸纹颗粒倍率（%）
    /* 快捷键：actionId -> combo，空 = 用动作自带的默认值 */
    keys: {},
    /* 轮盘 */
    radialKey: 'V',          // 呼出键（按住）
    radialRight: false,      // 右键也能呼出
    radial: ['brush.pen', 'brush.brushPen', 'brush.pencil', 'brush.marker',
             'brush.watercolor', 'brush.airbrush', 'tool.eraser', 'tool.lasso']
  };

  const svg = p => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" '
    + 'stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* 工具图标与工具条按钮同源 */
  const T_ICON = {
    brush: svg('<path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/>'),
    eraser: svg('<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>'),
    line: svg('<path d="M5 19L19 5"/><circle cx="5" cy="19" r="1.7" fill="currentColor" stroke="none"/><circle cx="19" cy="5" r="1.7" fill="currentColor" stroke="none"/>'),
    rect: svg('<rect x="4" y="6" width="16" height="12" rx="1.5"/>'),
    eyedrop: svg('<path d="M15.6 3.4l5 5-2 2-5-5z"/><path d="M13.6 8.4l3 3"/><path d="M14 8.5l-8 8-2 4.5 4.5-2 8-8z"/><path d="M4 17l3 3"/>'),
    hand: svg('<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="m7 15l-1.76-1.76a2 2 0 0 0-2.83 2.82l3.6 3.6C7.5 21.6 9.2 22 12 22h2a8 8 0 0 0 8-8V7a2 2 0 0 0-2-2a2 2 0 0 0-2 2v4"/>'),
    zoom: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6"/><path d="M8 11h6"/>'),
    lasso: svg('<path d="M3.7 14.47a10 8 0 1 1 3.12 2.37"/><path d="M7 22a5 5 0 0 1-2-3.99"/>')
  };

  /* 命令图标用字符，与顶栏的 ⏮ ▶ ■ − ＋ ◐ 同一套语言 */
  const TOOL_ACTS = [
    ['tool.brush', '画笔', 'B'], ['tool.eraser', '橡皮', 'E'], ['tool.line', '直线', 'L'],
    ['tool.rect', '矩形', 'R'], ['tool.eyedrop', '吸管', 'I'], ['tool.hand', '抓手', 'H'],
    ['tool.zoom', '缩放工具', 'Z'], ['tool.lasso', '套索', 'Q']
  ];

  const CMD_ACTS = [
    ['cmd.save', '保存工程', 'Ctrl+S', '⤓'],
    ['cmd.undo', '撤销', 'Ctrl+Z', '↶'],
    ['cmd.redo', '重做', 'Ctrl+Shift+Z', '↷'],
    ['cmd.play', '播放 / 暂停', 'Space', '▶'],
    ['cmd.home', '回到开头', 'Home', '⏮'],
    ['cmd.prev', '上一镜', 'ArrowLeft', '◀'],
    ['cmd.next', '下一镜', 'ArrowRight', '▶'],
    ['cmd.del', '删除（选区 / 片段）', 'Delete', '⌫'],
    ['cmd.fit', '适应窗口', 'Ctrl+0', '⤢'],
    ['cmd.z100', '实际大小 100%', 'Ctrl+1', '1:1'],
    ['cmd.zoomin', '放大画布', '', '＋'],
    ['cmd.zoomout', '缩小画布', '', '−'],
    ['cmd.newFrame', '新建分镜帧', '', '＋'],
    ['cmd.saveFrame', '保存当前帧', '', '⤓'],
    ['cmd.clear', '清空当前图层', '', '⌦'],
    ['cmd.onion', '开 / 关洋葱皮', '', '◍'],
    ['cmd.ref', '开 / 关参考层', '', '▤'],
    ['cmd.theme', '切换明 / 暗', '', '◐'],
    ['cmd.settings', '打开设置', 'Ctrl+,', '⚙'],
    ['cmd.brushUp', '笔刷调大', ']', '＋'],
    ['cmd.brushDown', '笔刷调小', '[', '−'],
    ['cmd.transform', '自由变换（选区 / 贴入图片）', 'Ctrl+T', '⤢'],
    ['cmd.radial', '呼出轮盘菜单', 'V', '◉']
  ];

  /* ── 动作表 ── */
  let ACTIONS = [];
  function buildActions() {
    const list = [];
    TOOL_ACTS.forEach(([id, label, def]) => {
      list.push({ id, label, group: '工具', def, icon: T_ICON[id.slice(5)] || '' });
    });
    /* 笔刷动作：图标直接取 brushes.js 里那一套，避免两边画得不一样 */
    (MTG.brushes && MTG.brushes.list ? MTG.brushes.list : []).forEach(b => {
      list.push({
        id: 'brush.' + b.id, label: b.label, group: '笔刷', def: '',
        icon: svg(b.icon || '')
      });
    });
    CMD_ACTS.forEach(([id, label, def, ch]) => {
      list.push({ id, label, group: '命令', def, icon: '<span class="k-glyph">' + ch + '</span>' });
    });
    ACTIONS = list;
  }

  /* ── 按键组合 ── */
  const PRETTY = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Delete: 'Del', Backspace: '⌫', Enter: '⏎', ' ': 'Space' };
  function comboOf(e) {
    if (!e) return '';
    const k = e.key;
    if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return '';   // 只按修饰键不算
    const mods = [];
    if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    let main = k === ' ' ? 'Space' : (k.length === 1 ? k.toUpperCase() : k);
    return mods.concat(main).join('+');
  }
  function pretty(combo) {
    if (!combo) return '未设置';
    return combo.split('+').map(p => PRETTY[p] || p).join('+');
  }

  /* ── 设置对象 ── */
  const S = (MTG.settings = {
    data: null,
    handlers: null,        // 动作执行器 { actionId: fn }
    listeners: [],         // 设置变更回调

    init() {
      buildActions();
      S.load();
      return S;
    },

    /* 读 / 写 */
    load() {
      let d = {};
      try { d = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { d = {}; }
      S.data = Object.assign({}, DEFAULTS, d);
      S.data.keys = Object.assign({}, d.keys || {});
      if (!Array.isArray(S.data.radial) || S.data.radial.length !== 8) {
        S.data.radial = DEFAULTS.radial.slice();
      }
      return S.data;
    },
    save() {
      try { localStorage.setItem(KEY, JSON.stringify(S.data)); } catch (e) {}
      S.listeners.forEach(fn => { try { fn(S.data); } catch (e) {} });
    },
    get(k) { return S.data ? S.data[k] : DEFAULTS[k]; },
    set(k, v) { S.data[k] = v; S.save(); },
    onChange(fn) { S.listeners.push(fn); },

    /* 动作表 */
    actions() { return ACTIONS; },
    action(id) { return ACTIONS.find(a => a.id === id) || null; },
    bindActions(map) { S.handlers = Object.assign(S.handlers || {}, map); },
    run(id, ev) {
      const h = S.handlers && S.handlers[id];
      if (h) { h(ev); return true; }
      return false;
    },

    /* 快捷键 */
    comboOf,
    pretty,
    keyOf(id) {
      const custom = S.data.keys[id];
      if (custom !== undefined) return custom;          // '' = 用户主动清空
      const a = S.action(id);
      return a ? a.def : '';
    },
    /* combo -> actionId */
    actionFor(combo) {
      if (!combo) return null;
      for (const a of ACTIONS) {
        if (S.keyOf(a.id) && S.keyOf(a.id) === combo) return a.id;
      }
      return null;
    },
    setKey(id, combo) {
      /* 撞键：把旧占用者清掉，避免两个动作抢同一个键 */
      if (combo) {
        for (const a of ACTIONS) {
          if (a.id !== id && S.keyOf(a.id) === combo) S.data.keys[a.id] = '';
        }
      }
      S.data.keys[id] = combo;
      S.save();
    },
    resetKeys() { S.data.keys = {}; S.save(); },

    /* ── 笔刷预设：导出 / 导入 JSON（本工具自己的格式，跨设备或分享给同伴） ── */
    exportBrushPresets() {
      if (!MTG.brushes) return;
      const items = {};
      MTG.brushes.list.forEach(b => { items[b.id] = MTG.brushes.loadParams(b.id); });
      const blob = new Blob([JSON.stringify({ type: 'montage-brush-presets', v: 1, items }, null, 2)],
        { type: 'application/json' });
      MTG.util.download('montage-brush-presets.json', blob);
      MTG.toast('已导出笔刷预设');
    },
    importBrushPresets() {
      if (!MTG.brushes) return;
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'application/json,.json';
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
          try {
            const data = JSON.parse(rd.result);
            if (!data || !data.items) throw new Error('不是笔刷预设文件');
            let n = 0;
            Object.keys(data.items).forEach(id => {
              if (MTG.brushes.list.some(b => b.id === id) && data.items[id]) {
                MTG.brushes.saveParams(id, data.items[id]);
                n++;
              }
            });
            if (!n) throw new Error('没有可用的笔刷');
            if (MTG.board.bp) MTG.board.bp = MTG.brushes.loadParams(MTG.board.brushId);
            if (MTG.ui && MTG.ui.syncBrushSliders) MTG.ui.syncBrushSliders();
            S.ui.render();
            MTG.toast('已导入 ' + n + ' 支笔刷的参数');
          } catch (e) {
            MTG.toast('导入失败：' + ((e && e.message) || e), true);
          }
        };
        rd.readAsText(f);
      };
      inp.click();
    },

    /* ── 设置面板 ── */
    open() { S.ui.build(); S.ui.el.classList.remove('hidden'); },
    close() { if (S.ui.el) S.ui.el.classList.add('hidden'); },
    isOpen() { return !!(S.ui.el && !S.ui.el.classList.contains('hidden')); },

    ui: {
      el: null, tab: 'general', body: null, recording: null,

      build() {
        if (S.ui.el) { S.ui.render(); return; }
        const el = document.createElement('div');
        el.className = 'set-modal hidden';
        el.innerHTML =
          '<div class="set-box">' +
            '<div class="set-head"><span class="set-title">设置</span>' +
              '<div class="set-tabs">' +
                ['general:常规', 'board:画板', 'brush:笔刷', 'tags:标签', 'keys:快捷键', 'radial:轮盘菜单']
                  .map(t => '<button class="set-tab" data-tab="' + t.split(':')[0] + '">' + t.split(':')[1] + '</button>').join('') +
              '</div>' +
              '<button class="set-x" title="关闭">✕</button>' +
            '</div>' +
            '<div class="set-body"></div>' +
            '<div class="set-foot">' +
              '<button class="btn tiny ghost" data-act="reset">全部恢复默认</button>' +
              '<div class="tb-spacer"></div>' +
              '<button class="btn tiny" data-act="done">完成</button>' +
            '</div>' +
          '</div>';
        document.body.appendChild(el);
        S.ui.el = el;
        S.ui.body = el.querySelector('.set-body');
        el.addEventListener('click', e => {
          const t = e.target.closest('[data-tab]');
          if (t) { S.ui.tab = t.dataset.tab; S.ui.render(); return; }
          if (e.target.closest('.set-x') || e.target.closest('[data-act="done"]')) { S.close(); return; }
          if (e.target.closest('[data-act="reset"]')) {
            try { localStorage.removeItem(KEY); } catch (err) {}
            S.load(); S.apply(); S.ui.render();
            MTG.toast('已恢复默认设置');
            return;
          }
          if (e.target === el) S.close();          // 点遮罩关闭
        });
        S.ui.render();
      },

      render() {
        const el = S.ui.el;
        el.querySelectorAll('.set-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === S.ui.tab));
        const b = S.ui.body;
        if (S.ui.tab === 'general') b.innerHTML = S.ui.htmlGeneral();
        else if (S.ui.tab === 'board') b.innerHTML = S.ui.htmlBoard();
        else if (S.ui.tab === 'brush') b.innerHTML = S.ui.htmlBrush();
        else if (S.ui.tab === 'tags') b.innerHTML = S.ui.htmlTags();
        else if (S.ui.tab === 'keys') b.innerHTML = S.ui.htmlKeys();
        else b.innerHTML = S.ui.htmlRadial();
        S.ui.wire(b);
      },

      row(label, hint, ctrl) {
        return '<div class="set-row"><div class="set-lab">' + label +
          (hint ? '<i>' + hint + '</i>' : '') + '</div><div class="set-ctl">' + ctrl + '</div></div>';
      },

      htmlGeneral() {
        const d = S.data;
        return S.ui.row('界面主题', '明 / 暗',
            '<select data-k="theme"><option value="dark"' + (d.theme === 'dark' ? ' selected' : '') + '>暗色</option>' +
            '<option value="light"' + (d.theme === 'light' ? ' selected' : '') + '>亮色</option></select>') +
          S.ui.row('界面字号', '顶栏 / 面板的整体字号',
            '<input type="range" data-k="uiFont" min="11" max="15" step="1" value="' + d.uiFont + '"><span class="val">' + d.uiFont + 'px</span>') +
          S.ui.row('自动保存', '落笔后按间隔自动存盘，0 = 关',
            '<input type="number" data-k="autosave" min="0" max="600" step="10" value="' + d.autosave + '"><span class="unit">秒</span>') +
          S.ui.row('时间轴吸附', '拖动片段时对齐播放头 / 相邻边缘',
            '<label class="chk sm"><input type="checkbox" data-k="snap"' + (d.snap ? ' checked' : '') + '><span>开启</span></label>');
      },

      htmlBoard() {
        const d = S.data;
        return S.ui.row('画布底色', '纸张颜色，不影响导出内容',
            '<input type="color" data-k="paper" value="' + d.paper + '">') +
          S.ui.row('笔尖光标环', '画笔下显示笔刷覆盖范围',
            '<label class="chk sm"><input type="checkbox" data-k="showRing"' + (d.showRing ? ' checked' : '') + '><span>显示</span></label>') +
          S.ui.row('环上标尺寸', '在光标环下写出当前笔刷大小',
            '<label class="chk sm"><input type="checkbox" data-k="showRingNum"' + (d.showRingNum ? ' checked' : '') + '><span>显示</span></label>') +
          S.ui.row('滚轮缩放方向', '勾选后：向上滚 = 缩小',
            '<label class="chk sm"><input type="checkbox" data-k="invertWheel"' + (d.invertWheel ? ' checked' : '') + '><span>反向</span></label>') +
          S.ui.row('纸纹强度', '整体颗粒倍率，0 = 完全关掉纸纹',
            '<input type="range" data-k="paperTex" min="0" max="200" step="10" value="' + d.paperTex + '"><span class="val">' + d.paperTex + '%</span>') +
          S.ui.row('撤销步数', '越大越占内存',
            '<input type="number" data-k="maxUndo" min="4" max="64" step="4" value="' + d.maxUndo + '">') +
          S.ui.row('GPU 加速涂抹 / 模糊', '大笔刷用显卡算，关掉则强制 CPU（排查显示异常时可关）',
            '<label class="chk sm"><input type="checkbox" data-k="gpuEffect"' + (d.gpuEffect ? ' checked' : '') + '><span>启用</span></label>');
      },

      htmlBrush() {
        const d = S.data;
        return S.ui.row('笔迹平滑', '笔画的几何平滑（越高越圆润）',
            '<input type="range" data-k="smoothing" min="0" max="100" step="5" value="' + d.smoothing + '"><span class="val">' + d.smoothing + '</span>') +
          S.ui.row('抖动修正', '手抖补偿：越大线越稳，笔尖会略滞后',
            '<input type="range" data-k="stabilizer" min="0" max="90" step="5" value="' + d.stabilizer + '"><span class="val">' + d.stabilizer + '</span>') +
          S.ui.row('笔压曲线', '压感的响应手感',
            '<select data-k="pressureCurve">' +
              [['linear', '线性'], ['soft', '偏软（轻压就粗）'], ['hard', '偏硬（压重才粗）']]
                .map(o => '<option value="' + o[0] + '"' + (d.pressureCurve === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') +
            '</select>') +
          S.ui.row('笔刷预设', '导出 / 导入全部笔刷参数（JSON，可分享或备份）',
            '<button class="btn tiny" data-act="brush-export">导出</button>' +
            '<button class="btn tiny ghost" data-act="brush-import">导入</button>') +
          '<div class="set-note">画笔的压感、大小、不透明等参数是按笔刷分别记忆的，在左侧「笔刷」区调节。</div>';
      },

      /* 标签页：管理镜头字段的快选标签（和分镜表 / 详情窗口共用同一份数据） */
      htmlTags() {
        if (!MTG.SHOT_FIELDS) return '<div class="set-note">没有可配置的字段。</div>';
        let html = '<div class="set-note">分镜表 / 详情窗口里那些快选标签都在这儿管理：'
          + '点 ✕ 删除，点「＋ 添加」新增。在表格里直接敲一个新值，也能一键存成标签。</div>';
        MTG.SHOT_FIELDS.filter(f => f.options && f.options.length).forEach(f => {
          const list = MTG.tagOptions(f.key);
          html += '<div class="set-group">' + esc(f.title) + '</div><div class="tag-edit" data-f="' + f.key + '">';
          html += list.map(t => '<span class="tag-chip">' + esc(t) +
            '<i data-del="' + esc(t) + '" title="删除这个标签">✕</i></span>').join('');
          if (!list.length) html += '<span class="tag-empty-inline">（还没有标签）</span>';
          html += '<button class="tag-plus" data-add="' + f.key + '">＋ 添加</button></div>';
        });
        return html;
      },

      htmlKeys() {
        let html = '<div class="set-note">点按键框后按下新组合即可录制；按 Esc 取消，按 ⌫ 清空。带修饰键的组合建议保留 Ctrl/Shift。</div>';
        ['工具', '笔刷', '命令'].forEach(g => {
          const items = ACTIONS.filter(a => a.group === g);
          if (!items.length) return;
          html += '<div class="set-group">' + g + '</div>';
          html += items.map(a =>
            '<div class="set-row key">' +
              '<div class="set-lab">' + (a.icon || '') + '<span>' + a.label + '</span></div>' +
              '<div class="set-ctl">' +
                '<button class="kbd" data-key="' + a.id + '">' + pretty(S.keyOf(a.id)) + '</button>' +
              '</div>' +
            '</div>').join('');
        });
        return html;
      },

      htmlRadial() {
        const d = S.data;
        const opts = ACTIONS.map(a => '<option value="' + a.id + '">' + a.group + ' · ' + a.label + '</option>').join('');
        let html =
          '<div class="set-note">按住呼出键（或右键）在画布上唤出轮盘，朝某个方向轻推再松手即执行；正中间松手 = 取消。</div>' +
          S.ui.row('呼出键', '按住不放，松手执行',
            '<button class="kbd" data-key="cmd.radial">' + pretty(d.radialKey) + '</button>') +
          S.ui.row('右键也能呼出', '在画布上按住右键',
            '<label class="chk sm"><input type="checkbox" data-k="radialRight"' + (d.radialRight ? ' checked' : '') + '><span>开启</span></label>') +
          '<div class="set-group">八个方向（从正上方顺时针）</div>';
        const dirs = ['↑ 上', '↗ 右上', '→ 右', '↘ 右下', '↓ 下', '↙ 左下', '← 左', '↖ 左上'];
        html += d.radial.map((id, i) =>
          '<div class="set-row"><div class="set-lab">' + dirs[i] + '</div><div class="set-ctl">' +
          '<select data-radial="' + i + '">' + opts + '</select></div></div>').join('');
        S.ui._radialOpts = opts;
        return html;
      },

      /* 绑定：设置项 → S.set */
      wire(b) {
        b.querySelectorAll('[data-k]').forEach(el => {
          const k = el.dataset.k;
          const ev = el.type === 'checkbox' ? 'change' : (el.tagName === 'SELECT' ? 'change' : 'input');
          if (el.type === 'range') {
            el.addEventListener('input', () => {
              const v = +el.value;
              const val = el.parentNode.querySelector('.val');
              if (val) val.textContent = v;
              S.set(k, v); S.apply();
            });
            return;
          }
          el.addEventListener(ev, () => {
            S.set(k, el.type === 'checkbox' ? el.checked : (el.type === 'number' ? +el.value : el.value));
            S.apply();
            if (k === 'theme') S.ui.render();
          });
        });
        b.querySelectorAll('[data-radial]').forEach(sel => {
          sel.value = S.data.radial[+sel.dataset.radial] || '';
          sel.addEventListener('change', () => {
            const arr = S.data.radial.slice();
            arr[+sel.dataset.radial] = sel.value;
            S.set('radial', arr);
          });
        });
        b.querySelectorAll('.kbd').forEach(btn => {
          btn.onclick = () => S.ui.record(btn);
        });
        /* 标签页：删 / 加 */
        b.querySelectorAll('.tag-chip [data-del]').forEach(x => {
          x.onclick = () => {
            const wrap = x.closest('.tag-edit');
            if (!wrap) return;
            if (!MTG.state.project) { MTG.toast('先打开工程，标签是存在工程里的', true); return; }
            MTG.removeTagOption(wrap.dataset.f, x.dataset.del);
            S.ui.render();
          };
        });
        b.querySelectorAll('.tag-plus').forEach(x => {
          x.onclick = () => {
            if (!MTG.state.project) { MTG.toast('先打开工程，标签是存在工程里的', true); return; }
            const v = (window.prompt('新标签（例：大特写 / 环绕 / 14mm）') || '').trim();
            if (!v) return;
            MTG.toast(MTG.addTagOption(x.dataset.add, v) ? '已添加：' + v : '这个标签已经存在');
            S.ui.render();
          };
        });
        /* 笔刷预设 导出 / 导入 */
        b.querySelectorAll('[data-act="brush-export"]').forEach(x => { x.onclick = () => S.exportBrushPresets(); });
        b.querySelectorAll('[data-act="brush-import"]').forEach(x => { x.onclick = () => S.importBrushPresets(); });
      },

      /* 录制快捷键 */
      record(btn) {
        const id = btn.dataset.key;
        const old = btn.textContent;
        btn.classList.add('rec');
        btn.textContent = '按下按键…';
        const done = (combo) => {
          document.removeEventListener('keydown', onKey, true);
          btn.classList.remove('rec');
          if (combo === null) { btn.textContent = old; return; }
          if (id === 'cmd.radial') S.set('radialKey', combo);
          else S.setKey(id, combo);
          S.ui.render();
          MTG.toast(combo ? '已设为 ' + pretty(combo) : '已清除该快捷键');
        };
        const onKey = e => {
          e.preventDefault(); e.stopPropagation();
          if (e.key === 'Escape') { done(null); return; }
          if (e.key === 'Backspace' || e.key === 'Delete') { done(''); return; }
          const c = comboOf(e);
          if (c) done(c);
        };
        document.addEventListener('keydown', onKey, true);
      }
    },

    /* 把设置推给各模块（board / app 读同一份数据） */
    apply() {
      const d = S.data;
      document.documentElement.style.setProperty('--fs-ui', (d.uiFont || 12) + 'px');
      document.body.dataset.theme = d.theme;
      MTG.state.theme = d.theme;
      try { localStorage.setItem('montage.theme', d.theme); } catch (e) {}   // 与启动时读取的键保持一致
      MTG.state.snap = !!d.snap;
      const snapEl = document.getElementById('snap');                       // 顶栏吸附勾选框跟着走
      if (snapEl) snapEl.checked = !!d.snap;
      if (MTG.board) {
        MTG.board.trimUndo && MTG.board.trimUndo();   // 撤销栈深可能改小了
        MTG.board.paint && MTG.board.paint();
        MTG.board.refreshRing && MTG.board.refreshRing();
      }
    }
  });

  S.init();
})();
