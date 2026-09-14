/* 预加载：以 contextBridge 向渲染端暴露最小受控面（工程生命周期 + 变更事件）。
   所有 fs 操作都在主进程，渲染端拿不到 Node 能力。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fabula', {
  isDesktop: true,
  app: {
    /* 关窗前主进程先广播：渲染端 flush 完未存数据后调 closeReady() 放行（H-5） */
    onBeforeClose: (cb) => {
      ipcRenderer.on('app:before-close', () => cb());
    },
    closeReady: () => ipcRenderer.invoke('app:close-ready')
  },
  project: {
    create: (dirPath, name) => ipcRenderer.invoke('project:create', dirPath, name),
    openDialog: () => ipcRenderer.invoke('project:openDialog'),
    openDir: (dirPath) => ipcRenderer.invoke('project:openDir', dirPath),
    current: () => ipcRenderer.invoke('project:current'),
    writeShotImage: (shotId, dataUrl) => ipcRenderer.invoke('project:writeShotImage', shotId, dataUrl),
    /* 桌面存储后端（storage.js 的 electron 模式用）：相对工程根的读写 */
    writeFile: (rel, bytes) => ipcRenderer.invoke('project:writeFile', rel, bytes),
    deleteFile: (rel) => ipcRenderer.invoke('project:deleteFile', rel),
    listMedia: () => ipcRenderer.invoke('project:listMedia'),
    /* 外部（agent）或自身落盘后的变更通知；回调参数 { external, sources, at, files }
       sources: 'montage'（UI 模型）/ 'fabula'（冒烟自检）/ 'media'（帧图/素材文件）；
       media 变更时 files 携带被改文件的相对路径（渲染端逐键消费，见 app.js refreshMedia）。
       返回退订函数：重复初始化时不会累积监听（L-17）。 */
    onChanged: (cb) => {
      const h = (_e, info) => cb(info);
      ipcRenderer.on('project:changed', h);
      return () => { try { ipcRenderer.removeListener('project:changed', h); } catch (_) {} };
    }
  },
  assets: {
    /* 文件对话框多选 → 复制进工程 assets/ → 返回 { root, project, added, skipped } */
    importDialog: () => ipcRenderer.invoke('assets:importDialog'),
    importPaths: (paths) => ipcRenderer.invoke('assets:importPaths', paths)
  },
  exp: {
    /* 导出：目标路径缺省时弹系统对话框（用户显式选择）；测试/脚本可显式传入 */
    backupJson: (targetPath) => ipcRenderer.invoke('export:backupJson', targetPath),
    /* 仅冒烟自检用（--smoke-export 驱动，数据源是 fabula shots 模型）：
       正常 UI 导出走 shotFiles（montage 模型），两者数据源不同勿混用（R3 B-21） */
    imageSequence: (dirPath) => ipcRenderer.invoke('export:imageSequence', dirPath),
    /* 按渲染端 UI 模型导出帧图序列（01.png…，主进程弹目录对话框）（M-13）；
       dirPath 仅测试模式生效（N-B21） */
    shotFiles: (rels, dirPath) => ipcRenderer.invoke('export:shotFiles', rels, dirPath),
    storyPng: (dataUrl, targetPath) => ipcRenderer.invoke('export:storyPng', dataUrl, targetPath),
    storyPdf: (html, targetPath) => ipcRenderer.invoke('export:storyPdf', html, targetPath)
  }
});
