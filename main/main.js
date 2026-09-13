/* Fabula 主进程：窗口、fabula:// 自定义协议、工程 IPC、fs.watch 转发 */
const { app, BrowserWindow, protocol, net, ipcMain, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const store = require('./projectStore.js');

/* 渲染端代码从 src/ 以 ESM 加载。file:// 协议下 <script type=module> 的 import
   会被 CORS 拦下，所以注册 fabula:// 特权协议映射磁盘目录 */
const SRC_ROOT = path.normalize(path.join(__dirname, '..', 'src'));

protocol.registerSchemesAsPrivileged([
  { scheme: 'fabula', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

/* 开发期模块频繁改动：禁用 HTTP 磁盘缓存，杜绝 304 旧模块混入新页面 */
app.commandLine.appendSwitch('disable-http-cache');

function safeMappedFile(baseRoot, relRaw) {
  const rel = decodeURIComponent(relRaw).replace(/^\/+/, '');
  const abs = path.normalize(path.join(baseRoot, rel));
  if (!abs.startsWith(baseRoot + path.sep) && abs !== baseRoot) return null;
  return abs;
}

/* 文件响应统一加 no-cache：file 协议响应自带 Last-Modified，会被磁盘缓存
   条件请求复用 —— 开发期模块改了但页面拿旧版，症状是"改了没生效"的幽灵 bug */
async function respondFile(abs) {
  const resp = await net.fetch(pathToFileURL(abs).toString());
  const headers = new Headers(resp.headers);
  headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

/* fabula://app/<rel> → src/<rel>（渲染端代码） */
async function serveFromSrc(u) {
  const abs = safeMappedFile(SRC_ROOT, u.pathname);
  if (!abs) return new Response('forbidden', { status: 403 });
  return respondFile(abs);
}

/* fabula://proj/<rel> → 当前工程根/<rel>（镜头图片等，渲染端 <img>/fetch 直读） */
async function serveProjectFile(u) {
  const cur = store.current();
  if (!cur.root) return new Response('no project', { status: 404 });
  const abs = safeMappedFile(cur.root, u.pathname);
  if (!abs) return new Response('forbidden', { status: 403 });
  return respondFile(abs);
}

function createWindow() {
  const SMOKE = process.argv.some(a => a === '--smoke' || a.startsWith('--smoke-'));
  const sizeArg = (process.argv.find(a => a.startsWith('--smoke-size=')) || '').slice(13);
  const [winW, winH] = sizeArg ? sizeArg.split('x').map(Number) : [1600, 950];
  const win = new BrowserWindow({
    width: winW || 1600,
    height: winH || 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#151719',
    title: 'Fabula',
    autoHideMenuBar: true,
    /* 冒烟模式：把窗口放到屏幕外显示 —— show:false 的隐藏窗口 rAF 会被暂停，
       截图只能抓到旧帧（表现为"UI 永远停在空态"的假象，实测踩过） */
    show: true,
    x: SMOKE ? -4200 : undefined,
    y: SMOKE ? -4200 : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      /* 隐藏窗口（--smoke 冒烟）也必须持续渲染：否则 rAF 节流会让截图抓到旧帧 */
      backgroundThrottling: false
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error('[smoke] renderer gone:', d.reason);
  });
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (SMOKE && level >= 3) console.log('[page-err]', message, '@', sourceId, ':', line);
    else if (SMOKE && level >= 2 && /fabula-error|fabula-reject/.test(message)) {
      console.log('[page-warn]', message);
    }
  });
  win.loadURL('fabula://app/index.html');
  store.attachWindow(win);
  if (SMOKE) {
    const playDemo = process.argv.includes('--smoke-play');
    if (playDemo) {
      const fs = require('node:fs');
      const os = require('node:os');
      const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-demo-'));
      const dirUrl = demoDir.split(path.sep).join('/');
      /* 一张演示参考图（1×1 渐变 PNG 另存演示像素图：这里生成 64×36 的色块便于辨识） */
      const demoPng = path.join(demoDir, 'ref-strip.png');
      {
        const w = 64, h = 36;
        const raw = Buffer.alloc((w * 3 + 1) * h);
        for (let y = 0; y < h; y++) {
          raw[y * (w * 3 + 1)] = 0;
          for (let x = 0; x < w; x++) {
            const o = y * (w * 3 + 1) + 1 + x * 3;
            raw[o] = Math.round(255 * x / w); raw[o + 1] = 90; raw[o + 2] = Math.round(255 * y / h);
          }
        }
        const zlib = require('node:zlib');
        const crc32 = (buf) => {
          let c, crc = 0xffffffff;
          for (let n = 0; n < buf.length; n++) {
            c = (crc ^ buf[n]) & 0xff;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            crc = (crc >>> 8) ^ c;
          }
          return (crc ^ 0xffffffff) >>> 0;
        };
        const chunk = (type, data) => {
          const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
          const t = Buffer.from(type, 'latin1');
          const body = Buffer.concat([t, data]);
          const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body));
          return Buffer.concat([len, body, c]);
        };
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
        ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
        const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        fs.writeFileSync(demoPng, Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
      }
      win.webContents.on('did-finish-load', () => {
        win.webContents.executeJavaScript(
          'window.__fabulaTest ? window.__fabulaTest.run(' + JSON.stringify(dirUrl) + ',' + JSON.stringify(demoPng.split(path.sep).join('/')) + ') : "no-hook"'
        ).then(r => console.log('[smoke] demo run:', r))
         .catch(e => console.error('[smoke] demo fail:', e.message));
      });
    }
    setTimeout(async () => {
      try {
        if (playDemo) {
          const info = await win.webContents.executeJavaScript(
            'window.__fabulaTest.status()');
          console.log('[smoke] status:', info);
        }
        if (process.argv.includes('--smoke-light')) {
          const probe = await win.webContents.executeJavaScript(
            '(function(){ try { var has = !!window.__fabulaTheme; if (has) window.__fabulaTheme.set("light");'
            + ' return JSON.stringify({has: has, mode: has ? window.__fabulaTheme.mode() : null}); }'
            + ' catch(e){ return "err: " + e.message; } })()');
          console.log('[smoke] theme probe:', probe);
          await new Promise(r => setTimeout(r, 450));
        }
        if (process.argv.includes('--smoke-export')) {
          const fs2 = require('node:fs');
          const os2 = require('node:os');
          const dir = fs2.mkdtempSync(path.join(os2.tmpdir(), 'fabula-exp-'));
          const dirU = dir.split(path.sep).join('/');
          const r = await win.webContents.executeJavaScript(
            '(async function(){ var f = window.fabula.exp; var x = window.__fabulaExport; var out = {};'
            + ' out.seq = await f.imageSequence(' + JSON.stringify(dirU) + ');'
            + ' out.json = await f.backupJson(' + JSON.stringify(dirU + '/backup.json') + ');'
            + ' if (x) { out.png = await f.storyPng(await x.buildStoryPngDataUrl(), ' + JSON.stringify(dirU + '/story.png') + ');'
            + ' out.pdf = await f.storyPdf(await x.buildStoryHtml(), ' + JSON.stringify(dirU + '/story.pdf') + '); }'
            + ' return JSON.stringify(out); })()');
          console.log('[smoke] export:', r);
          console.log('[smoke] export files:', fs2.readdirSync(dir).join(','));
        }
        if (process.argv.includes('--smoke-loop')) {
          const r = await win.webContents.executeJavaScript(
            '(function(){ window.__fabulaPrefs.set("loop", true); window.__fabulaTransport.play();'
            + ' return window.__fabulaTest ? window.__fabulaTest.status() : "n/a"; })()');
          console.log('[smoke] loop status:', r);
          await new Promise(r2 => setTimeout(r2, 500));
        }
        const evalArg = (process.argv.find(a => a.startsWith('--smoke-eval=')) || '').slice(13);
        if (evalArg) {
          const r = await win.webContents.executeJavaScript(evalArg);
          console.log('[smoke-eval]', typeof r === 'object' ? JSON.stringify(r) : r);
        }
        if (process.argv.includes('--smoke-brush')) {
          await win.webContents.executeJavaScript('document.getElementById("btn-brush-set").click()');
          await new Promise(r => setTimeout(r, 450));
        }
        if (process.argv.includes('--smoke-settings')) {
          const tabArg = (process.argv.find(a => a.startsWith('--smoke-tab=')) || '').slice(12);
          await win.webContents.executeJavaScript('window.__fabulaSettingsPanel && window.__fabulaSettingsPanel.open()');
          if (tabArg) {
            await win.webContents.executeJavaScript('window.__fabulaSettingsPanel && window.__fabulaSettingsPanel.tab(' + JSON.stringify(tabArg) + ')');
          }
          await new Promise(r => setTimeout(r, 450));
        }
        if (process.argv.includes('--smoke-dark')) {
          await win.webContents.executeJavaScript('window.__fabulaTheme && window.__fabulaTheme.set("dark")');
          await new Promise(r => setTimeout(r, 400));
        }
        if (process.argv.includes('--smoke-accent')) {
          await win.webContents.executeJavaScript('window.__fabulaTheme && window.__fabulaTheme.accent("blue")');
          await new Promise(r => setTimeout(r, 350));
        }
        const viewArg = process.argv.find(a => a.startsWith('--smoke-view='));
        if (viewArg) {
          const vname = viewArg.split('=')[1];
          await win.webContents.executeJavaScript('window.__fabulaSetView && window.__fabulaSetView(' + JSON.stringify(vname) + ')');
          await new Promise(r => setTimeout(r, 400));
          console.log('[smoke] view set to', vname);
        }
        const fs = require('node:fs');
        /* --smoke-crop=x,y,w,h：区域放大截图（诊断局部排版用） */
        const cropArg = process.argv.find(a => a.startsWith('--smoke-crop='));
        const rect = cropArg
          ? (function () {
            const [x, y, w, h] = cropArg.split('=')[1].split(',').map(Number);
            return { x, y, width: w, height: h };
          })()
          : undefined;
        const img = await win.webContents.capturePage(rect);
        fs.writeFileSync(path.join(__dirname, '..', cropArg ? 'smoke-crop.png' : 'smoke-shot.png'), img.toPNG());
        console.log('[smoke] screenshot saved');
      } catch (e) { console.error('[smoke] capture failed:', e.message); }
      console.log('[smoke] window alive, exiting 0');
      app.exit(0);
    }, playDemo ? 8000 : 5000);
  }
  return win;
}

/* ---------- IPC：工程生命周期 ---------- */
ipcMain.handle('project:create', (_e, dirPath, name) => store.createProject(dirPath, name));
ipcMain.handle('project:openDialog', async () => {
  const r = await dialog.showOpenDialog({ title: '打开 / 新建工程文件夹', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  const dir = r.filePaths[0];
  /* IDE 语义：任意文件夹都可作为工作区。
     已有 fabula.json → 直开（损坏时把错误抛回渲染端提示）；
     没有 → 询问后在此创建新工程（不改动已有文件，只增 fabula.json 与 shots/）。 */
  if (require('node:fs').existsSync(path.join(dir, 'fabula.json'))) {
    return store.openDir(dir);
  }
  const m = await dialog.showMessageBox({
    type: 'question',
    buttons: ['在此创建工程', '取消'],
    defaultId: 0,
    cancelId: 1,
    message: '该文件夹还不是 Fabula 工程',
    detail: dir + '\n\n是否在此创建新工程？（将写入 fabula.json 与 shots/ 目录，不改动已有文件）',
  });
  if (m.response !== 0) return null;
  return store.createProject(dir, path.basename(dir));
});
ipcMain.handle('project:openDir', (_e, dirPath) => store.openDir(dirPath));
ipcMain.handle('project:save', (_e, json) => store.saveProject(json));
ipcMain.handle('project:current', () => store.current());
ipcMain.handle('project:writeShotImage', (_e, shotId, dataUrl) => store.writeShotImage(shotId, dataUrl));
ipcMain.handle('assets:importDialog', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '媒体', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp3', 'wav', 'ogg', 'flac', 'm4a'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return store.importAssets(r.filePaths);
});
/* 不经对话框的直接导入（测试/将来拖拽路径复用） */
ipcMain.handle('assets:importPaths', (_e, paths) => {
  if (!Array.isArray(paths)) throw new Error('需要路径数组');
  return store.importAssets(paths);
});

/* ---------- 导出 ----------
   安全约定：
   - 正常模式目标路径**只来自系统对话框**（用户显式选择）；渲染端传入的显式路径仅在
     冒烟/测试模式（--smoke 或 FABULA_EXPORT_TEST=1）被接受——防止渲染端被攻破后
     借 IPC 向任意路径写文件（纵深防御；单机桌面应用仍保持"导出到哪由用户选"）。
   - 不拼接 shell 命令；源文件路径均经工程模型白名单（shots/*.png）。 */
const fsx = require('node:fs');
const EXPLICIT_PATH_OK = process.argv.some((a) => a.startsWith('--smoke')) || process.env.FABULA_EXPORT_TEST === '1';
const explicitOr = (v) => (EXPLICIT_PATH_OK && typeof v === 'string' && v ? v : undefined);

ipcMain.handle('export:backupJson', async (_e, targetPath) => {
  const cur = store.current();
  if (!cur.root) return { ok: false, error: '未打开工程' };
  let dst = explicitOr(targetPath);
  if (!dst) {
    const r = await dialog.showSaveDialog({
      title: '导出工程 JSON 备份',
      defaultPath: (cur.project.name || 'fabula') + '.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    dst = r.filePath;
  }
  fsx.copyFileSync(path.join(cur.root, 'fabula.json'), dst);
  return { ok: true, path: dst };
});

ipcMain.handle('export:imageSequence', async (_e, dirPath) => {
  const cur = store.current();
  if (!cur.root) return { ok: false, error: '未打开工程' };
  let dstDir = explicitOr(dirPath);
  if (!dstDir) {
    const r = await dialog.showOpenDialog({ title: '选择导出文件夹', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    dstDir = r.filePaths[0];
  }
  const shots = (cur.project.shots || []);
  const map = [];
  let no = 0;
  for (const s of shots) {
    no += 1;
    if (!s.image) continue;                      // 空镜头：仅占序号说明，不产文件
    const src = path.join(cur.root, s.image);
    if (!fsx.existsSync(src)) { map.push({ file: null, shotId: s.id, no, missing: true }); continue; }
    const name = String(no).padStart(2, '0') + '.png';
    fsx.copyFileSync(src, path.join(dstDir, name));
    map.push({ file: name, shotId: s.id, no });
  }
  return { ok: true, dir: dstDir, count: map.filter((m) => m.file).length, map };
});

ipcMain.handle('export:storyPng', async (_e, dataUrl, targetPath) => {
  if (typeof dataUrl !== 'string' || !/^data:image\/png;base64,/.test(dataUrl)) {
    return { ok: false, error: '需要 PNG dataURL' };
  }
  let dst = explicitOr(targetPath);
  if (!dst) {
    const cur = store.current();
    const r = await dialog.showSaveDialog({
      title: '导出故事板 PNG',
      defaultPath: ((cur.project && cur.project.name) || 'fabula') + '-故事板.png',
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    dst = r.filePath;
  }
  fsx.writeFileSync(dst, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
  return { ok: true, path: dst };
});

ipcMain.handle('export:storyPdf', async (_e, html, targetPath) => {
  if (typeof html !== 'string' || html.length > 80 * 1024 * 1024) return { ok: false, error: 'HTML 无效或过大' };
  let dst = explicitOr(targetPath);
  if (!dst) {
    const cur = store.current();
    const r = await dialog.showSaveDialog({
      title: '导出故事板 PDF',
      defaultPath: ((cur.project && cur.project.name) || 'fabula') + '-故事板.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    dst = r.filePath;
  }
  const osx = require('node:os');
  const tmp = path.join(osx.tmpdir(), 'fabula-story-' + Date.now() + '.html');
  fsx.writeFileSync(tmp, html, 'utf8');
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await w.loadFile(tmp);
    const buf = await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    fsx.writeFileSync(dst, buf);
  } finally {
    w.destroy();
    try { fsx.rmSync(tmp); } catch (_) {}
  }
  return { ok: true, path: dst };
});

app.whenReady().then(() => {
  protocol.handle('fabula', (req) => {
    const u = new URL(req.url);
    return u.host === 'proj' ? serveProjectFile(u) : serveFromSrc(u);
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
