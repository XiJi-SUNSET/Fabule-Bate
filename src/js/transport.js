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
      const peaks = computePeaks(buffer, 1400);
      const rec = { buffer, peaks };
      A.cache.set(assetId, rec);
      return rec;
    },
    peek(assetId) { return A.cache.get(assetId) || null; },
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

  /* 波形峰值：分桶取绝对值最大的采样点 */
  function computePeaks(buffer, buckets) {
    const ch = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(ch.length / buckets));
    const n = Math.min(buckets, Math.ceil(ch.length / step));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let max = 0;
      const s = i * step, e = Math.min(ch.length, s + step);
      for (let j = s; j < e; j++) { const v = Math.abs(ch[j]); if (v > max) max = v; }
      out[i] = max;
    }
    return out;
  }
})();
