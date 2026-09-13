/* ============================================================
   brushes.js —— 笔刷兼容层
   ------------------------------------------------------------
   前端（笔刷条 / 参数滑杆 / 笔刷预设导入导出）原本直接依赖旧笔刷
   实现。融合后所有数据源换成绘画引擎：
     · 笔刷清单      ← engine.BRUSHES（名称与图标同引擎面板一致）
     · 参数读写      ← engine.P / setParam（实时生效）
     · 预设持久化    ← __fabulaPrefs('brushParams')
   本文件只做映射与持久化，不含任何绘制逻辑。
   ============================================================ */
(function () {
  'use strict';
  const MTG = (window.MTG = window.MTG || {});
  const E = () => window.__fabulaEngine;
  const prefs = () => window.__fabulaPrefs;

  /* 笔刷条只列绘制类笔刷：橡皮/填充/涂抹等属于工具，在工具栏与轮盘里 */
  const PAINT_BRUSHES = ['pen', 'pencil', 'marker', 'gouache', 'airbrush'];

  /* 参数区滑杆元数据：
     field 为引擎参数名（与 P 字段一一对应）；
     toUi / fromUi 负责 UI 整数与引擎浮点（含 -1 哨兵）的换算。 */
  const PARAM_META = {
    flow: {
      label: '流量', field: 'flow', min: 0, max: 100, step: 1,
      toUi: v => Math.round((v == null ? 1 : v) * 100), fromUi: v => v / 100,
    },
    hardness: {
      label: '硬度', field: 'hardness', min: 0, max: 100, step: 1,
      toUi: v => Math.round((v == null ? 0.55 : v) * 100), fromUi: v => v / 100,
    },
    grain: {
      label: '颗粒', field: 'grain', min: 0, max: 100, step: 1,
      toUi: v => Math.round((v == null ? 0 : v) * 100), fromUi: v => v / 100,
    },
    scatter: {
      label: '散布', field: 'spread', min: 0, max: 300, step: 5,
      toUi: v => Math.round((v == null ? 0 : v) * 100), fromUi: v => v / 100,
    },
  };

  /* 出厂参数：引擎当前 P 全量默认值 + 该笔刷在 BRUSHES 里的预设覆盖 */
  function defaultParams(id) {
    const e = E();
    const out = {};
    if (e && e.P) for (const k of Object.keys(e.P)) out[k] = e.P[k];
    const rec = e && e.BRUSHES && e.BRUSHES[id];
    if (rec && rec.p) for (const k of Object.keys(rec.p)) out[k] = rec.p[k];
    return out;
  }

  function savedParams(id) {
    try {
      const all = prefs() && prefs().get('brushParams');
      return all && all[id] ? all[id] : null;
    } catch (_) { return null; }
  }

  MTG.brushes = {
    /* 笔刷清单：取引擎注册表（惰性 getter，引擎晚加载也能取到） */
    get list() {
      const e = E();
      if (!e || !e.BRUSHES) return [];
      return PAINT_BRUSHES.filter(id => e.BRUSHES[id]).map(id => ({
        id,
        label: e.BRUSHES[id].name || id,
        icon: e.BRUSHES[id].icon || '',
        key: e.BRUSHES[id].key || '',
        params: ['flow', 'hardness', 'grain', 'scatter'],
      }));
    },

    get(id) { return MTG.brushes.list.find(b => b.id === id) || null; },

    get paramMeta() { return PARAM_META; },

    /* 载入参数：持久化的用户值覆盖出厂预设 */
    loadParams(id) {
      const out = defaultParams(id);
      const saved = savedParams(id);
      if (saved) for (const k of Object.keys(saved)) out[k] = saved[k];
      return out;
    },

    /* 保存参数：写入统一偏好（引擎在切笔/启动时会自动套用） */
    saveParams(id, obj) {
      if (!id || !obj) return;
      const p = prefs();
      if (!p) return;
      const plain = {};
      for (const k of Object.keys(obj)) plain[k] = obj[k];
      const all = p.get('brushParams') || {};
      all[id] = Object.assign({}, all[id], plain);
      p.set('brushParams', all);
    },

    /* 重置某支笔到出厂预设 */
    resetBrush(id) {
      const p = prefs();
      if (!p) return;
      const all = p.get('brushParams') || {};
      delete all[id];
      p.set('brushParams', all);
    },
  };
})();
