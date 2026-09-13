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

  const S = (MTG.storage = {
    mode: 'none',        // 'fsa' | 'none'
    root: null,          // FileSystemDirectoryHandle
    dirName: '',

    get ready() { return S.mode === 'fsa'; },

    /* 打开（或新建）工程文件夹。用户取消返回 null */
    async openFolder() {
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
    /* 安全读：不存在/无权限时返回 null 而不是抛错（素材类读取的统一入口） */
    async readBlob(path) {
      return S.readFile(path).catch(() => null);
    },
    async writeFile(path, blob) {
      const fh = await getFileHandle(path, true);
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      return path;
    },
    async deleteFile(path) {
      const parts = path.split('/').filter(Boolean);
      const name = parts.pop();
      try {
        let dir = S.root;
        for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: false });
        await dir.removeEntry(name);
        return true;
      } catch (e) { return false; }
    },

    /* 列出工程内可用媒体（排除 boards/ 与隐藏目录） */
    async listMedia() {
      const out = [];
      await walk(S.root, '', 0, out);
      return out.filter(f => f.kind !== 'other');
      async function walk(dir, prefix, depth, acc) {
        if (depth > 3) return;
        for await (const [name, h] of dir.entries()) {
          if (name.startsWith('.')) continue;
          if (h.kind === 'directory') {
            if (name === 'boards' || name === 'node_modules') continue;
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
        return null;
      }
    },
    async saveProject(proj) {
      const json = JSON.stringify(proj, null, 2);
      await S.writeFile(MTG.PROJECT_FILE, new Blob([json], { type: 'application/json' }));
      MTG.state.dirty = false;
    },

    /* 平台能力描述，用于顶栏标签 */
    describe() {
      if (S.mode === 'fsa') return { tag: '文件夹 · ' + S.dirName, name: S.dirName, bin: 'disk' };
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
