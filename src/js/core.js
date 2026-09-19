/* core.js · 全局命名空间 / 状态 / 工具函数
   所有模块挂在 window.MTG 下，普通 script 标签加载，双击 index.html 即可运行（无需服务器）。 */
(function () {
  'use strict';

  const MTG = (window.MTG = {});

  /* ── 常量 ── */
  MTG.PROJECT_FILE = 'montage.json';
  MTG.AUDIO_EXT = ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac'];
  MTG.IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'];

  /* ── 工具 ── */
  const U = (MTG.util = {
    uid(prefix) {
      return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 9);
    },
    clamp(v, a, b) { return v < a ? a : v > b ? b : v; },
    ext(name) { return (name.split('.').pop() || '').toLowerCase(); },
    kindOf(name) {
      const e = U.ext(name);
      if (MTG.AUDIO_EXT.includes(e)) return 'audio';
      if (MTG.IMAGE_EXT.includes(e)) return 'image';
      return 'other';
    },
    /* 素材落盘文件名净化：与主进程导入（projectStore.importAssets）同一规则 ——
       低项：此前浏览器路径不净化，非法字符会进文件路径。
       边缘防护：扩展名只留字母数字（点也去）、主干去首点（防 ".." 前缀）、去尾点空格 */
    safeFileName(name) {
      const s = String(name || '');
      const dot = s.lastIndexOf('.');
      const base = dot > 0 ? s.slice(0, dot) : s;
      const ext = dot > 0 ? s.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6) : '';
      let clean = base.replace(/[^A-Za-z0-9._\u4e00-\u9fa5-]/g, '_').slice(0, 80);
      clean = clean.replace(/^\.+/, '_').replace(/[. ]+$/, '');
      if (!clean) clean = 'asset';
      return clean + (ext ? '.' + ext : '');
    },
    /* 秒 → 00:00.00 */
    tc(t) {
      t = Math.max(0, t || 0);
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      const cs = Math.floor((t * 100) % 100);
      return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
    },
    hex2rgb(hex) {
      const h = hex.replace('#', '');
      const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    },
    rgb2hex(r, g, b) {
      return '#' + [r, g, b].map(v => U.clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
    },
    hsv2hex(h, s, v) {
      s /= 100; v /= 100;
      const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
      let r = 0, g = 0, b = 0;
      if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
      else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
      else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
      return U.rgb2hex((r + m) * 255, (g + m) * 255, (b + m) * 255);
    },
    hex2hsv(hex) {
      const { r, g, b } = U.hex2rgb(hex);
      const R = r / 255, G = g / 255, B = b / 255;
      const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
      let h = 0;
      if (d) {
        if (max === R) h = 60 * (((G - B) / d) % 6);
        else if (max === G) h = 60 * ((B - R) / d + 2);
        else h = 60 * ((R - G) / d + 4);
      }
      if (h < 0) h += 360;
      return { h: Math.round(h), s: Math.round(max ? (d / max) * 100 : 0), v: Math.round(max * 100) };
    },
    download(name, blob) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    },
    debounce(fn, ms) {
      let t;
      return function () { clearTimeout(t); const a = arguments, s = this; t = setTimeout(() => fn.apply(s, a), ms); };
    }
  });

  /* ── 镜头字段（影视工业口径）
     枚举参考闪电分镜（影视飓风）的默认表头：
     景别 9 档、摄影机角度与运镜分成两个维度、装备与焦段独立成列。
     · 元数据挂在 clip 上而不是 board 上：同一张帧图可以被多次放到时间轴上，
       每个「镜头」有自己的景别/运镜，才符合分镜表里「镜号」的语义。
     · 镜号不落盘，按时间轴顺序实时推导（见 timeline.shotNoMap）。 */
  /* v4.1：拆「声音」为 对白/音效 两列；去掉 机位角度/承托设备 两列（旧数据并入备注）；
     新增「转场」。字段仍是挂在 clip 上的镜头元数据，只改表头取舍。 */
  MTG.SHOT_FIELDS = [
    { key: 'content', title: '画面内容', text: true, hint: '画面内容：动作、表演、镜头里发生什么' },
    { key: 'dialogue', title: '对白 / 旁白', text: true, hint: '台词与旁白（配音与后期参考）' },
    { key: 'sfx', title: '音效 / 音乐', text: true, hint: '音效、氛围声、音乐提示' },
    { key: 'size', title: '景别', options: ['大远景', '远景', '全景', '中全景', '中景', '中近景', '近景', '特写', '大特写'] },
    { key: 'move', title: '运镜', options: ['固定', '横摇', '俯仰', '横移', '升降', '轨道推拉', '变焦推拉', '正跟随', '倒跟随', '环绕', '滑轨横移'] },
    { key: 'lens', title: '焦段', options: ['14mm', '18mm', '24mm', '35mm', '50mm', '85mm', '100mm', '135mm'] },
    { key: 'trans', title: '转场', options: ['切', '叠化', '划变', '淡入', '淡出', '黑场', '白场'], hint: '进入本镜的转场' },
    { key: 'remark', title: '备注', text: true, hint: '承托设备、道具、服装等现场信息' }
  ];

  /* 镜头字段控件（下拉 / 文本）的统一构造：分镜表与侧栏「镜头信息」共用 */
  MTG.metaControl = function (shot, f, write) {
    if (f.text) {
      const ta = document.createElement('textarea');
      ta.value = (shot.meta && shot.meta[f.key]) || '';
      ta.placeholder = f.title;
      ta.title = f.hint || f.title;
      ta.addEventListener('input', () => write(ta.value));
      return ta;
    }
    const val = (shot.meta && shot.meta[f.key]) || '';
    const inp = MTG.tagControl(f.key, val, write);
    inp.title = (f.hint || f.title) + '（可直接输入，点开选常用标签）';
    return inp;
  };

  /* ── 枚举字段的「常用标签」
     标签清单存在工程里（project.tagOptions），跟着工程走；首次用到时
     用 SHOT_FIELDS 的内置选项初始化，之后可增删。旧工程没有这个字段也能直接用。 */
  MTG.tagOptions = function (key) {
    const f = (MTG.SHOT_FIELDS || []).find(x => x.key === key);
    const p = MTG.state.project;
    if (!p) return (f && f.options) ? f.options.slice() : [];
    p.tagOptions = p.tagOptions || {};
    if (!Array.isArray(p.tagOptions[key])) {
      p.tagOptions[key] = (f && f.options) ? f.options.slice() : [];
      if (MTG.markDirty) MTG.markDirty();   // 读操作有副作用（回写默认值）→ 必须标记落盘（L-4）
    }
    return p.tagOptions[key];
  };
  MTG.addTagOption = function (key, val) {
    val = (val || '').trim();
    if (!val) return false;
    const list = MTG.tagOptions(key);
    if (list.indexOf(val) >= 0) return false;
    list.push(val);
    MTG.markDirty();
    return true;
  };
  MTG.removeTagOption = function (key, val) {
    const list = MTG.tagOptions(key);
    const i = list.indexOf(val);
    if (i < 0) return false;
    list.splice(i, 1);
    MTG.markDirty();
    return true;
  };

  /* 枚举字段控件：本体就是一个 input（所以外部照旧用 el.value 读写），
     聚焦/点击时弹出标签面板 —— 既能手打，也能一键选常用值。 */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  MTG.tagControl = function (key, value, write) {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = value || '';
    inp.autocomplete = 'off';
    inp.placeholder = '—';
    inp.dataset.tag = '1';
    inp.addEventListener('input', () => write(inp.value));
    inp.addEventListener('focus', () => MTG.tagMenu.open(inp, key));
    inp.addEventListener('click', () => MTG.tagMenu.open(inp, key));
    inp.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); MTG.tagMenu.open(inp, key); }
      else if (e.key === 'Escape') { MTG.tagMenu.close(); inp.blur(); }
      else if (e.key === 'Enter') { MTG.tagMenu.close(); inp.blur(); }
    });
    inp.addEventListener('blur', () => {
      /* R5-11：延迟关闭必须校验"期间有没有新的 open" —— 旧实现下从字段 A 直接点到
         相邻字段 B，B 的面板刚开就被 A 的 140ms 定时器关掉（键盘 Tab 必现） */
      const tk = MTG.tagMenu._tk;
      setTimeout(() => { if (!MTG.tagMenu.hovering && MTG.tagMenu._tk === tk) MTG.tagMenu.close(); }, 140);
    });
    return inp;
  };

  /* 标签面板（全局单例，挂在 body 上，避免表格重绘时残留一堆浮层） */
  MTG.tagMenu = {
    el: null, input: null, key: null, hovering: false,
    _tk: 0,                       // 打开代际：旧 blur 定时器不得关闭新面板（R5-11）

    ensure() {
      if (this.el) return this.el;
      const el = document.createElement('div');
      el.className = 'tag-menu hidden';
      el.addEventListener('pointerdown', e => e.preventDefault());   // 别抢走 input 焦点
      el.addEventListener('mouseenter', () => { MTG.tagMenu.hovering = true; });
      el.addEventListener('mouseleave', () => { MTG.tagMenu.hovering = false; });
      document.body.appendChild(el);
      this.el = el;
      /* R5-12：面板是 fixed 一次性定位 —— 页面/表格滚动或窗口变化后会错位，
         直接关掉（比停在原地误导用户好） */
      const dismiss = () => { if (!el.classList.contains('hidden')) MTG.tagMenu.close(); };
      window.addEventListener('resize', dismiss);
      document.addEventListener('scroll', dismiss, true);
      return el;
    },

    open(input, key) {
      this.ensure();
      this._tk++;                 // 新面板：作废所有旧的延迟关闭（R5-11）
      this.input = input;
      this.key = key;
      this.build();
      this.place();
      this.el.classList.remove('hidden');
    },

    close() { if (this.el) this.el.classList.add('hidden'); },

    build() {
      const el = this.el;
      const list = MTG.tagOptions(this.key);
      const cur = ((this.input && this.input.value) || '').trim();
      let html = '';
      if (!list.length) {
        html += '<div class="tag-empty">还没有常用标签 —— 输入内容后点下方「存为常用标签」</div>';
      } else {
        html += list.map(t =>
          '<div class="tag-item' + (t === cur ? ' on' : '') + '" data-v="' + esc(t) + '">' +
          '<span>' + esc(t) + '</span><i class="tag-del" data-del="' + esc(t) + '" title="从常用标签里去掉">✕</i></div>'
        ).join('');
      }
      html += '<div class="tag-add"><button data-act="add">＋ 把输入框里的内容存为常用标签</button></div>';
      el.innerHTML = html;

      el.onclick = e => {
        const del = e.target.closest('[data-del]');
        if (del) {
          MTG.removeTagOption(this.key, del.dataset.del);
          this.build();
          return;
        }
        if (e.target.closest('[data-act="add"]')) {
          const v = ((this.input && this.input.value) || '').trim();
          if (!v) { MTG.toast('先在输入框里写点内容', true); return; }
          MTG.toast(MTG.addTagOption(this.key, v) ? '已加入常用标签：' + v : '这个标签已经在列表里了');
          this.build();
          return;
        }
        const item = e.target.closest('.tag-item');
        if (item) this.pick(item.dataset.v);
      };
    },

    pick(v) {
      if (!this.input) return;
      this.input.value = v;
      this.input.dispatchEvent(new Event('input', { bubbles: true }));   // 走调用方的 write
      this.close();
    },

    place() {
      if (!this.input) return;
      const el = this.el;
      const r = this.input.getBoundingClientRect();
      el.style.visibility = 'hidden';
      el.classList.remove('hidden');
      const h = el.offsetHeight, w = Math.max(el.offsetWidth, r.width);
      let left = r.left, top = r.bottom + 3;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 3);
      if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.style.minWidth = Math.max(120, r.width) + 'px';
      el.style.visibility = '';
    }
  };

  /* ── 状态 ── */
  MTG.state = {
    project: null,        // 工程数据（时间轴 + 素材引用）；未打开工程时为 null
    playhead: 0,
    pxPerSec: 60,
    snap: true,
    selectedClipIds: new Set(),   // 框选 / 多选
    currentBoardId: null, // 画板正在编辑的分镜帧 id
    activeTrackId: null,  // 选定的轨道：新建帧 / 放置素材都落在它上面
    color: '#eb684b',
    hsv: { h: 14, s: 70, v: 68 },
    tool: 'brush',
    layer: 'fg',
    brush: { size: 14, opacity: 100 },
    theme: localStorage.getItem('montage.theme') || 'dark',
    dirty: false
  };

  MTG.newProject = function (name) {
    return {
      version: 4,
      name: name || '未命名分镜',
      fps: 24,
      boardW: 1280, boardH: 720,          // 画布画幅（可在画板工具条更改）
      duration: 60,                       // 时间轴可视总长（秒），自动增长
      // 同剪辑软件习惯：画面轨在上，音频轨在下
      tracks: [
        { id: 'tr_board_1', name: '分镜 V1', kind: 'board', h: 78, muted: false, groupId: 'g_v1' },
        { id: 'tr_audio_1', name: '音频 A1', kind: 'audio', h: 62, muted: false, groupId: null }
      ],
      groups: [{ id: 'g_v1', name: '分镜 V1' }],   // 素材库分组（bins）
      clips: [],
      assets: [],                         // { id, name, kind, path, group }
      boards: []                          // { id, name, path, group }
    };
  };

  /* 旧工程升级：确保 groups 存在，分镜帧按其片段所在轨道归组 */
  MTG.migrateProject = function (p) {
    if (!p) return p;
    if (!p.boardW || !p.boardH) { p.boardW = 1280; p.boardH = 720; }
    p.groups = p.groups || [];
    p.tracks.forEach(t => {
      /* 分镜轨与音频轨都配素材分组（新建/迁移一致）：
         音频素材导入后要有个可改名、可整理的归处（用户反馈音频分组无处可改） */
      if ((t.kind === 'board' || t.kind === 'audio') && (!t.groupId || !p.groups.some(g => g.id === t.groupId))) {
        let g = p.groups.find(x => x.name === t.name);
        if (!g) { g = { id: U.uid('g'), name: t.name }; p.groups.push(g); }
        t.groupId = g.id;
      }
    });
    if (!p.groups.length) p.groups.push({ id: U.uid('g'), name: '未分组' });
    (p.clips || []).forEach(c => {                                  // v4/v4.1：镜头元数据迁移
      if (!c.meta) c.meta = {};
      const m = c.meta;
      if (m.voice != null && m.dialogue == null) m.dialogue = m.voice;   // 旧「声音」并入「对白/旁白」
      delete m.voice;
      const extra = [];
      if (m.angle && m.angle !== '视平') extra.push('机位 ' + m.angle);  // 角度/承托并入备注，不丢现场信息
      if (m.equip) extra.push('承托 ' + m.equip);
      if (extra.length) m.remark = extra.join(' · ') + (m.remark ? ' · ' : '') + (m.remark || '');
      delete m.angle;
      delete m.equip;
    });
    const byBoardTrack = {};
    (p.clips || []).forEach(c => { if (c.kind === 'board' && c.boardId) byBoardTrack[c.boardId] = c.trackId; });
    (p.boards || []).forEach(b => {
      if (b.group == null) {
        const tid = byBoardTrack[b.id];
        const tr = tid && p.tracks.find(t => t.id === tid);
        b.group = (tr && tr.groupId) || null;
      }
    });
    (p.assets || []).forEach(a => { if (a.group === undefined) a.group = null; });
    return p;
  };

  /* 轨道 → 素材库分组：没有就按轨道名建一个 */
  MTG.ensureTrackGroup = function (track) {
    const p = MTG.state.project;
    if (!p || !track) return null;
    if (track.groupId && p.groups.some(g => g.id === track.groupId)) return track.groupId;
    let g = p.groups.find(x => x.name === track.name) || null;
    if (!g) { g = { id: U.uid('g'), name: track.name }; p.groups.push(g); }
    track.groupId = g.id;
    return g.id;
  };

  /* ── 提示条 ── */
  let toastTimer = null;
  MTG.toast = function (msg, isErr) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2400);
  };

  MTG.markDirty = function () { MTG.state.dirty = true; };

  /* ── 工程查询助手 ── */
  MTG.findAsset = function (id) {
    const p = MTG.state.project;
    if (!p) return null;
    return p.assets.find(a => a.id === id) || null;
  };
  MTG.findBoard = function (id) {
    const p = MTG.state.project;
    if (!p) return null;
    return p.boards.find(b => b.id === id) || null;
  };
  MTG.findClip = function (id) {
    const p = MTG.state.project;
    if (!p) return null;
    return p.clips.find(c => c.id === id) || null;
  };
  MTG.findTrack = function (id) {
    const p = MTG.state.project;
    if (!p) return null;
    return p.tracks.find(t => t.id === id) || null;
  };
  MTG.projectEnd = function () {
    const p = MTG.state.project;
    if (!p) return 60;
    let end = 10;
    p.clips.forEach(c => { end = Math.max(end, (c.start || 0) + (c.dur || 1)); });
    return Math.max(end + 10, 20);
  };
  /* 真实内容末端（最后片段的结束时刻）：播放到此即停。
     projectEnd 是可视长度（尾部多留 10 秒方便往后拖放），拿它做播放终点会多播 10 秒静音（L-2） */
  MTG.contentEnd = function () {
    const p = MTG.state.project;
    if (!p) return 0;
    let end = 0;
    p.clips.forEach(c => { end = Math.max(end, (c.start || 0) + (c.dur || 1)); });
    return end;
  };
})();
