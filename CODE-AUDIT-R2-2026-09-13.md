# Fabula 2 · 第二轮代码审计报告（修复验证 + 回归排查）

| 项 | 内容 |
|---|---|
| 审计日期 | 2026-09-13（第二轮，距首轮同日） |
| 基线 | 上轮报告 `CODE-AUDIT-2026-09-13.md`；其后修复轮规模 30 文件 / +2109 −472 行 |
| 范围 | main/ 全部、src/ 全部、agent/mcp-server.mjs 全量重构审计、test/ 5 文件实跑 |
| 方法 | 4 路并行子代理逐行通读 + 交叉 Grep；关键结论人工抽查（3 条回归 + 1 条核心修复全部亲自复核命中）；测试套件实跑一次 |
| 性质 | **只读审计，未修改任何项目文件**（测试输出仅写系统 TEMP） |

---

## 一、执行摘要

**修复质量：高，净收益显著为正。** 上轮 64 条问题逐条复核 60 条：**47 条 FIXED（78%）、7 条 PARTIAL、4 条 NOT FIXED、1 条 REGRESSION**，另有 1 条维持现状（可接受的测试后门）。上轮 TOP10 关键问题中 7 项实质修复，且普遍不是形式化补丁——数据丢失链三条全部闭环、CSP/sandbox/白名单成套落地、测试是字段级断言的端到端真测试（**18/18 通过**）。修复代码普遍带指向上轮编号的注释，可追溯性好。

**但本轮发现 1 个确证的高危回归 + 1 个中危回归，均出自本轮修复自身的改动接缝**：

1. **〔高·回归〕`export:shotFiles` 的 IPC 注册被误嵌进 `export:storyPdf` 回调体内**（main.js:490-515 嵌于 475-530，三路子代理独立复核 + 人工括号配对确认）。后果：桌面版顶栏「导出」按钮**首次点击必报 "No handler registered"**；只有先成功导出过一次 PDF，帧序列导出才可用；而**第二次导出 PDF 起必报 "Attempted to register a second handler"，永远失败**。纯剪切粘贴级修复（把 488-515 移到 530 之后）。
2. **〔中·回归〕时间轴轨道头滚动位移翻倍**：L-3 修复把死 scrollTop 机制改成了 per-row transform（timeline.js:202-217），**但 init 里的旧监听器（43-45）没删**且同样改成了 transform——同一 scroll 事件两个监听器都生效，轨道头每滚 1px 实际位移 2px，比修复前（无效但无害）更糟。一行删除修复。

**新问题的集中面是「并发编排」与「双数据源契约」**：Agent↔UI 实时同步复活后，reloadExternal 与 openFolder 无互斥、通知无补跑；MCP 的锁只圈住了自己，UI 的 4 秒 autosave 仍是无锁全量覆写方；MCP 纯换图不产生任何广播信号，用户看到的还是旧画面。

### 数字总览

| 类别 | 数量 |
|---|---|
| 上轮问题复核 | 60 / 64 条（47 FIXED / 7 PARTIAL / 4 NOT FIXED / 1 REGRESSION / 1 维持） |
| 本轮新发现 | **31 条**（高 1 / 中 7 / 低 23），其中回归 2 条 |
| 上轮 34 条死代码 | 本区相关项**基本删净**（带注释可追溯）；新发现 10 条新死代码 |
| 测试套件 | 5 文件 18 用例，**18/18 通过**（glob 形式）；6 类覆盖缺口 |
| 端口 | 复测仍**零占用** |

---

## 二、上轮问题修复验证总表

### 2.1 高严重度（9 条：7 FIXED，2 PARTIAL）

| 编号 | 判定 | 现状与证据 |
|---|---|---|
| H-1 project:changed 死通知 | **FIXED** | 主进程 350ms debounce 广播 `{external, sources, at}`（projectStore.js:142-179）+ markSelfWrite 自写登记；渲染端 app.js:742-747 订阅 → reloadExternal（754-804）解析失败缓冲重试、mergeProjects 并集合并。三路独立复核一致 |
| H-2 双模型分裂 | **PARTIAL** | montage.json 已成为唯一双写文件：MCP 整体转向 UI 模型（resolveProject 强校验 montage.json，mcp-server.mjs:45），fabula.json 退出 MCP 视野、UI 不读它——两模型不再互踩。残留：`export:imageSequence` 仍按 fabula shots 模型出图（死通道遗留）；UI 对 shots 模型只 toast 不消费 |
| H-3 _silent 卡死 | **FIXED** | board.js 五处 `_silent = true` 全部 try/finally 化（130/220/435/464/550），队列错误 catch + toast。人工复核确认 |
| H-4 切工程不 flush | **FIXED** | app.js:298-308 openDialog 前先 `await board.flush()` + dirty 时 saveProject |
| H-5 beforeunload 不可靠 | **FIXED** | 三端握手：渲染 onBeforeClose flush → closeReady → 主进程放行 close，3 秒兜底 destroy（app.js:721-738 / preload.js:8-13 / main.js:96-103,151-160），时序正确 |
| H-6 安全三件套 | **PARTIAL** | sandbox:true（main.js:126）✅、CSP meta 落地且页面兼容性逐项核查通过（index.html:6-9）✅、PROJ_EXT_ALLOW 白名单 + ACAO 收窄 ✅。**残留**：fabula.json 拒读/拒写判断是大小写敏感字符串比较（main.js:86,346），Windows 大小写不敏感文件系统上 `FABULA.JSON`/`x/../fabula.json`/尾点均可绕过（见 N-A3）；**project:deleteFile 完全无黑名单**，仍可删 fabula.json |
| H-7 project:save 埋雷通道 | **FIXED** | 通道与 preload 暴露面均已删除（main.js:333-335 留注释）；但 store.saveProject 函数本体成新死代码（见四） |
| H-8 覆盖层尺寸钉死 | **FIXED** | 删内联尺寸 + CSS 100% 兜底 + 三条触发链补齐（splitter rAF 节流 / openPaint / closePaint 均发 resize），还顺带修了重复赋值 canvas 尺寸清缓冲的隐性闪烁 |
| H-9 测试基建缺失 | **FIXED** | test/ 5 文件 364 行，实跑 18/18 通过 |

### 2.2 中严重度（24 条：17 FIXED，5 PARTIAL，2 NOT FIXED）

| 编号 | 判定 | 要点 |
|---|---|---|
| M-1 writeFile 非原子/可触达 fabula.json | PARTIAL | 原子写 ✅（store.writeAtomic）、解析失败不覆盖 ✅（err.parseFailed 跨层传递）；黑名单可绕过 + deleteFile 无黑名单（→ N-A3） |
| M-2 MCP 固定 tmp 名 | **FIXED** | `montage.json.tmp-<pid>-<ts>` + EBUSY/EPERM 5 次退避重试（mcp-server.mjs:81-99） |
| M-3 无锁读改写 | PARTIAL | withLock（O_EXCL + 陈锁清理 + 5s 超时）包住全部 MCP 写工具；**但 UI 保存不参与该锁**（→ N-A1，只修了一半） |
| M-4 importAssets 孤儿媒体 | NOT FIXED | 结构未变（projectStore.js:207-233） |
| M-5 backupJson 非原子 | **FIXED** | 改走 store.writeAtomic（main.js:427-428） |
| M-6 watch 回环误报 | **FIXED** | fabula 分支改比较 normalize 后文本（幂等可比）；montage 分支基线 null 不广播 + 读盘即收敛 |
| M-7 单实例锁 | **FIXED** | requestSingleInstanceLock + second-instance 聚焦（main.js:14-23），冒烟豁免有注释 |
| M-8 崩溃无恢复 | **FIXED** | uncaughtException/unhandledRejection 兜底 + render-process-gone 弹窗 reload |
| M-9 切工程在途竞态 | PARTIAL | 渲染层先 flush + 主进程 handler 同步无让出点，主链路闭环；未加 epoch token，且 reloadExternal 有同类新竞态（→ N-A6） |
| M-10 create/openDir 任意路径 | NOT FIXED | main.js:310,332 直传无校验（含 assets:importPaths） |
| M-11 JSON-RPC null 崩溃 | **FIXED** | 解构前 typeof/null/Array 拦截（mcp-server.mjs:552-554），测试覆盖 |
| M-12 幻影 sync.js | **FIXED** | 注释重写为真实机制，grep 零命中 |
| M-13 导出 UI 未接线 | PARTIAL | storyPng/storyPdf/shotFiles/importDialog 全部接线且参数契约匹配；**shotFiles 被 N-A2 阻断（首用必败）** |
| M-14 importDialog 死通道 | **FIXED** | app.js:433-449 桌面优先系统对话框，added/skipped 提示 |
| M-15 六个死设置项 | **FIXED** | 全部删除，grep 零残留，「只保留有真实消费者的项」 |
| M-16 R 键冲突 | PARTIAL | blur 改 U、撞键清占落地；**残留**：index.html 模糊按钮 title 仍写「(R)」与实际 U 矛盾；铅笔/马克笔/水粉/喷枪的 title 键位 (P)(K)(G)(A) 仍未绑定（def 全空串） |
| M-17 paused 泄漏 | **FIXED** | play()/stop() 均重置（story.js:392,402） |
| M-18 音频 5 秒占位 | **FIXED** | 上轨前先解码，失败回退 5 秒（assets.js:249-259） |
| M-19 同名导入缓存不失效 | **FIXED** | dropUrl + audio.cache.delete（assets.js:283-288） |
| M-20 rescan 悬空 clips | **FIXED** | 连 clips 一起清 + 缓存清理（assets.js:312-320） |
| M-21 洋葱皮 UI 脱节 | **FIXED** | 引擎默认与 HTML checked/value 完全一致（onion on/45/1/1） |
| M-22 openPaint 重入 | **FIXED** | `_pmBusy` 在任何 await 之前置位、finally 复位（sheet.js:401-427） |
| M-23 喷枪散布单向 | **FIXED** | `ang: Math.random()*2π`（paint.js:3296-3299）；小疵：脱离种子化 rnd() 体系（→ N-B8） |
| M-24 失焦笔画悬置 | **FIXED** | window blur 兜底：pan 先收、drawing 则 endStroke(null)（paint.js:2146-2160），与 lostpointercapture 双保险 |

### 2.3 低严重度（31 条：23 FIXED，1 REGRESSION，2 NOT FIXED，1 维持，4 未逐条复测）

- **FIXED（23）**：L-1 flush 失败保 dirty+toast、L-2 contentEnd 真实内容末端、L-4 tagOptions markDirty、L-5 放映缩略图令牌、L-6 saveTick 串行补跑、L-7 复制镜头共用帧明示 toast、L-8 画幅无效输入提示、L-9 listMedia 两版对齐（均排除 shots/）、L-11 decodeURI 保护、L-12 tmp 带 pid、L-13 writeShotImage 96MB 上限+magic 校验、L-14 watcher.on('error')、L-15 ftyp 品牌判别（M4A /M4B 才收）、L-18 s.note→description.notes、L-19 undo 显存 2 条≈256MB、L-20 吸管纸色与 board 底色逐像素一致、L-21 err 遮罩可点击关闭、L-22 document.hidden 60 帧降频（被遮挡未最小化场景仍全速，属方案边界）、L-23 扩展只请求一次、L-24 空 keyup 删除、L-25 picker 按键过滤+死分支消失、L-26 penPMin/penPMax/penSpeedRef 四段闭环（DEFAULTS→面板→桥→引擎）、L-27 data-theme 死属性删除
- **REGRESSION（1）**：L-3 轨道头滚动——旧监听器没删且改成了 transform，与新机制叠加位移翻倍（→ N-A4，本轮中危回归）
- **NOT FIXED（2）**：L-16 normalize 无版本上限（src.version 仍零引用）、L-17 onChanged 无取消订阅
- **维持（1）**：L-31 --smoke-eval（可接受测试后门，未变）
- **未逐条复测（4）**：L-10 listMedia 同步遍历、L-28 双指平移、L-29 defaultParams 污染、L-30 workspace up 钩子——维持原状观察

---

## 三、本轮新发现问题（31 条）

### N-A 高 / 中（8 条）

**N-A2〔高·确证·回归〕export:shotFiles 注册嵌进 storyPdf 回调体**
位置：main.js:490-515（嵌于 475-530 之间）。三路子代理独立复核 + 人工括号配对确认：475 行开 storyPdf 作用域，488-515 整段（含 `ipcMain.handle('export:shotFiles',…)` 与闭合 `});`）是其体内语句，517-529 的 printToPDF 逻辑随后继续，530 才闭合 storyPdf。
影响：① 启动后 shotFiles 无 handler，顶栏「导出」（app.js:401）首点必败（被 catch 成「导出失败」toast）；② 只有先成功导出一次 PDF，帧序列导出才被顺带注册；③ 第二次导出 PDF 重复注册抛错，storyPdf 永远失败。
修复：把 488-515 整块移到 530 之后（与其它 export handler 平级）。**建议最优先修，纯移动。**

**N-A1〔中·确证〕UI 保存不参与 montage.json.lock（M-3 只修一半）**
MCP 写前持锁（mcp-server.mjs:103-134），但渲染端保存链路（project:writeFile → store.writeAtomic，main.js:354）与主进程完全不感知该锁。竞态：agent 写入 → 350ms watch 窗口内 UI autosave 全量覆写 → agent 更新在磁盘与内存双丢（notify 读回文本恰是 UI 自己写的，external 判假）。反向：reloadExternal 的 saveProject(merged)（app.js:793）也绕过 saveTick 串行闸。方向：锁实现下沉共享模块，project:writeFile 对 montage.json 同源加锁；至少保存前重读比对。

**N-A3〔中·确证〕fabula.json 读写保护可被 Windows 语义绕过**
拒读 main.js:86 与拒写 main.js:346 都是大小写敏感字符串比较：`FABULA.JSON`（协议直读，.json 在白名单内）、`x/../fabula.json`（过检后 normalize 落 fabula.json）、尾点 `fabula.json.`（Win32 剥尾点）均可绕过；且 **project:deleteFile（main.js:359-365）无任何黑名单**，可直接删掉 fabula.json。方向：basename 归一后 toLowerCase 判定 + deleteFile 同黑名单。

**N-A4〔中·确证·回归〕轨道头滚动双 transform 叠加，位移翻倍**
timeline.js:43-45（旧监听，平移整个 #tl-heads）与 timeline.js:202-217（新 syncHeadScroll，per-row translateY）监听同一 scroll 事件同时生效。修复：删除 43-45。

**N-A5〔中·确证〕agent 纯换图不广播，UI 持续显示旧图**
set_shot_image 只写 `boards/<id>.png` 不改 montage.json（mcp-server.mjs:443）→ fs.watch 触发但两份 JSON 均无变化 → sources 空、external:false，UI 不刷新；board.js 的 blob/缩略图缓存照旧。**agent 重绘镜头后用户看到的还是旧画面**，直接违背「Agent↔UI 同一份真相」卖点。方向：换图时 touch montage.json（版本号/mtime 字段）或 notifyChanged 对 boards/ 变更也发信号。

**N-A6〔中·确证〕reloadExternal 与 openFolder 无互斥**
reloadExternal 只检查自身 externalReloading（app.js:754-756）；openFolder 执行中（多个 await 之间）到达广播会并发执行两路 loadProject/applyProject/saveProject 交错，极端时序回写旧快照。方向：模块级 switching 标志互斥或共用串行队列。

**N-A7〔中·确证〕轮盘呼出键改绑后不生效（双数据源断裂）**
录制写 `radialKey`（settings.js:458），呼出走动作表 keyOf('cmd.radial')（自定义键永不存在 → 恒回落默认 'V'，app.js:690-695），关闭却比对 radialKey（app.js:710）。用户改绑任意新键：UI 显示新组合，实际只有 V 能呼出。方向：呼出/关闭统一走 radialKey。

**N-A8〔中·确证〕「压感」滑杆与「启用数位板压感」复选是死控件**
bindSlider('b-pressure','pressure') 写进引擎不存在的键（setParam 对未知键静默忽略，paint.js:3377）；usePressure 全项目零读取。UI 撒谎 + saveParams 持久化无意义键。方向：删除控件或改接 PEN 压感参数。

### N-B 低（23 条，摘要）

| 编号 | 位置 | 问题 |
|---|---|---|
| N-B1 | app.js:745,756 | reloadExternal 进行中到达的后续广播被静默丢弃、无补跑（saveTick 有 saveAgain 补跑，此处漏了同款）——Agent 连续两次编辑只看到第一次 |
| N-B2 | board.js:463-476,672-685 | _loadQueue 的 job 体内不校验 token，切工程时旧工程载帧可落进新画布（resetCaches 只 ++token 不清队列） |
| N-B3 | picker.js:192-209 | pushSwatch 删除后 `montage.swatches` 只读不写，「最近色板」名存实亡（删写留读） |
| N-B4 | preload.js:36 + app.js:389-412 | exp.backupJson 成新死通道：桌面分支只走 shotFiles 并 return，桌面用户失去「导出工程 JSON」备份入口 |
| N-B5 | board.js:208 + app.js 多处 | syncCursor/paint/refreshRing 空桩仍被 8 处死调用（有意 no-op 垫片，但调用侧可清） |
| N-B6 | sheet.js:430-447 | closePaint(true) 不检查 flush 返回值，「存帧并关闭」承诺可能未兑现（dirty 保留，非数据丢失） |
| N-B7 | projectStore.js:69-77 | store.saveProject 成新死导出（H-7 修的尸体），且仍是 normalize 埋雷函数本体 |
| N-B8 | paint.js:3298-3299 | 喷枪 ang 用 Math.random() 脱离种子化 rnd() 体系，破坏引擎自建的可复现断言约定 |
| N-B9 | paint.js:2465-2468 | window.__fabulaActions 死钩子（无人赋值）+ 注释引用不存在的 data/actions.js |
| N-B10 | index.html:144 | 模糊按钮 title「(R)」与新默认键 U 矛盾（M-16 残留） |
| N-B11 | paint.js:3361,2809,3405-3429 | 引擎零消费导出群：TOOLS / panBy / resetBrush（上轮删了 brushes 版又在引擎长回来）/ exportLayerPNG / loadLayerFromURL / clearHistory |
| N-B12 | settings.js:389 | ui._radialOpts 赋值后零读取 |
| N-B13 | brushes.js:47 + board.js:184 | params:['flow','hardness','grain','scatter'] 死字段且 'scatter' 键名错误（引擎为 spread）——旧映射层残根 |
| N-B14 | mcp-server.mjs:443 | b.path 来自磁盘 montage.json，无白名单校验，被手改成 ../x.png 时可写工程外路径（shots 模型有白名单，boards 模型没有对应物） |
| N-B15 | mcp-server.mjs:552,594-604 | JSON 解析失败不回 -32700（客户端挂等超时）；行缓冲无上限 |
| N-B16 | mcp-server.mjs:433-444,480-497 | 媒体在锁内先落盘、清单后写：writeProject 失败留幽灵媒体（M-4 同族未修）；大文件 IO 放锁内拉长持锁时间 |
| N-B17 | .gitignore:1-4 | 未覆盖 montage.json.lock 与 *.tmp-*（本项目自身是 git 仓库，会产生未跟踪噪音） |
| N-B18 | preload.js:24 | onChanged 注释 `{external, at}` 与实际 payload `{external, sources, at}` 漂移（app.js 有 fallback 不致错） |
| N-B19 | mcp-server.mjs:114-117 | 陈锁窃取竞态：持锁 IO >10s 时等待者可抢锁双写（窗口极窄，疑似） |
| N-B20 | projectStore.js:171-174 | 基线 null 时外部首写被吞：新建工程后、用户首次保存前 agent 先写 montage.json → 收敛为新基线且不广播，agent 首写对 UI 永久不可见（边界场景） |
| N-B21 | main.js:502 | explicitOr(null) 恒 undefined——shotFiles 连冒烟模式也必弹对话框，自动化无法驱动该通道 |
| N-B22 | main.js:471,524,450,512 | 导出落盘 writeFileSync/copyFileSync 非原子（用户显式选新文件，风险低，备注级） |
| N-B23 | main.js:151-160 | 关窗握手 3 秒兜底无取消路径，大工程慢盘 flush 超时被硬杀（设计取舍，备注级） |
| N-B24 | devhooks.js:99-192 vs story.js:244-353 | 故事板 PNG/HTML 双实现（shots 模型版 vs UI 模型版）易漂移；imageSequence 死通道与之同源 |

---

## 四、死代码复测（清理战果 + 新增）

**上轮 34 条：本区相关项全部删净**（makeId/pointerPath/BOARD_W/H/ensureClipMeta/pushSwatch/hideRing 族/drawing 族/paramMeta 族/UI_ACTIONS/exportPNG/.xf-box 全家/.asset-put/--red-soft/死设置键/空 keyup 等，逐项 grep 确认零残留，删除处均留编号注释）。测试补建后 projectModel 导出面不再判死。

**新增死代码（10 条）**：store.saveProject（N-B7）、exp.backupJson 通道（N-B4）、export:imageSequence 通道（仍死 + 数据源还是 fabula 模型）、引擎 TOOLS/panBy/resetBrush/exportLayerPNG/loadLayerFromURL/clearHistory 六连（N-B11）、CSS --green（只留了 --green-rgb 消费）、brushes params:['scatter']（N-B13）、montage.swatches 孤儿读（N-B3）、__fabulaActions 死钩子（N-B9）、ui._radialOpts（N-B12）。
模式提示：**「删宿主侧留引擎侧」「删写留读」「删通道留函数」**——下轮清理建议按符号 grep 全项目三次（定义/调用/字符串引用）再动手。

---

## 五、测试套件评估

**实跑结果**：`node --test "test/*.test.mjs"`（package.json 同款 glob）→ **18/18 通过，9.2s**。注意 `node --test test/`（目录形式）在本机 Node 22.12.0 下报 MODULE_NOT_FOUND，README/CI 勿用目录形式。

| 文件 | 用例 | 质量 |
|---|---|---|
| project.test.mjs | 7 | 真测试，值级+正则+deepEqual |
| mcp-server.test.mjs | 1（端到端） | 质量最高：spawn 真进程 + 真磁盘 + 字段级断言 + M-11 防御 + 锁/tmp 不残留 |
| shots-geometry.test.mjs | 4 | 半真：starts() 是测试内复刻品而非 MCP relayoutTrack 本体，实现漂移测试不红 |
| prefs.test.mjs / actions.test.mjs | 3+3 | 源码级正则断言，防回归有效但对重构脆弱 |

**覆盖缺口（按风险排序）**：① projectStore 的 watch/notifyChanged/markSelfWrite 回环抑制——本轮 H-1/H-2 战场零测试；② app.js mergeProjects/reloadExternal 状态机；③ main.js IPC 注册层（N-A2 这种括号事故恰是集成测试能抓的）；④ MCP withLock 并发/陈锁/EBUSY 重试/import_assets；⑤ sniffAsset 品牌判定；⑥ shotFiles 通道（当前被 N-A2 阻断，测试也没法驱动，见 N-B21）。

---

## 六、IPC 矩阵变化摘要（16 → 17 条）

**新增**：`app:before-close`/`app:close-ready`（关窗握手）、`export:shotFiles`（注册位置错误，N-A2）。
**删除**：`project:save`（连 preload 暴露面）。
**复活**：`project:changed`（订阅→reloadExternal）、`assets:importDialog`（app.js:433）、`export:storyPng/storyPdf`（story.js:361/377）。
**仍死**：`export:imageSequence`（零调用 + fabula 模型数据源）、`exp.backupJson`（新死，N-B4）。
通道名拼写与参数个数复测：**零漂移**（除 N-B18 的注释级契约漂移）。

---

## 七、下一步建议（按优先级）

1. **修 N-A2**（高回归，纯移动代码块）——修完桌面导出闭环才算真正打通 M-13。
2. **修 N-A4**（一行删除 timeline.js:43-45）。
3. **并发编排三连**：reloadExternal 加 switching 互斥 + saveAgain 式补跑（N-A6/N-B1）→ 锁下沉共享、project:writeFile 同源加锁（N-A1）→ 换图 touch montage.json（N-A5）。这三条决定「Agent↔UI 实时协同」在真实使用里靠不靠谱。
4. **Windows 语义收口**（N-A3）：basename 归一 toLowerCase + deleteFile 黑名单，十行以内。
5. **UI 撒谎清理**：压感死控件（N-A8）、radialKey 统一数据源（N-A7）、index.html 三处 title 键位（N-B10/M-16 残留）。
6. **测试补射程**：projectStore watch 回环 + main.js IPC 注册冒烟（启动后枚举 ipcMain 已注册通道断言无嵌套/无缺失），这两类测试专杀本轮这种「接缝伤」。
7. **遗留三件 NOT FIXED**（M-4 孤儿媒体、M-10 任意路径、L-16 版本上限）在模型进 v3 前择机补上；死代码 10 条随下轮清理面统一走。

---

*第二轮审计：4 路并行子代理逐行通读 + 交叉验证；人工亲自复核 N-A2（括号配对）、N-A4（双监听器）、N-A7（radialKey 双源）、H-3（五处 try/finally）均属实。全文只读，未改动项目任何文件。*
