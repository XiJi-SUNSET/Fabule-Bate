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
      }));
    },

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
  };
})();
