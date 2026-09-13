# Fabula 2 · 全项目代码审计报告

| 项 | 内容 |
|---|---|
| 审计日期 | 2026-09-13 |
| 审计对象 | `I:\AI Workspace\Fabula 2`（Electron 分镜创作工作台 v0.1.0） |
| 范围 | `main/`（4 文件）、`src/`（17 文件，含 engine/paint.js 3566 行）、`agent/mcp-server.mjs`、根目录工程文件 |
| 方法 | 4 路并行深度审计（主进程 / 渲染层核心 / 绘画引擎与 UI / 跨层集成），全部源码逐行通读 + 全项目交叉 Grep；关键结论经人工抽查复核（10/10 命中） |
| 性质 | **只读审计，未修改任何文件** |

---

## 一、执行摘要

**总体评价**：工程质量明显高于同类独立项目。模块边界清晰、防御式编程密度高、指针管线与 GPU 撤销的纹理生命周期有成体系的注释且核对无泄漏、DOM 契约 130+ 引用零缺失、路径防穿越与原子写覆盖了主进程三条主写路径。

**但存在一条贯穿全局的架构级断裂**：渲染层维护 `montage.json`（时间轴模型），主进程与 MCP Agent 维护 `fabula.json`（shots 模型），两套模型并行且互不知晓；加上 `project:changed` 通知无人订阅，**Agent 对分镜的任何编辑在 UI 上不可见，UI 对时间轴的任何编辑 Agent 也读不到**——这正是本项目「绘画内核 + Agent 协作」核心卖点的断点。

另有三条相互独立、都会导致「画了却没存上」的数据丢失链（载帧失败 `_silent` 卡死 / 切工程不 flush / 关窗 async 保存不落盘），以及若干安全配置缺口。

### 数字统计

| 严重度 | 确证 | 疑似 | 合计 |
|---|---|---|---|
| 高 | 9 | 0 | 9 |
| 中 | 20 | 2 | 22 |
| 低 | 24 | 5 | 29 |
| 死代码/死通道/死设置/死 CSS 条目 | — | — | 34 |
| **问题总计** | **53** | **7** | **60 + 34** |

### TOP 10 关键问题

| # | 严重度 | 问题 | 位置 |
|---|---|---|---|
| 1 | 高 | `project:changed` 通知全链路无消费者，Agent→UI 实时刷新断裂 | preload.js:19-21 / projectStore.js:149 |
| 2 | 高 | 双工程模型分裂：UI 写 `montage.json`，主进程/Agent 写 `fabula.json`，互不知晓 | core.js:9 / projectStore.js:46 |
| 3 | 高 | 载帧失败后 `B._silent` 永久卡 true，后续笔迹静默丢失（不触发保存） | board.js:467-474 |
| 4 | 高 | 切换工程前不 flush，未存笔迹直接丢 | app.js:302 / board.js:660-673 |
| 5 | 高 | `beforeunload` 内 async 保存不可靠，关窗丢数据 | app.js:651-654 |
| 6 | 高 | `sandbox:false` + 页面无 CSP + `fabula://proj` 带 `ACAO:*` 且无文件类型白名单 | main.js:64,89 / index.html |
| 7 | 高 | `project:save` 死通道且一旦被调用会静默毁掉渲染层模型（normalize 丢弃 tracks/clips） | main.js:275 / projectModel.cjs:65-77 |
| 8 | 高 | 覆盖层 `#ov` 被内联样式钉死在首次 resize 尺寸，拖分割条/绘画弹窗后与画布错位 | paint.js:1199 + sheet.js:415-421 |
| 9 | 高 | `npm test` 指向不存在的 `test/` 目录（5 个测试文件全部缺失），测试基建为零 | package.json:10 |
| 10 | 中 | MCP 与主进程对 `fabula.json` 无锁读-改-写 + MCP 固定 tmp 文件名，并发写互相覆盖 | mcp-server.mjs:63-65,194-202 |

---

## 二、架构与数据流现状

### 2.1 实际运行的两条数据链路

```
链路①（UI 工程数据，自洽闭环 ✅）
  app.js saveProject → storage.js:147 → IPC project:writeFile
    → main.js:281 writeFileSync直写 <root>/montage.json   ← 非原子 ⚠️
  重载: storage.js:130 readBlob → fetch fabula://proj/montage.json → 字节级往返无漂移

链路②（fabula shots 模型，分裂 ⚠️）
  写入方: 主进程 writeShotImage/importAssets + MCP writeProject → <root>/fabula.json
  读取方: 主进程快照（仅冒烟自检消费）+ MCP 工具
  渲染层 UI: 不读 fabula.json、不监听 project:changed → 两个平行世界
  两链路仅共享 shots/*.png 图片与 assets/ 目录，模型字段零交集
```

- `montage.json` 模型（core.js:280-297）：`version:4, tracks[], groups[], clips[], assets[], boards[]`
- `fabula.json` 模型（projectModel.cjs:65-77）：`version:2, fps, tagOptions, shots[]（description/content/dialogue/notes/sfx…）, groups[], assets[]`
- projectModel.cjs:2-10 注释里的 v2 迁移意图未在渲染层完成；mcp-server.mjs:15 注释声称的「fs.watch 自动刷新（dom/sync.js）」——**`src/` 全树不存在 sync.js**。

### 2.2 IPC 三方契约矩阵（16 条通道逐一比对）

通道名拼写与参数个数**全部一致**，无「渲染层调了不存在的通道」类运行时错误。问题在死通道：

| 通道 | 主进程注册 | preload 暴露 | 渲染层调用 | 状态 |
|---|---|---|---|---|
| project:openDialog | main.js:253 | ✅ | storage.js:36 | ✅ 正常 |
| project:writeFile | main.js:281 | ✅ | storage.js:86 | ✅ 正常（非原子 ⚠️） |
| project:deleteFile | main.js:291 | ✅ | storage.js:96 | ✅ 正常（可删 fabula.json ⚠️） |
| project:listMedia | main.js:298 | ✅ | storage.js:109 | ✅ 正常 |
| project:create / openDir / current / writeShotImage | main.js | ✅ | 仅 devhooks 冒烟 | 正常（冒烟专用） |
| assets:importPaths | main.js:331 | ✅ | 仅 devhooks 冒烟 | 正常（冒烟专用） |
| **project:save** | main.js:275 | ✅ | **无** | **死通道 + 埋雷**（调用即毁模型） |
| **assets:importDialog** | main.js:322 | ✅ | **无** | **死通道** |
| **export:backupJson / imageSequence / storyPng / storyPdf** | main.js:346-406 | ✅ | 仅冒烟壳（main.js:176-181 经 executeJavaScript） | **UI 死通道**（桌面版无导出入口） |
| **project:changed**（主→渲染推送） | projectStore.js:149 | ✅ onChanged 口 | **从不订阅** | **死通知（核心断点）** |

---

## 三、问题清单

> 状态标注：〔确证〕= 证据链完整、行为可从代码直接推出；〔疑似〕= 需运行时验证或跨文件进一步确认。

### 3.1 高严重度（9 项）

**H-1〔确证〕Agent→UI 刷新链路断裂（`project:changed` 无消费者）**
位置：preload.js:19-21（暴露 onChanged）、projectStore.js:137-151（fs.watch → webContents.send）、src/ 全树零监听（grep 确证）。
影响：Agent 经 MCP 改 fabula.json → 主进程广播 → 无人接收。文件头自述的「fs.watch 转发实时刷新」当前是断的。
方向：app.js 启动时订阅 onChanged，external 时重载工程快照。

**H-2〔确证〕双工程模型分裂（montage.json vs fabula.json）**
位置：core.js:9（PROJECT_FILE='montage.json'）、projectStore.js:46（fabula.json）、projectModel.cjs:65-77。
影响：见 2.1/2.2。Agent 写的 description/notes/sfx UI 看不到；UI 排的时间轴 Agent 读不到；`export:imageSequence`（main.js:372 用 fabula.json 的 shots）不反映 UI 镜头集。
方向：接通 H-1 后，规划模型归一（或 MCP 直接面向 UI 模型），至少先固化字段映射文档。

**H-3〔确证〕载帧失败 `_silent` 永久卡死 → 笔迹静默丢失**
位置：board.js:467-474。`B._silent = true` 后若 `clearForShot()/loadImage()` 抛错（blob 损坏等），无 try/finally 复位；onDirty 回调（board.js:109-115）`if (B._silent) return` 吞掉一切脏标记 → autosave/flush 全跳过，错误被 `.catch(()=>{})` 静默吞掉。
方向：try/finally 复位 + catch 内 toast。同类写法还有 board.js:439-441、224-226、540-543。

**H-4〔确证〕切换工程前不 flush**
位置：app.js:302-303（openFolder 第一步 resetCaches 置 `B.dirty=false`）+ board.js:660-673（flush 守卫 `if(!B.dirty) return`）。autosave 默认关闭（settings.js:26）时，A 工程未保存笔迹静默丢失。对比切帧路径（board.js:429）是先 flush 再清，唯独换工程漏了。
方向：resetCaches 前先 `await MTG.board.flush()`，或 dirty 时弹确认。

**H-5〔确证〕beforeunload 内 async 保存不可靠**
位置：app.js:651-654。beforeunload 不等待异步续体，IPC 往返 / FSA createWritable 都不会完成，关窗时最后几笔与工程 JSON 大概率未落盘。
方向：主进程 before-quit 向渲染层要最终状态；或每次 stroke 后尽快 flush。

**H-6〔确证〕安全配置组合缺口**
- main.js:89 `sandbox: false`（preload 只用 contextBridge/ipcRenderer，沙箱化 preload 完全够用）；
- index.html 无任何 CSP meta，主进程也未注入（grep 确证零命中）；
- main.js:64 `fabula://proj` 带 `Access-Control-Allow-Origin: *` 且无文件类型白名单——工程根任意文件（含两份全量工程 JSON）可被渲染层读取。
方向：`sandbox:true` + CSP meta + ACAO 收窄为 `fabula://app` + proj 协议加扩展名白名单。

**H-7〔确证〕`project:save` 死通道 + 埋雷**
位置：main.js:275 → projectStore.js:72 normalizeProject(incoming)。渲染层 0 次调用（实际保存走 project:writeFile）。一旦将来被接上，渲染层模型会被 normalize **重建为 shots 模型，tracks/clips/boards 静默全部丢弃**。
方向：删除该通道，或改造为真正的模型归一入口。

**H-8〔确证〕覆盖层尺寸钉死，分割条/绘画弹窗后画布错位**
位置：paint.js:1199（resize 用内联样式钉死 `#ov` 尺寸，覆盖 CSS 的 100%）+ sheet.js:415-421（绘画弹窗搬 DOM 只调 fitView 不触发引擎 resize）。拖 split-side/split-shot/split-v（app.js:526-544）无 resize 调用。结果：蚂蚁线/变形手柄/自绘光标整体错位、弹窗内画布以旧分辨率拉伸模糊。
方向：删内联尺寸，或 splitter 回调与 openPaint/closePaint 补发 resize 事件（app.js:290 已有先例）。同根因一处修复覆盖两条。

**H-9〔确证〕测试基建整体缺失**
位置：package.json:10 引用 `test/*.test.mjs` 5 个文件，Glob 确认 `test/` 目录不存在，`npm test` 必然失败。projectModel.cjs:1 注释「node:test 可直接测」印证测试计划存在但未落地。
方向：补齐 5 个测试文件或先从 scripts 移除，避免 CI/协作误判。

### 3.2 中严重度（22 项）

**文件 IO / 数据安全**
- M-1〔确证〕main.js:281-297 `project:writeFile`/`deleteFile` 可触达 `fabula.json`（rel 不设黑名单），绕过全部模型校验；且 `writeFileSync` 直写非原子，与 projectStore.js:20-25 的 tmp+rename 策略不一致。**UI 的 montage.json 每 4 秒 autosave 都走这条非原子通道**，断电产生半个 JSON，loadProject 解析失败后 app.js:305-308 会当成新工程覆盖写回。方向：`.json` 后缀强制原子写 + fabula.json 列入黑名单 + 解析失败不立即覆盖。
- M-2〔确证〕mcp-server.mjs:63-65 固定 tmp 名 `fabula.json.tmp`（对比主进程 `.tmp-pid-timestamp`），双实例/双写互相覆盖，Windows 下 renameSync 撞 EBUSY/EPERM 无重试。
- M-3〔确证〕MCP 全部写工具（mcp-server.mjs:194-202 等）与主进程均无文件锁地读-改-写 fabula.json，交错时丢更新。
- M-4〔确证〕projectStore.js:172-200 importAssets 先落媒体文件最后写清单，中途失败留孤儿媒体（listMedia 按扩展名扫描会重新列出，成「幽灵素材」）。方向：失败回滚或对账。
- M-5〔确证〕main.js:359 export:backupJson 用 copyFileSync 直写覆盖，备份动作本身非原子，断电两头皆失。
- M-6〔确证〕projectStore.js:137-151 fs.watch 回环抑制在「normalize 丢弃字段」场景持续误报：lastJson 被 normalize 后文本覆盖，磁盘仍是 agent 原文 → 之后任何文件事件都判 external，反复 normalize + 广播。方向：external 分支回写收敛，或比较 normalize(disk)。

**架构 / 生命周期**
- M-7〔确证〕全项目无单实例锁（无 requestSingleInstanceLock）。双开时 fs.watch 互触发、指针文件 `~/.fabula/current-project.json` 被覆盖导致 MCP 指错工程、双写互覆。方向：加锁 + 第二实例聚焦已有窗口。
- M-8〔确证〕main.js:95-97 渲染进程崩溃只 console.error，白屏后无 reload 无提示；主进程无 uncaughtException/unhandledRejection 兜底。
- M-9〔疑似〕main.js:104-105 切换工程瞬间的在途 IPC 竞态：旧工程 writeShotImage 可能在 openDir 完成后落进新工程。需对照 app.js openFolder 全流程确认可达性。
- M-10〔确证〕main.js:252,274 `project:create/openDir` 接受渲染端任意绝对路径，与导出通道「只认对话框」的纵深防御约定不一致（单机风险可控，属一致性缺口）。

**MCP 服务**
- M-11〔确证〕mcp-server.mjs:394-396 输入一行 `null`：JSON.parse 成功返回 null，try 外解构抛 TypeError → unhandled rejection，该请求无任何响应。
- M-12〔确证〕mcp-server.mjs:15 注释引用不存在的 `dom/sync.js`（幻影文档）。

**UI 功能断链**
- M-13〔确证〕4 条 export 通道桌面版无 UI 入口：顶栏「导出」走浏览器下载（app.js:357-360），`fabula.exp.*` 仅冒烟壳调用。桌面用户无法用系统对话框导出图片序列/分镜图/PDF。
- M-14〔确证〕`assets:importDialog`（main.js:322，带过滤器与 magic 嗅探）渲染层零调用，UI 用的是 `<input type=file>`。
- M-15〔确证〕settings.js:16-29 六个设置项是「功能幻觉」：`showRing/showRingNum/invertWheel/gpuEffect/paperTex/smoothing`（及 `paper`）全项目仅 settings.js 自身命中，改了无任何效果（光标环已由引擎自绘接管、gpuEffect 无 CPU 回退路径、平滑由引擎 P.stabilize 承担）。方向：删行项或接线到引擎。
- M-16〔确证〕settings.js:59+61 默认快捷键冲突：`tool.rect` 与 `tool.blur` 同为 R，按 R 永远是矩形；且 index.html:89-102 的按钮 title 宣称笔刷键位 "(B)(P)(K)(G)(A)"，但笔刷动作默认键全是空串，纯误导。

**渲染层逻辑**
- M-17〔确证〕story.js:242-258 放映暂停状态跨会话泄漏：play()/stop() 均不重置 `S.paused`，暂停后退出再放映自动翻页失效。
- M-18〔确证〕assets.js:249-265 双击音频上轨不解码，`durationOf` 未命中恒回 5 秒占位，波形空白；对比拖放上轨路径（timeline.js:853-861）是先解码再定时长。
- M-19〔确证〕assets.js:275-279 同名导入静默覆盖文件后，旧 asset id 的 urlCache/thumb/audio 缓存不失效，素材库显示旧图旧时长。
- M-20〔确证〕assets.js:302 rescan 移除丢失素材后引用它的 clips 不清理，留悬空片段（对比 board 删除路径 assets.js:191-197 是连 clips 一起清的）。
- M-21〔确证〕app.js:477(453) + index.html:249/252 洋葱皮 UI 初始态与实际脱节：引擎默认 `on:true, opacity:45`，UI 显示未勾选、35%。
- M-22〔确证〕sheet.js:396-422 openPaint 防重入检查在 await 之后才置 `S.pmShot`，空镜头快速双击可重入，产生孤儿 board 条目与帧文件。

**绘画引擎**
- M-23〔确证〕paint.js:3290 + 1385-1389 喷枪「静止持续出墨」的 dab `ang` 恒 0，散布法线恒 +y 方向，按住不动时墨点堆成一条竖带，非各向同性（spread:2.8 预设下明显）。
- M-24〔疑似〕paint.js:1868-1940 窗口失焦（Alt+Tab）时进行中笔画/平移不收尾（无 window blur 兜底；radial.js:50 有先例）。Chromium 通常补发 lostpointercapture，触屏/驱动异常时会笔画悬置。

### 3.3 低严重度（29 项，摘要）

| 编号 | 状态 | 位置 | 问题 |
|---|---|---|---|
| L-1 | 确证 | board.js:508 | flush 写盘失败被 `.catch(()=>{})` 吞掉，dirty 照常清零，toast 照常报成功，帧文件实际没写 |
| L-2 | 确证 | transport.js:113 + core.js:382-388 | 播放在「最后片段尾 + 10 秒」（projectEnd 是可视长度）才停，每次多跑 10 秒静音 |
| L-3 | 确证 | timeline.js:202-211 + style.css:367 | 轨道头滚动同步双机制，`scrollTop` 赋值因 `overflow:hidden` 恒无效，纯死操作 |
| L-4 | 确证 | core.js:117-126 | tagOptions 读操作有副作用（回写工程默认值）却不 markDirty |
| L-5 | 确证 | story.js:286 | 放映快速切镜时 thumbUrl 竞态，慢 promise 回来覆盖成上一镜缩略图（对比 sheet.js:291 有 isConnected 校验） |
| L-6 | 确证 | app.js:333-341, 683-692 | markDirty 4s debounce 与 setupAutosave interval 两套自动保存可并发写 montage.json，交错有撕裂风险（叠加 M-1） |
| L-7 | 确证 | sheet.js:355-359 | 复制镜头共享 boardId，任一镜头作画同时改掉另一镜头画面（若是复用设计意图应至少提示） |
| L-8 | 确证 | app.js:477 | 画幅输入 0/NaN 静默落 1280×720，提示语误导 |
| L-9 | 确证 | storage.js:113-125 vs main.js:304-319 | listMedia 两实现排除目录漂移：桌面版排除 `shots/`，浏览器版不排除，同工程素材库内容不一致 |
| L-10 | 确证 | main.js:298-321 | listMedia 同步递归遍历在主进程（深度 3 缓解，慢速网络盘仍卡 IPC） |
| L-11 | 确证 | main.js:33-38, 435-438 | decodeURIComponent 畸形 % 序列抛 URIError，protocol.handle 回调无 try/catch，无干净日志 |
| L-12 | 确证 | main.js:420 | storyPdf 临时文件名无 pid，双实例同毫秒互踩 |
| L-13 | 确证 | projectStore.js:93-99 | writeShotImage 对 dataURL 无大小上限（与导入 96MB 上限不对称） |
| L-14 | 确证 | projectStore.js:117-124 | fs.watch 未注册 error 监听，被监视目录被删/掉线时可能 uncaughtException |
| L-15 | 确证 | projectStore.js:168 | sniffAsset 把所有 ftyp 容器判为音频，MP4 视频会被当音频导入 |
| L-16 | 确证 | projectModel.cjs:104-146 | normalizeProject 无版本上限检查，未来 v3 文件会被静默降级重写丢字段 |
| L-17 | 确证 | preload.js:19-21 | onChanged 无取消订阅机制，补上消费者后若初始化路径重复执行会累积 listener |
| L-18 | 确证 | devhooks.js:95 | `s.note` 字段漂移：shots 模型备注在 `description.notes`，`s.note` 恒 undefined，故事板导出永不渲染备注 |
| L-19 | 确证 | paint.js:913 | undo 显存保护允许最少保留 4 条全幅 float 快照，4096² 下峰值约 540-768MB 显存 |
| L-20 | 确证 | paint.js:1852-1853 | 吸管对透明像素硬编码纸色 [0.96,0.94,0.92] 合成，与真实 DOM/CSS 底色不一致，透明区取色偏色 |
| L-21 | 确证 | paint.js:56-60 | `window.onerror` 全接管：页面任何非致命错误都弹全屏 `#err` 遮罩且永不自动清除 |
| L-22 | 确证 | paint.js:3297-3313 + main.js:91-92 | rAF 主循环无条件全速 + backgroundThrottling:false，最小化/遮挡时 GPU 空转（冒烟模式需要豁免开关） |
| L-23 | 确证 | paint.js:50-51 | EXT_color_buffer_float 重复请求两次，首次结果丢弃（纯冗余） |
| L-24 | 确证 | paint.js:2481-2482 | 空 keyup 监听器 `window.addEventListener('keyup', ()=>{})` |
| L-25 | 确证 | picker.js:47-51 | 拾色器 pointerdown 不过滤 e.button，右键/中键也拖色环；且 `hitTest(e) || (…)` 右半边是永不生效的死分支 |
| L-26 | 确证 | settings.js:508-518 vs paint.js:3328-3330 | 偏好桥键契约缺口：引擎读 penPMin/penPMax/penSpeedRef，DEFAULTS 无此键 → `+undefined=NaN` 被静默丢弃，三参数永不可持久化 |
| L-27 | 确证 | index.html:2 vs style.css:42 | `<html data-theme="dark">` 是死属性，主题只认 body（JS 写的也是 body） |
| L-28 | 疑似 | paint.js:1891,2409-2414 | startPan 不设 activePointer，多指触摸第二触点可覆盖 panStart |
| L-29 | 疑似 | brushes.js:43-50 | defaultParams 把引擎当前 P 全量当出厂默认，参数改过状态下调用会把其它笔刷专属字段混入保存记录 |
| L-30 | 疑似 | board.js:30-32 | `__fabulaWorkspace` 钩子只拦 pointerdown/move 不拦 up，宿主侧接口不完备 |
| L-31 | 确证 | main.js:192-196 | `--smoke-eval` 允许任意 JS 注入渲染进程（仅测试模式可达，需保证生产打包不带 smoke 参数） |

---

## 四、死代码 / 死通道 / 死设置 / 死资产清单（34 条）

### 4.1 主进程死代码（6）
| 符号 | 位置 | 依据 |
|---|---|---|
| `makeId` | projectStore.js:204 | 未列入 module.exports，全项目零调用 |
| `pointerPath`（导出） | projectStore.js:33,206 | writePointer 内部直接用 PTR_FILE 常量；mcp-server 自行拼指针路径 |
| `writePointer`（导出面） | projectStore.js:36,206 | 仅模块内部调用，导出冗余 |
| `normalizeProject` 重导出 | projectStore.js:206 | mcp-server 用的是 projectModel 的版本 |
| `FORMAT_VERSION / ASSET_KINDS / TAG_DEFAULTS / normalizeDescription`（导出面） | projectModel.cjs:148 | 无外部消费方（测试缺失，见 H-9） |
| `ASSET_ID_RE` 解构 | projectStore.js:6 | 解构后模块内零使用 |

### 4.2 死 IPC 通道（8，均经 preload 暴露）
`project:save`、`assets:importDialog`、`export:backupJson`、`export:imageSequence`、`export:storyPng`、`export:storyPdf`（后 4 条冒烟依赖，删除前需评估）、`project:changed` 推送（无消费者）、`fabula.project.onChanged` 订阅口（从未被调用）。

### 4.3 渲染层死代码（12）
| 符号 | 位置 |
|---|---|
| `MTG.BOARD_W / BOARD_H` | core.js:10-11（画幅实际走 project.boardW/H） |
| `MTG.ensureClipMeta` | core.js:257-260 |
| `MTG.picker.pushSwatch` | picker.js:191-197（「最近色板」功能未接线，#swatches 只渲染默认 10 色） |
| `MTG.board.hideRing / updateRing` | board.js:212（空实现，引擎自绘光标后遗留） |
| `MTG.board.panBy` | board.js:209 |
| `board.drawing / strokeTool / lassoing / selDrag` | board.js:49-54（状态位从未读写，引擎迁移遗留） |
| `MTG.brushes.paramMeta / PARAM_META` | brushes.js:23-40,75（旧滑杆映射层） |
| `MTG.brushes.get` | brushes.js:73 |
| `MTG.brushes.resetBrush` | brushes.js:98-104 |
| `MTG.sheet.cols` | sheet.js:48（内部用模块级 COLS） |

### 4.4 引擎死代码（4）
`UI_ACTIONS`（paint.js:2801，自绘工具条时代遗留）、`TOOLS` 导出（前端硬编码按钮 + board.js 自己的 MAP）、`exportPNG()`（paint.js:2610，宿主导出走 exportDataURL/exportBlob）、空 keyup 监听器。

### 4.5 死设置（7 个键）
`showRing / showRingNum / invertWheel / gpuEffect / paper / paperTex / smoothing`——settings.js 定义 + 面板渲染，全项目无消费者（见 M-15）。

### 4.6 死 CSS / 死属性（5）
| 条目 | 位置 | 依据 |
|---|---|---|
| `.xf-box / .xf-h.*` 全家 | style.css:962-979 | 变换框由引擎 drawXfHandles 在 #ov 上自绘，JS从不创建这些元素 |
| `.asset-put` | style.css:982-987 | 素材「贴入」功能遗留，JS 零引用 |
| `--green / --red-soft` 变量 | style.css:15,19 | 只有对应 -rgb 变量被引用，基色零使用 |
| `<html data-theme="dark">` | index.html:2 | 主题选择器只匹配 body |
| `#asset-hint` | index.html:76 | 静态提示，无动态更新逻辑（对照 board-empty 有） |

**另**：devhooks.js **不是**死代码——`--smoke-*` 分支调用其全部六个挂口，生产环境仅静挂 window。

---

## 五、端口盘点

**全项目零网络端口占用。**

| 位置 | 结论 |
|---|---|
| agent/mcp-server.mjs | 纯 stdio NDJSON 传输（mcp-server.mjs:391,437-445），无 listen/http/ws |
| main/main.js | `fabula://` 自定义协议（main.js:26-28,435-438），非网络端口 |
| src/、bat、package.json | 无 listen/localhost/ws 命中；`http://` 仅 npm registry 与 SVG 命名空间 |

与用户机器已被占用的 8765/8766/8767（Exterior、手机端示例、思想的参考）**无任何交集**。

---

## 六、工程与仓库卫生

| 项 | 状态 | 说明 |
|---|---|---|
| `npm test` | ❌ 必然失败 | test/ 目录不存在（H-9） |
| smoke.log / smoke-shot.png | 可清理残留 | --smoke 运行产物（main.js:9-20,241），已被 .gitignore 覆盖；smoke.log 含临时工程路径 |
| .gitignore | 覆盖不全 | `--smoke-crop` 会写 smoke-crop.png（main.js:241）但未列入 ignore，未来会混入版本库 |
| 启动Fabula.bat | ✅ 可用 | chcp 65001 / cd /d / electron.exe 存在性判断均正确；瑕疵：npm install 成功但二进制仍缺时 start 静默失败无提示 |
| package.json | ✅ 基本健康 | main 字段与实际一致；mcp 路径存在；唯一致命项是 test 脚本 |
| 版本控制 | ✅ 已是 git 仓库 | .gitignore 存在且基本合理 |

---

## 七、正面确认（设计做对了的地方）

- **路径安全**：safeMappedFile（main.js:33-38）防穿越白名单有效，Windows 反斜杠与 `..` 均被拦；sanitizeShot 的 image 白名单 + PNG 后缀约束使导出路径不可穿越。
- **写路径原子性**：writeShotImage / saveProject / importAssets 全部走 tmp+rename 原子写（四重校验：id 正则、dataURL 前缀、base64、PNG magic bytes）。
- **进程安全**：contextIsolation:true + nodeIntegration:false；无 shell.openExternal/openPath 调用（全项目 grep 确证）；无远程 loadURL。
- **引擎质量**：指针管线（压力整形/手掌拒绝/丢失捕获/合并采样）、GPU 撤销纹理生命周期（所有 deleteTexture 路径核对无泄漏）、载入串行队列、竞态令牌（_token/_btoken）、blob URL 生命周期管理均成体系。
- **DOM 契约**：约 130 个 id 引用逐一对照 HTML 全部命中，零缺失；脚本加载顺序与全局依赖核对无冲突。
- **IPC 卫生**：16 条通道名与参数个数零拼写漂移、零参数个数错位。

---

## 八、修复优先级建议（按收益/风险排序）

1. **接通 Agent→UI 刷新**（H-1）：渲染层订阅 onChanged + external 时重载——一行订阅 + 一个重载函数，直接复活核心卖点。
2. **堵三条数据丢失链**（H-3/H-4/H-5 + L-1）：_silent 加 try/finally、切工程前 flush、flush 失败保留 dirty + toast。
3. **尺寸随动修复**（H-8）：删 ovc 内联尺寸或补 resize 触发，一处修复覆盖分割条 + 绘画弹窗两个场景。
4. **montage.json 写入原子化**（M-1）：project:writeFile 对 .json 走原子写，并拒绝 rel=fabula.json。
5. **MCP 写路径加固**（M-2/M-3/M-11）：tmp 带 pid、null 消息防御；模型归一（H-2）可作独立里程碑。
6. **安全三件套**（H-6）：sandbox:true + CSP + ACAO 收窄。
7. **清理面**：6 个死设置项、R 键冲突（M-16）、5 个默认键缺失、34 条死代码按「先死通道后死符号」分批清（export 4 通道属冒烟依赖，需先给桌面版补导出 UI 或明确砍掉）。
8. **测试补建**（H-9）：projectModel.cjs 本就是纯 node 模块，最易先落测试。

---

*报告生成方式：4 路并行子代理逐行审计 + 交叉 Grep 验证 + 人工抽查复核（抽查 10 条关键结论全部属实）。全文只读，未改动项目任何文件。*
