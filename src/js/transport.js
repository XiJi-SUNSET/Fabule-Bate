/* transport.js · 播放引擎
   用 Web Audio 按「片段在时间轴上的绝对位置」精确调度：
   播放时给每个音频片段算出 AudioContext 时间轴上的 start(when)，
   这样卡点位置与画面偏移严格一致，不受 JS 定时器抖动影响。
   同时负责音频解码与波形峰值缓存（峰值只存内存，不写进工程文件）。 */
(function () {
  'use strict';
  const MTG = window.MTG;

  const A = (MTG.audio = {
    ctx: null,
    master: null,
    cache: new Map(),      // assetId -> { buffer, peaks }
    sources: [],
    playing: false,
    origin: 0,             // ctx 时间轴原点：playhead = ctx.currentTime - origin
    raf: 0,

    ensure() {
      if (!A.ctx) {
        A.ctx = new (window.AudioContext || window.webkitAudioContext)();
        A.master = A.ctx.createGain();
        A.master.gain.value = 0.9;
        A.master.connect(A.ctx.destination);
      }
      if (A.ctx.state === 'suspended') A.ctx.resume();
      return A.ctx;
    },

    /* 解码音频并缓存波形峰值 */
    async load(assetId, blob) {
      if (A.cache.has(assetId)) return A.cache.get(assetId);
      A.ensure();
      const arr = await blob.arrayBuffer();
      const buffer = await A.ctx.decodeAudioData(arr);
      const wave = buildWave(buffer);
      const rec = { buffer, wave };
      A.cache.set(assetId, rec);
      return rec;
    },
    peek(assetId) { return A.cache.get(assetId) || null; },
    /* 波形数据层自检口（冒烟/调试）：合成 buffer 直接验证金字塔正确性 */
    __test: { buildWave },
    durationOf(assetId) {
      const r = A.cache.get(assetId);
      return r ? r.buffer.duration : 0;
    },
    async ensureLoaded(clips) {
      if (!MTG.storage.ready) return;
      for (const c of clips) {
        if (c.kind !== 'audio' || A.cache.has(c.assetId)) continue;
        const a = MTG.findAsset(c.assetId);
        if (!a) continue;
        const blob = await MTG.storage.readBlob(a.path);
        if (blob) { try { await A.load(a.id, blob); } catch (e) { console.warn('解码失败', a.name, e); } }
      }
    },

    play() {
      const p = MTG.state.project;
      if (!p) return;
      A.ensure();
      A.stopSources();
      A.origin = A.ctx.currentTime + 0.04 - MTG.state.playhead;
      const clips = p.clips.filter(c => c.kind === 'audio');
      clips.forEach(c => {
        const tr = MTG.findTrack(c.trackId);
        if (tr && tr.muted) return;
        const rec = A.cache.get(c.assetId);
        if (!rec) return;
        let when = A.origin + c.start;
        let offset = c.offset || 0;
        let dur = c.dur;
        if (when < A.ctx.currentTime) {          // 起播点已在片段中间
          const late = A.ctx.currentTime - when;
          offset += late; when = A.ctx.currentTime; dur -= late;
        }
        if (dur <= 0) return;
        const src = A.ctx.createBufferSource();
        src.buffer = rec.buffer;
        const g = A.ctx.createGain();
        g.gain.value = c.gain == null ? 1 : c.gain;
        src.connect(g); g.connect(A.master);
        src.start(when, offset, Math.min(dur, rec.buffer.duration - offset));
        A.sources.push(src);
      });
      A.playing = true;
      MTG.ui && MTG.ui.onPlayState && MTG.ui.onPlayState(true);
      cancelAnimationFrame(A.raf);
      tick();
    },

    pause() {
      A.playing = false;
      MTG.ui && MTG.ui.onPlayState && MTG.ui.onPlayState(false);
      A.stopSources();
      cancelAnimationFrame(A.raf);
    },

    stop() {
      A.pause();
      MTG.setPlayhead(0);
    },

    stopSources() {
      A.sources.forEach(s => { try { s.stop(); } catch (e) {} });
      A.sources = [];
    },

    /* 播放中重排音频调度（片段布局变化后调用）：
       已调度的 WebAudio source 不会自己搬家/停止 —— 移动、裁剪、删除、上轨
       都要重排才能在播放中即时听到新布局（PR 语义）。非播放态是空操作。 */
    rescheduleIfPlaying() {
      if (!A.playing) return false;
      try { A.play(); return true; } catch (_) { return false; }
    }
  });

  function tick() {
    if (!A.playing) return;
    const t = A.ctx.currentTime - A.origin;
    MTG.setPlayhead(t, true);
    /* 播到真实内容末端就停（projectEnd 可视长度尾部多 10 秒，此前会多播 10 秒静音，L-2）。
       没有片段时退回 projectEnd 以免永不停机。 */
    const end = (MTG.contentEnd && MTG.contentEnd()) || MTG.projectEnd();
    if (t >= end) { A.pause(); MTG.setPlayhead(end); return; }
    A.raf = requestAnimationFrame(tick);
  }

  /* 波形峰值金字塔（DAW / 剪辑软件通用做法，替代旧的"固定 1400 桶 abs-max"）：
     · 多级 min/max 对：每桶 256 / 1024 / 4096 / 16384 / 65536 采样，
       渲染时按"每列覆盖采样数"选级 —— 缩小有足够多的桶、放大能退回原始采样；
     · min/max 而非 abs-max：上下包络独立，非对称波形不失真（旧的对称化会显得假）；
     · 立体声并集：min 取两声道更小、max 取更大，包络不丢能量。
     内存：5 级合计 ≈ 首级的 1.33 倍（约为原始 PCM 的 0.5%），随 buffer 一起常驻缓存。 */
  const WAVE_LEVELS = [256, 1024, 4096, 16384, 65536];
  function buildWave(buffer) {
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    const len = ch0.length;
    const levels = [];
    for (const step of WAVE_LEVELS) {
      if (step > len) break;                       // 比数据还长的桶没有意义
      const n = Math.ceil(len / step);
      const mn = new Float32Array(n);
      const mx = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const s = i * step, e = Math.min(len, s + step);
        let lo = 1, hi = -1;
        for (let j = s; j < e; j++) {
          const a = ch0[j];
          if (a < lo) lo = a; if (a > hi) hi = a;
          if (ch1) { const b = ch1[j]; if (b < lo) lo = b; if (b > hi) hi = b; }
        }
        mn[i] = lo; mx[i] = hi;
      }
      levels.push({ step, min: mn, max: mx });
    }
    return { levels, len };
  }
})();
