/* storage.js · 工程存储层
   v0.3 起只认真实文件夹（同 Premiere 的工程文件模型）：
     - 「打开文件夹」= 打开或新建工程：有 montage.json 就加载，没有就创建
     - montage.json 只记录时间轴与素材的相对路径引用，二进制原地存文件夹
     - 不再使用 IndexedDB / localStorage 存工程，浏览器里不残留任何项目缓存
       （启动时会顺手清掉 v0.2 遗留的 montage-db 数据库） */
(function () {
  'use strict';
  const MTG = window.MTG;
  const U = MTG.util;

  /* 桌面桥（Electron）：有 window.fabula 时不走 FSA —— 打开工程用主进程的
     系统目录对话框（project.openDialog），文件读写走 IPC 后端。
     FSA 的 showDirectoryPicker 在选择器还挂着时重复调用会抛
     "File picker already active"，所以两条路径都加并发保护。 */
  const FN = () => (window.fabula && window.fabula.project) || null;
  let picking = false;

  const S = (MTG.storage = {
    mode: 'none',        // 'fsa'（浏览器）| 'electron'（桌面）| 'none'
    root: null,          // FileSystemDirectoryHandle（仅 fsa 模式）
    dirName: '',

    get ready() { return S.mode === 'fsa' || S.mode === 'electron'; },

    /* 打开（或新建）工程文件夹。用户取消返回 null */
    async openFolder() {
      if (picking) return null;                 // 选择器已在弹出/未收尾：忽略重复点击
      picking = true;
      try { return await (FN() ? S._openDesktop() : S._openBrowser()); }
      finally { picking = false; }
    },

    /* 桌面：主进程弹目录对话框（已有 fabula.json 直开，否则询问后创建） */
    async _openDesktop() {
      let snap = null;
      try {
        snap = await FN().openDialog();
      } catch (err) {
        /* 主进程拒绝（含"工程版本过新"L-16）：把原因说清楚，别让 promise 悬空报 unhandled */
        MTG.toast('打开工程失败：' + ((err && err.message) || err), true);
        return null;
      }
      if (!snap || !snap.root) return null;
      S.mode = 'electron';
      S.dirName = snap.root.split(/[\\/]/).filter(Boolean).pop() || '';
      return 'electron';
    },

    /* 浏览器：File System Access API */
    async _openBrowser() {
      if (!('showDirectoryPicker' in window)) {
        MTG.toast('当前浏览器不支持文件夹访问，请用 Chrome / Edge', true);
        return null;
      }
      let h;
      try {
        h = await window.showDirectoryPicker({ id: 'montage', mode: 'readwrite' });
      } catch (e) {
        if (e && e.name === 'AbortError') return null;   // 用户取消
        console.warn('[storage] 打开文件夹失败：', e);
        MTG.toast('打开文件夹失败：' + e.message, true);
        return null;
      }
      const opt = { mode: 'readwrite' };
      let st = await h.queryPermission(opt).catch(() => 'prompt');
      if (st === 'prompt') st = await h.requestPermission(opt).catch(() => 'denied');
      if (st !== 'granted') { MTG.toast('未获得文件夹读写权限', true); return null; }

      S.root = h; S.mode = 'fsa'; S.dirName = h.name;
      return 'fsa';
    },

    /* ── 文件接口 ── */
    async readFile(path) {
      const fh = await getFileHandle(path, false);
      return fh ? fh.getFile() : null;
    },
    /* 安全读：不存在/无权限时返回 null 而不是抛错（素材类读取的统一入口）。
       桌面模式经 fabula://proj 协议直读（主进程已映射到工程根并放行 CORS）。 */
    async readBlob(path) {
      if (S.mode === 'electron') {
        try {
          const res = await fetch('fabula://proj/' + path);
          return res.ok ? await res.blob() : null;
        } catch (_) { return null; }
      }
      return S.readFile(path).catch(() => null);
    },
    async writeFile(path, blob) {
      if (S.mode === 'electron') {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await FN().writeFile(path, bytes);
        return path;
      }
      const fh = await getFileHandle(path, true);
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      return path;
    },
    async deleteFile(path) {
      if (S.mode === 'electron') return !!(await FN().deleteFile(path).catch(() => false));
      const parts = path.split('/').filter(Boolean);
      const name = parts.pop();
      try {
        let dir = S.root;
        for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: false });
        await dir.removeEntry(name);
        return true;
      } catch (e) { return false; }
    },
    /* 删除素材的默认通道：桌面版移入系统回收站（误删可恢复），
       浏览器版没有回收站概念，退回直接删除 */
    async trashFile(path) {
      if (S.mode === 'electron') return !!(await FN().trashFile(path).catch(() => false));
      return S.deleteFile(path);
    },

    /* 列出工程内可用媒体（排除 boards/ 与隐藏目录） */
    async listMedia() {
      if (S.mode === 'electron') return await FN().listMedia().catch(() => []);
      const out = [];
      await walk(S.root, '', 0, out);
      return out.filter(f => f.kind !== 'other');
      async function walk(dir, prefix, depth, acc) {
        if (depth > 3) return;
        for await (const [name, h] of dir.entries()) {
          if (name.startsWith('.')) continue;
          if (h.kind === 'directory') {
            /* 与桌面版 listMedia 的排除集保持一致（boards/ 与 shots/ 里的帧图
               不作为「素材」列出；曾经浏览器版漏排除 shots/，同工程两端列表不一致，L-9） */
            if (name === 'boards' || name === 'shots' || name === 'node_modules') continue;
            await walk(h, prefix + name + '/', depth + 1, acc);
          } else {
            const path = prefix + name;
            acc.push({ path, name, kind: U.kindOf(name) });
          }
        }
      }
    },

    /* ── 工程读写 ── */
    async loadProject() {
      const blob = await S.readBlob(MTG.PROJECT_FILE);
      if (!blob) return null;
      try {
        const json = JSON.parse(await blob.text());
        if (!json.tracks) json.tracks = MTG.newProject().tracks;
        json.groups = json.groups || [];
        json.assets = json.assets || [];
        json.boards = json.boards || [];
        json.clips = json.clips || [];
        return json;
      } catch (e) {
        MTG.toast('工程文件解析失败：' + e.message, true);
        /* 抛出带标记的错误：调用方据此中止打开，避免把"解析失败"当成
           "没有工程"而新建并覆盖原文件（M-1） */
        const err = new Error('工程文件解析失败：' + e.message);
        err.parseFailed = true;
        throw err;
      }
    },
    async saveProject(proj) {
      const json = JSON.stringify(proj, null, 2);
      const blob = () => new Blob([json], { type: 'application/json' });
      try {
        await S.writeFile(MTG.PROJECT_FILE, blob());
      } catch (err) {
        /* 与 Agent 抢锁失败（main 侧 5s 超时抛错，R3 D-2）→ 退避重试一次；
           仍失败则抛出，由调用方保留 dirty 并提示（不再是"降级无锁写"） */
        if (!/正被其它进程写入/.test(String((err && err.message) || err))) throw err;
        await new Promise(r => setTimeout(r, 800));
        await S.writeFile(MTG.PROJECT_FILE, blob());
      }
      MTG.state.dirty = false;
    },

    /* 平台能力描述，用于顶栏标签 */
    describe() {
      if (S.mode === 'fsa' || S.mode === 'electron') {
        return { tag: '文件夹 · ' + S.dirName, name: S.dirName, bin: 'disk' };
      }
      return { tag: '未打开工程', name: '', bin: 'none' };
    }
  });

  async function getFileHandle(path, create) {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    try {
      let dir = S.root;
      for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: !!create });
      return await dir.getFileHandle(name, { create: !!create });
    } catch (e) {
      if (create) throw e;
      return null;
    }
  }
})();
