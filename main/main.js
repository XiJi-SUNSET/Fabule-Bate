/* Fabula 主进程：窗口、fabula:// 自定义协议、工程 IPC、fs.watch 转发 */
const { app, BrowserWindow, protocol, net, ipcMain, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const store = require('./projectStore.js');

/* 冒烟模式全局标志（自定义协议/单实例锁/关窗握手等都要区分） */
const SMOKE = process.argv.some((a) => a === '--smoke' || a.startsWith('--smoke-'));

/* 主进程异常兜底（M-8）：未捕获异常/拒绝至少留下可查的日志，不让进程静默死掉 */
process.on('uncaughtException', (err) => console.error('[main] uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('[main] unhandledRejection:', err));

/* 单实例锁（M-7）：双开会让两个进程互写指针文件/工程文件、互触发 fs.watch。
   冒烟模式豁免（自动化需要连续起进程）。第二实例：聚焦已有窗口。 */
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
}

/* 冒烟日志落盘：Windows GUI 进程的 stdout 在终端拿不到（console.log 静默丢失），
   冒烟模式下把 console 输出镜像一份到 smoke.log，跑完直接读文件核对 */
if (SMOKE) {
  const fsx = require('node:fs');
  const LOG = path.join(__dirname, '..', 'smoke.log');
  try { fsx.writeFileSync(LOG, ''); } catch (_) {}
  const mirror = (fn) => (...a) => {
    const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n';
    try { fsx.appendFileSync(LOG, line); } catch (_) {}
    fn(...a);
  };
  console.log = mirror(console.log.bind(console));
  console.error = mirror(console.error.bind(console));
}

/* 渲染端代码从 src/ 以 ESM 加载。file:// 协议下 <script type=module> 的 import
   会被 CORS 拦下，所以注册 fabula:// 特权协议映射磁盘目录 */
const SRC_ROOT = path.normalize(path.join(__dirname, '..', 'src'));

protocol.registerSchemesAsPrivileged([
  { scheme: 'fabula', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

/* 开发期模块频繁改动：禁用 HTTP 磁盘缓存，杜绝 304 旧模块混入新页面 */
app.commandLine.appendSwitch('disable-http-cache');

function safeMappedFile(baseRoot, relRaw) {
  let rel;
  try { rel = decodeURIComponent(relRaw); } catch (_) { return null; }   // 畸形 % 序列：按非法路径拒绝（L-11）
  rel = rel.replace(/^\/+/, '');
  const abs = path.normalize(path.join(baseRoot, rel));
  if (!abs.startsWith(baseRoot + path.sep) && abs !== baseRoot) return null;
  return abs;
}

/* Windows 文件系统大小写不敏感且会剥尾点/尾空格：拒绝 fabula.json（N-A3）
   必须按"归一化后的 basename"判定 —— 字符串直比可被 FABULA.JSON / fabula.json. /
   x/../fabula.json 等写法绕过。 */
function normBaseOf(abs) {
  return path.basename(abs).replace(/[. ]+$/, '').toLowerCase();
}
function isProtectedBase(abs) {
  return normBaseOf(abs) === 'fabula.json';
}

/* 与 MCP 的读-改-写共享同一个锁文件（<root>/montage.json.lock，N-A1）。
   超时**不再降级为无锁写**（R3 D-2）：无锁全量覆写会静默吞掉 agent 刚写的更新，
   且自写抑制使这次丢更新不会被回环广播暴露（双向静默）——宁可失败让调用方重试。
   三参数与 MCP 对齐（R3 D-5）：陈锁阈值 10s / 等待超时 5s / 轮询 30ms。
   只有自己成功创建的锁才删除。 */
function withProjectLock(absPath, fn, timeoutMs = 5000) {
  const fsn = require('node:fs');
  const lock = absPath + '.lock';
  let held = false;
  const t0 = Date.now();
  for (;;) {
    try {
      const fd = fsn.openSync(lock, 'wx');
      fsn.writeSync(fd, String(process.pid));
      fsn.closeSync(fd);
      held = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') break;                    // 其它错误（如文件系统不支持 wx）：尽力写
      try {
        const st = fsn.statSync(lock);
        if (Date.now() - st.mtimeMs > 10000) { fsn.rmSync(lock, { force: true }); continue; }
      } catch (_) {}
      if (Date.now() - t0 > timeoutMs) {
        throw new Error('工程正被其它进程写入（montage.json.lock），请稍后重试');
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
  }
  try { return fn(); }
  finally { if (held) { try { fsn.rmSync(lock, { force: true }); } catch (_) {} } }
}

/* 纵深防御（M-10）：create/openDir/importPaths 只接受"本会话经系统对话框选过"的路径，
   与导出通道「只认对话框」的约定一致；冒烟/测试模式豁免（自动化需要直接注入路径）。 */
const approvedDirs = new Set();
const approvedFiles = new Set();
const approvePath = (set, p) => { try { set.add(path.normalize(path.resolve(p))); } catch (_) {} };
const isApprovedPath = (set, p) => {
  /* 只豁免冒烟模式（R3 D-6）：此前把 FABULA_EXPORT_TEST 复用为整个白名单
     的总开关，任何置 1 的环境（CI/脚本）下 create/openDir/importPaths
     三处守卫全部旁路。导出测试的显式路径由 EXPLICIT_PATH_OK 单独控制。 */
  if (SMOKE) return true;
  try { return set.has(path.normalize(path.resolve(p))); } catch (_) { return false; }
};

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
/* 渲染端只需读媒体与 montage.json；fabula.json（含全部镜头数据）不允许直读（H-6） */
const PROJ_EXT_ALLOW = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif',
  '.json', '.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac']);
async function serveProjectFile(u, req) {
  const cur = store.current();
  if (!cur.root) return new Response('no project', { status: 404 });
  const abs = safeMappedFile(cur.root, u.pathname);
  if (!abs) return new Response('forbidden', { status: 403 });
  const ext = path.extname(abs).toLowerCase();
  if (!PROJ_EXT_ALLOW.has(ext) || isProtectedBase(abs)) {
    return new Response('forbidden', { status: 403 });   // 类型白名单 + fabula.json 拒读（N-A3）
  }
  const resp = await respondFile(abs);
  /* CORS 收窄（H-6）：只回显应用自身源，不再通配 *（防被其它源读取工程文件） */
  const org = (req && req.headers && req.headers.get('origin')) || '';
  if (org === 'fabula://app') resp.headers.set('Access-Control-Allow-Origin', org);
  return resp;
}

/* 关窗握手（H-5）：主进程拦下 close → 广播让渲染端 flush 未存数据 → 渲染端回
   app:close-ready 才真正关闭。3 秒兜底防止渲染端卡死导致窗口关不掉。 */
let closeReady = false;
ipcMain.handle('app:close-ready', (e) => {
  closeReady = true;
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) w.close();
});

function createWindow() {
  closeReady = false;
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
      sandbox: true,          /* preload 只用 contextBridge/ipcRenderer，沙箱完全够用（H-6） */
      spellcheck: false,
      /* 隐藏窗口（--smoke 冒烟）也必须持续渲染：否则 rAF 节流会让截图抓到旧帧 */
      backgroundThrottling: false
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error('[renderer gone]', d.reason);
    /* 白屏不能只留一行日志（M-8）：提示用户后重载界面（未落盘笔迹可能丢失，需用户知情） */
    if (!SMOKE) {
      try {
        dialog.showMessageBox(win, {
          type: 'error',
          message: '界面进程异常退出',
          detail: '原因：' + d.reason + '\n点击确定将重新加载界面（未保存的笔迹可能丢失）',
        }).then(() => { if (!win.isDestroyed()) win.reload(); }).catch(() => {});
      } catch (_) {}
    }
  });
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (SMOKE && level >= 3) console.log('[page-err]', message, '@', sourceId, ':', line);
    else if (SMOKE && level >= 2 && /fabula-error|fabula-reject/.test(message)) {
      console.log('[page-warn]', message);
    }
  });
  win.on('close', (e) => {
    if (closeReady || SMOKE) return;                 // 冒烟走 app.exit，不参与握手
    e.preventDefault();
    try { win.webContents.send('app:before-close'); } catch (_) {}
    setTimeout(() => {
      if (!closeReady && !win.isDestroyed()) {       // 兜底：flush 卡住也不能关不掉
        closeReady = true;
        win.destroy();
      }
    }, 3000);
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
          /* 笔刷 UI 入口随版本演进：优先旧 id，回退到笔刷清单里的第一个按钮 */
          const r = await win.webContents.executeJavaScript(
            '(function(){ var el = document.getElementById("btn-brush-set")'
            + ' || document.querySelector("#brush-list button")'
            + ' || document.querySelector("#brush-params button");'
            + ' if (!el) return "no-brush-ui"; el.click();'
            + ' return "clicked:" + (el.id || el.className || el.tagName); })()');
          console.log('[smoke] brush:', r);
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
ipcMain.handle('project:create', (_e, dirPath, name) => {
  if (!isApprovedPath(approvedDirs, dirPath)) throw new Error('仅接受经系统对话框选择的目录（M-10）');
  return store.createProject(dirPath, name);
});
ipcMain.handle('project:openDialog', async () => {
  const r = await dialog.showOpenDialog({ title: '打开 / 新建工程文件夹', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  const dir = r.filePaths[0];
  approvePath(approvedDirs, dir);        // 登记：本会话允许对该目录做 create/openDir（M-10）
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
ipcMain.handle('project:openDir', (_e, dirPath) => {
  if (!isApprovedPath(approvedDirs, dirPath)) throw new Error('仅接受经系统对话框选择的目录（M-10）');
  return store.openDir(dirPath);
});
/* project:save 已删除（H-7）：它把渲染端模型 normalize 成 shots 模型写 fabula.json，
   渲染端模型（tracks/clips）会被静默丢弃 —— 渲染端从未调用，留着是埋雷。
   真正的保存走 project:writeFile 写 montage.json。 */
ipcMain.handle('project:current', () => store.current());
ipcMain.handle('project:writeShotImage', (_e, shotId, dataUrl) => store.writeShotImage(shotId, dataUrl));

/* 渲染端存储后端（Electron 桌面模式）：浏览器侧用 FSA 句柄，桌面侧走这几条 IPC。
   相对路径一律经 safeMappedFile 白名单映射，越界拒绝。 */
ipcMain.handle('project:writeFile', (_e, rel, bytes) => {
  const cur = store.current();
  if (!cur.root) throw new Error('未打开工程');
  const r = String(rel || '');
  const abs = safeMappedFile(cur.root, r);
  if (!abs) throw new Error('路径越界');
  /* fabula.json 由主进程/MCP 维护（N-A3：按归一化 basename 判定，防大小写/尾点绕过） */
  if (isProtectedBase(abs)) throw new Error('fabula.json 由主进程维护，禁止渲染端直写');
  /* 统一原子写（tmp + rename）：montage.json 每 4 秒 autosave 走这里，
     直写断电会留半个 JSON（M-1） */
  const buf = Buffer.from(bytes);
  if (normBaseOf(abs) === 'montage.json') {                    // 归一化判定：montage.json. 之类也走锁
    withProjectLock(abs, () => store.writeAtomic(abs, buf));   // 与 Agent 的读-改-写互斥（N-A1）
    store.markSelfWrite('montage.json', buf.toString('utf8')); // watch 回环抑制
  } else {
    store.writeAtomic(abs, buf);
  }
  /* 帧图/素材也是 UI 自写：登记以抑制 media 广播（否则每次保存都打断作画，N-A5 修订）。
     登记键用 normalize 后的相对路径（R3 B-15）：x/../boards/a.png 之类绕行写法
     也归一到 boards/a.png，不会漏登记造成回环广播 */
  const relNorm = path.normalize(String(r || '')).replace(/\\/g, '/');
  if (/^(boards|assets|shots)\//.test(relNorm)) store.markSelfMedia(relNorm);
  return rel;
});
ipcMain.handle('project:deleteFile', (_e, rel) => {
  const cur = store.current();
  if (!cur.root) return false;
  const abs = safeMappedFile(cur.root, String(rel || ''));
  if (!abs) return false;
  if (isProtectedBase(abs)) return false;      // fabula.json 不可删（N-A3）
  try { require('node:fs').rmSync(abs, { force: true }); return true; } catch (_) { return false; }
});
ipcMain.handle('project:listMedia', () => {
  const cur = store.current();
  if (!cur.root) return [];
  const AUDIO = ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac'];
  const IMAGE = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'];
  const out = [];
  (function walk(dir, prefix, depth) {
    if (depth > 3) return;
    let ents = [];
    try { ents = require('node:fs').readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const it of ents) {
      if (it.name.startsWith('.')) continue;
      if (it.isDirectory()) {
        if (it.name === 'boards' || it.name === 'shots' || it.name === 'node_modules') continue;
        walk(path.join(dir, it.name), prefix + it.name + '/', depth + 1);
      } else {
        const ext = (it.name.split('.').pop() || '').toLowerCase();
        const kind = AUDIO.includes(ext) ? 'audio' : (IMAGE.includes(ext) ? 'image' : 'other');
        if (kind !== 'other') out.push({ path: prefix + it.name, name: it.name, kind });
      }
    }
  })(cur.root, '', 0);
  return out;
});
ipcMain.handle('assets:importDialog', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '媒体', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp3', 'wav', 'ogg', 'flac', 'm4a'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  r.filePaths.forEach((p) => approvePath(approvedFiles, p));   // 登记允许导入的文件（M-10）
  return store.importAssets(r.filePaths);
});
/* 不经对话框的直接导入：只接受本会话经对话框选过的文件；冒烟/测试模式豁免（M-10） */
ipcMain.handle('assets:importPaths', (_e, paths) => {
  if (!Array.isArray(paths)) throw new Error('需要路径数组');
  for (const p of paths) {
    if (!isApprovedPath(approvedFiles, p)) throw new Error('仅接受经系统对话框选择的文件（M-10）');
  }
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
  /* 备份当前工程（montage 模型）——与浏览器分支同源（R3 D-7）；
     此前读 fabula.json，桌面用户拿到的备份与当前工程无关。
     montage.json 不存在（极老工程）才回退 fabula.json，并如实告知来源。 */
  const mont = path.join(cur.root, 'montage.json');
  const src = fsx.existsSync(mont) ? mont : path.join(cur.root, 'fabula.json');
  if (!fsx.existsSync(src)) return { ok: false, error: '工程文件不存在（montage.json / fabula.json）' };
  /* 备份动作本身也要原子：直写覆盖，断电两头皆失（M-5） */
  store.writeAtomic(dst, fsx.readFileSync(src));
  return { ok: true, path: dst, source: path.basename(src) };
});

/* 冒烟自检专用（fabula shots 模型，数据源是 main 进程维护的 fabula.json）；
   正常 UI 导出走 export:shotFiles（montage 模型）。两者数据源不同，勿混用。 */
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
  /* 原子落盘（N-B22）：用户显式选的新文件也避免"写一半" */
  store.writeAtomic(dst, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
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
  const tmp = path.join(osx.tmpdir(), 'fabula-story-' + process.pid + '-' + Date.now() + '.html');
  fsx.writeFileSync(tmp, html, 'utf8');
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await w.loadFile(tmp);
    const buf = await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    store.writeAtomic(dst, buf);        // 原子落盘（N-B22）
  } finally {
    w.destroy();
    try { fsx.rmSync(tmp); } catch (_) {}
  }
  return { ok: true, path: dst };
});

/* 图片序列导出（渲染端 UI 模型，M-13）：按传入顺序把工程内帧图复制为 01.png…。
   只接受工程根内的 PNG 相对路径（白名单校验），目标目录由系统对话框选择；
   测试模式可经 dirPath 显式传入（N-B21）。 */
ipcMain.handle('export:shotFiles', async (_e, rels, dirPath) => {
  const cur = store.current();
  if (!cur.root) return { ok: false, error: '未打开工程' };
  if (!Array.isArray(rels) || !rels.length || rels.length > 2000) return { ok: false, error: '文件列表无效' };
  const srcs = [];
  for (const rel of rels) {
    if (typeof rel !== 'string') return { ok: false, error: '文件列表无效' };
    const abs = safeMappedFile(cur.root, rel);
    if (!abs || !/\.png$/i.test(abs)) return { ok: false, error: '只允许工程内的 PNG：' + rel };
    if (fsx.existsSync(abs)) srcs.push(abs);       // 缺失的帧直接跳过（不产出占位文件）
  }
  if (!srcs.length) return { ok: false, error: '没有可导出的帧文件' };
  let dst = explicitOr(dirPath);
  if (!dst) {
    const r = await dialog.showOpenDialog({ title: '选择导出文件夹（按镜头顺序输出 01.png…）', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    dst = r.filePaths[0];
  }
  let no = 0;
  for (const abs of srcs) {
    no += 1;
    /* 原子落盘（N-B22）：避免目标盘上留半张 PNG */
    store.writeAtomic(path.join(dst, String(no).padStart(2, '0') + '.png'), fsx.readFileSync(abs));
  }
  return { ok: true, dir: dst, count: no };
});

app.whenReady().then(() => {
  protocol.handle('fabula', (req) => {
    const u = new URL(req.url);
    return u.host === 'proj' ? serveProjectFile(u, req) : serveFromSrc(u);
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
