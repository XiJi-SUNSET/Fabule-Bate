/* 预加载：以 contextBridge 向渲染端暴露最小受控面（工程生命周期 + 变更事件）。
   所有 fs 操作都在主进程，渲染端拿不到 Node 能力。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fabula', {
  isDesktop: true,
  project: {
    create: (dirPath, name) => ipcRenderer.invoke('project:create', dirPath, name),
    openDialog: () => ipcRenderer.invoke('project:openDialog'),
    openDir: (dirPath) => ipcRenderer.invoke('project:openDir', dirPath),
    save: (json) => ipcRenderer.invoke('project:save', json),
    current: () => ipcRenderer.invoke('project:current'),
    writeShotImage: (shotId, dataUrl) => ipcRenderer.invoke('project:writeShotImage', shotId, dataUrl),
    /* 桌面存储后端（storage.js 的 electron 模式用）：相对工程根的读写 */
    writeFile: (rel, bytes) => ipcRenderer.invoke('project:writeFile', rel, bytes),
    deleteFile: (rel) => ipcRenderer.invoke('project:deleteFile', rel),
    listMedia: () => ipcRenderer.invoke('project:listMedia'),
    /* 外部（agent）或自身落盘后的变更通知；回调参数 { external, at } */
    onChanged: (cb) => {
      ipcRenderer.on('project:changed', (_e, info) => cb(info));
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
    imageSequence: (dirPath) => ipcRenderer.invoke('export:imageSequence', dirPath),
    storyPng: (dataUrl, targetPath) => ipcRenderer.invoke('export:storyPng', dataUrl, targetPath),
    storyPdf: (html, targetPath) => ipcRenderer.invoke('export:storyPdf', html, targetPath)
  }
});
