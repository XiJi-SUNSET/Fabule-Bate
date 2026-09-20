/* 主进程和渲染端共享 montage v4 的最小结构校验。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MTG.projectFormat = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  function parse(text) {
    const p = JSON.parse(text);
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('工程内容必须是对象');
    if (p.version != null && (!Number.isFinite(p.version) || p.version > 4)) throw new Error('工程版本不受支持，请升级 Fabula');
    for (const key of ['tracks', 'groups', 'assets', 'boards', 'clips']) {
      if (p[key] == null) continue;
      if (!Array.isArray(p[key]) || p[key].some(x => !x || typeof x !== 'object' || Array.isArray(x))) {
        throw new Error('工程字段 ' + key + ' 格式错误');
      }
    }
    for (const key of ['boardW', 'boardH']) {
      if (p[key] != null && (!Number.isFinite(p[key]) || p[key] <= 0 || p[key] > 4096)) throw new Error('画幅尺寸无效');
    }
    for (const clip of p.clips || []) {
      for (const key of ['start', 'dur', 'offset']) {
        if (clip[key] != null && (!Number.isFinite(clip[key]) || clip[key] < 0)) throw new Error('片段时间无效');
      }
    }
    return p;
  }
  return { parse };
});
