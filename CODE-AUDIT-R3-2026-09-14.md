# Fabula 2 · 第三轮代码审计报告（修复验证 + 回归排查）

| 项 | 内容 |
|---|---|
| 审计日期 | 2026-09-14（第三轮） |
| 基线 | R1 `CODE-AUDIT-2026-09-13.md`、R2 `CODE-AUDIT-R2-2026-09-13.md`；本轮修复提交 `31a8810`（审计修复三轮）+ `6274116`（压感/轮盘/衬底 + 探针）+ `ad744d6`（.npmrc） |
| 范围 | main/ 全部、src/ 全部、agent/mcp-server.mjs(629 行) 全量复审、test/ 7 文件实跑、端口/残留/工程卫生 |
| 方法 | 4 路并行子代理逐行通读 + 交叉 Grep；关键结论人工复核（**D-1 用只读脚本复现验证**）；测试套件实跑一次 |
| 性质 | **只读审计，未修改任何项目文件** |

---

## 一、执行摘要

**测试实跑：25/25 通过，9.09s，0 失败。** R2 待验证 37 项（4 区合计）：**28 FIXED、7 PARTIAL、2 NOT FIXED、0 REGRESSION**。

**本轮最重要的两条发现**（均经人工复核）：

1. **〔中〕R2 两条回归全部彻底修净**：`export:shotFiles` 已在 main.js:574 顶层注册（逐字符状态机复核 **16 个 handler 深度全部为 0**，无其它嵌错）；轨道头滚动位移翻倍已消除（全文件仅剩 1 个 scroll 监听 + `_headSync` 幂等保护）。**R2 的两条回归未留下任何残余。**

2. **〔中〕但为防 N-A2 而新写的 `test/main-ipc.test.mjs` 自身有洞**：注释正则 `//[^\n]*` 排在字符串替换**之前**（test/main-ipc.test.mjs:19-20），main.js:141 的 `'fabula://app'` 里那个 `//` 被当成注释剥掉，留下未闭合单引号，随后的字符串正则跨行吞并后续代码。**只读脚本复现确认：清洗后 615 行塌缩为 522 行（偏差 93）、`ipcMain.handle(` 命中数 16→15、漏检 `main.js:148 app:close-ready`**。测试当前之所以仍绿，是靠第二个用例在**原文**上匹配兜住（`app:close-ready` 恰在 preload 暴露）——第一个用例对"未在 preload 暴露的内部通道"存在静默漏检，且失败时的行号提示会偏错最多 93 行。

**修复深度已从"功能正确"推进到"并发语义"，本轮问题也集中在这一层**：
- **锁**：主进程与 MCP 已共享同一把锁文件（`<root>/montage.json.lock`，两侧逐字符一致），但**超时语义相反**——main 超时后"降级为无锁写"（main.js:91-95），MCP 超时抛错（mcp-server.mjs:118）。前者恰好击穿 N-A1 的修复意图：agent 持锁时 UI 2 秒后无锁覆写，且因 `markSelfWrite` 记下新文本，这次丢更新**不会被回环广播暴露**。
- **MCP**：`set_shot_image` 无大小上限（主进程对称实现有 96MB）+ 落盘在锁内 + 失败无回滚；`import_assets` 批量 `readFileSync/copyFileSync` 也在锁内，两者共同放大"陈锁窃取（>10s）"窗口。
- **模型归一**：**10 个 MCP 工具无一写 fabula.json**，UI 与 Agent 已共享 montage.json 单一真相源——H-2 方向彻底落地。但 `export:backupJson` 桌面分支仍读 fabula.json（settings.js 的浏览器分支却导 montage 模型），备份入口形同虚设。

### 数字总览

| 类别 | 数量 |
|---|---|
| R2 待验证项复核 | 37 项（28 FIXED / 7 PARTIAL / 2 NOT FIXED / 0 REGRESSION） |
| 上轮死代码复测 | 本区相关项**全部删净**（含 TOOLS/panBy/resetBrush 六连、__fabulaActions、_radialOpts、brushes.params、b-pressure 死控件等） |
| 本轮新发现 | **23 条**（高 1 / 中 6 / 低 16，其中 0 条回归） |
| 测试 | 25/25 通过（7 文件）；新测试自身有 1 处确证缺陷（D-1） |
| 端口 | 复测仍**零占用** |

---

## 二、R2 待验证项修复验证（分四区）

### 2.1 主进程区（R2 待验 20 项）

| 编号 | 判定 | 证据要点 |
|---|---|---|
| **N-A2** shotFiles 嵌错 | **FIXED** | main.js:574-599 顶层；16 个 handler 逐个状态机核验深度全 0；storyPdf 于 569 正确闭合 |
| **N-A3** Windows 语义绕过 | **FIXED** | `normBaseOf`（main.js:63-68）剥尾点+转小写；`isProtectedBase` 三面统一（拒读 135 / 拒写 404 / **拒删 423 新增**） |
| N-B21 shotFiles 显式路径 | PARTIAL | 通道已加 `dirPath` 第二参（574/586）与 preload 透传；但 `--smoke-export`（277-291）未调用它，UI 也不传 → **具备能力但无自动化驱动** |
| N-B22 导出落盘非原子 | **FIXED** | 四处全改 `store.writeAtomic`（492/538/563/596），tmp HTML 也补了 pid |
| N-B23 关窗 3 秒兜底 | 维持 | 无取消路径（设计取舍）；新观察：迟到 closeReady 有 `isDestroyed()` 保护，无异常 |
| M-4 importAssets 孤儿媒体 | **FIXED** | `copied[]` 回滚删文件 + 内存 assets 过滤（projectStore.js:254-282） |
| M-10 任意路径 | PARTIAL | `approvedDirs/approvedFiles` 白名单三处守卫（360/386/463）+ 对话框登记（367/456）。**但 `isApprovedPath` 首行 `SMOKE \|\| FABULA_EXPORT_TEST==='1'` 直接 return true**（main.js:105）——该变量本是导出测试开关，被复用为目录白名单总开关，置 1 时三处防御全部旁路 |
| L-16 版本上限 | **FIXED** | `src.version > FORMAT_VERSION` 抛 E_VERSION（projectModel.cjs:107-111），测试有用例 |
| L-17 onChanged 退订 | PARTIAL | preload.js:27-31 已返回退订函数；app.js:761 忽略返回值（每页只订阅一次，当前无泄漏） |
| N-B7 store.saveProject 死导出 | **FIXED** | 函数体删除（projectStore.js:93-95），makeId/pointerPath 一并清 |
| N-B17 .gitignore | **FIXED** | 补 `montage.json.lock`、`*.tmp-*`（:6-7） |
| N-B18 onChanged 注释 | 部分 | 补了 `sources`；仍缺 `files`（→ R3 D-7） |
| 正向项 | **全部完好** | sandbox:true(175) / CSP(8-9) / 单实例锁(16-23) / uncaughtException(11-12) / writeAtomic / markSelfWrite(139-141) |

### 2.2 渲染层核心区（R2 待验 12 项）

| 编号 | 判定 | 证据要点 |
|---|---|---|
| **N-A1 并发保存丢更新** | **PARTIAL** | 锁已跨进程同源（main `abs+'.lock'` ≡ MCP `montage.json.lock`）✅；**但仍盲写全量**——`storage.saveProject` 直接 `JSON.stringify(内存模型)`（storage.js:158-160），`mergeProjects` 只在 reloadExternal 用（app.js:853），保存路径无重读/无合并。丢更新窗口从"整段交错"收窄为"agent 写完后 UI 用陈旧快照覆写"，未根除 |
| **N-A4 轨道头双 transform** | **FIXED** | 旧监听删除并留注释（timeline.js:42-43）；全文件 `addEventListener('scroll'` 仅 1 处（213）；`_headSync` 幂等（211-212） |
| **N-A5 换图不广播** | **FIXED** | 四段闭环：`mediaFiles` 采集（148-155）→ `sources.push('media')`+`files`+清空（211-216）→ 自写抑制 `markSelfMedia/consumeSelfMedia`（26-42，含 Windows 多事件"窗口内不删除"语义）→ 渲染端 `refreshMedia`（832-849，仅当前帧命中且非 dirty 才重读）。有针对性单测 |
| N-A6 互斥 | PARTIAL | `switchingProject`/`externalReloading`/`externalPending` 三件套 + finally 补跑已落地；**但 media 分支在 `externalReloading=true` 之前提前 return**（780-781），media 刷新期间恒不设标志 → 两路 refreshMedia 可并发 |
| N-B1 无补跑 | **FIXED（montage）** | `externalPending` + `flushPendingExternal()`（301-308, 822-825）；media 路径同 N-A6 根因仍缺 |
| N-B2 _loadQueue 不校验 token | **FIXED** | job 体内 `if (tk !== B._token) return;`（board.js:465） |
| N-B4 backupJson 死通道 | **FIXED（接线）/ 语义错误** | settings.js:340-341 新增「工程 JSON 备份」按钮，通道复活；**但桌面分支备份的是 fabula.json**（main.js:492），浏览器分支导的是 montage 模型（settings.js:217）→ 两端不一致，桌面备份与当前工程无关（→ R3 D-2） |
| N-B5 空桩死调用 | NOT FIXED | board.js:208 三空桩仍在，调用点从 8 处增至 **12 处**（无功能损害） |
| N-B6 closePaint 不检查 flush | **FIXED** | `if (ok === false) { toast + return; }`（sheet.js:435-439） |
| N-B24 故事板双实现 | PARTIAL | 双实现仍在，但已加注释区分数据源（devhooks.js:6 / main.js:496-497）；`__fabulaExport` 仅冒烟用 |
| M-13 导出链路 | PARTIAL | shotFiles 独立注册、storyPng/storyPdf 参数契约与三态错误处理匹配；shotFiles 不传 dirPath 属故意（桌面恒弹对话框） |
| 顺带复核 10 项 | **全部完好** | L-1 保 dirty / L-5 令牌 / L-7 共用帧提示 / L-8 画幅提示 / M-17 paused / M-18 解码 / M-19/20 缓存 / M-22 重入 / N-B3 色板读写闭环 |

### 2.3 引擎与 UI 区（R2 待验 15 项）

| 编号 | 判定 | 证据要点 |
|---|---|---|
| N-A7 轮盘键双数据源 | PARTIAL | 主链路统一到 radialKey（`keyOf` 特判 settings.js:174、keyup 直比 app.js:728）✅；**残留两处**：① `record()` 对 cmd.radial 绕过 `setKey` 撞键清理（488）→ 录到已占键位被永久抢占；② `radialKey \|\| 'V'` 使**清空后仍回退 V**，面板显示「未设置」但按键生效（→ R3 B-1/B-2） |
| N-A8 压感死控件 | **FIXED（主体）** | 滑杆与复选框已删（index.html:234 留注释），grep `b-pressure/b-pt/usePressure` 零命中；残留 `core.js:269` 的 `brush.pressure/usePressure` 死状态位（→ R3 B-6） |
| N-B8 喷枪 ang | **FIXED** | 改 `rnd() * Math.PI * 2`（paint.js:3310-3314），回归种子化体系 |
| N-B9 __fabulaActions | **FIXED** | 已删（paint.js:2484 注释），幻影 data/actions 引用同步清除 |
| N-B10 模糊 title (R) | NOT FIXED | index.html:144 仍写「模糊 (R)」，实际默认键 U（settings.js:57） |
| N-B11 引擎零消费导出群 | **FIXED** | TOOLS 退为内部（不在导出对象）；panBy/resetBrush/exportLayerPNG/loadLayerFromURL/clearHistory 全清（paint.js:3419 注释） |
| N-B12 _radialOpts | **FIXED** | grep 零命中 |
| N-B13 brushes params/scatter | **FIXED** | `list` 仅返 `{id,label,icon,key}`，PARAM_META 整段删除 |
| M-16 笔刷键位宣称 | **FIXED（P/K/G/A）** | `def: b.id==='pen' ? '' : (b.key\|\|'')`（settings.js:99）+ 引擎 BRUSHES.key → P/K/G/A 已真实绑定；pen 改标「B = 画笔工具」 |
| 衬底 / H-8 / L-21~L-27 | **全部 FIXED 或完好** | 吸管纸色与 board 底色逐像素一致（paint.js:1860 / board.js:331）；resize 三链完好且 `#ov` 无内联尺寸；err 遮罩可关、hidden 降频、扩展单请求、无空 keyup、picker 按键过滤、penPrefs 四段闭环、data-theme 已删 |

### 2.4 集成与 MCP 区（R2 待验 10 项）

| 编号 | 判定 | 证据要点 |
|---|---|---|
| N-A5 换图广播（集成视角） | **FIXED** | 登记键（`r`）与消费键（`name.replace(/\\/g,'/')`）格式一致，跨进程无漏 |
| **N-A1 锁（集成视角）** | **PARTIAL** | 同一锁文件已确证；**超时语义相反**（main 降级无锁写 vs MCP 抛错），存在"UI 2s 后无锁覆写 agent 更新"路径（→ R3 D-2） |
| N-B14 b.path 无白名单 | **FIXED** | 正则重建 `^boards\/[A-Za-z0-9._-]+\.png$`（mcp-server.mjs:448-451），`/` 被排除，不可穿越 |
| N-B15 -32700 / 行上限 | **FIXED** | Parse error 回包（569）+ `MAX_LINE=8MB`（613/624） |
| N-B16 幽灵媒体 + 锁内 IO | PARTIAL | import_assets 已加 `onWriteError` 回滚（521-524）；**set_shot_image 未加**（439 仅两参），且无大小上限、落盘在锁内 |
| N-B19 陈锁窃取 | NOT FIXED | 两侧均 >10s 强删锁（main:89 / mcp:116）；而锁内大 IO 确实可超 10s（import_assets 64 文件循环、set_shot_image 无上限） |
| N-B20 基线 null 首写被吞 | **FIXED** | `lastMontage===null` 时广播（projectStore.js:199-208），测试直接断言 |
| N-A2（集成复核） | **FIXED** | 16 handler 深度全 0，独立复核一致 |
| M-3 锁只圈 MCP | **FIXED** | UI 保存全经 `project:writeFile` → 同一锁（main.js:408-409） |
| 正向项 | **无回归** | 工具清单仍 10 个；resolveProject 优先级链与注释一致；NDJSON 协议完整（仅 stdout 背压未处理） |

**模型归一达成度**：**10 个 MCP 工具无一写 fabula.json**，全部面向 montage.json（UI 模型）。`normalizeMontage` 保持"保守修形不丢未知字段"（只补顶层缺失字段，不重排/不丢弃），`relayoutTrack` 几何与 UI 语义一致——未发现"一个坏 patch 毁工程"的路径。

---

## 三、本轮新发现问题（23 条）

### 3.1 高 / 中（7 条）

**D-1〔中·确证〕`test/main-ipc.test.mjs` 清洗逻辑缺陷：漏检 1 个 handler + 行号错位 93 行**
位置：test/main-ipc.test.mjs:17-22（注释正则先于字符串替换）。
复现证据（只读脚本）：原文 615 行 → 清洗后 522 行（偏差 93）；`ipcMain.handle(` 命中 16 → 15；**漏检 main.js:148 `app:close-ready`**。触发点 main.js:141 `if (org === 'fabula://app')`——`//` 被当行注释剥掉，残留未闭合单引号，第 20 行单引号正则跨行吞并后续代码。
影响：第一个用例（**专为抓 N-A2 而写**）对"未在 preload 暴露的内部通道"静默漏检；断言失败时行号偏差最大 93 行误导定位。第二个用例在原文匹配，暂能兜住 preload 通道，故当前未失守。
修复：改逐字符状态机解析；或行注释正则改 `(?<!:)//[^\n]*` 并同步处理正则字面量。

**D-2〔中·确证〕`withProjectLock` 超时降级为无锁写，与 MCP 语义相反，击穿 N-A1 修复意图**
位置：main.js:91-95（`break` 后 `try { return fn(); }` 未持锁执行）；对比 mcp-server.mjs:118（throw）。
影响：agent 持锁期间 UI 保存等 2s → **无锁全量覆写** montage.json；且 UI 用 `markSelfWrite` 记下新文本（410），notify 读回恰是自己写的 → **该次外部丢更新不会被广播暴露**，双向静默。陈锁阈值两侧同为 10s、轮询 20ms vs 30ms 也不一致。
修复：与 MCP 对齐（超时抛错 + 渲染端重试），或降级写前重读磁盘比对。

**D-3〔中·确证〕MCP `set_shot_image` 无大小上限 + 锁内落盘 + 失败无回滚**
位置：mcp-server.mjs:415-458（写盘 453 在 withLock 内；`mutate(root, fn)` 439 未传 `onWriteError`）。
影响：与主进程对称实现（96MB 上限，projectStore.js:107）不对称；超大载荷在持锁期间完成巨量 IO → 触发 D-5 窃锁；清单写失败留下幽灵帧文件。
修复：补 96MB 上限 + 传 `onWriteError` 回滚 + 媒体 IO 移出临界区。

**D-4〔中·确证〕MCP `import_assets` 锁内做多文件 IO，放大窃锁窗口**
位置：mcp-server.mjs:491-520（`readFileSync/copyFileSync` 循环最多 64×96MB 全在 `mutate` 锁内）。
影响：批量导入大素材易超 10s → 等待者 `rmSync(lock)` 窃锁 → 双写。与 D-3 协同。
修复：复制媒体移出锁定临界区（先复制、再持锁写清单）。

**D-5〔中·确证〕陈锁窃取竞态（N-B19）的实际可达性已被 D-3/D-4 证实**
位置：main.js:88-89 / mcp-server.mjs:114-117。原判"窗口极窄"的前提（单次写不会 >10s）因锁内大 IO 而不成立。

**D-6〔中·确证〕`FABULA_EXPORT_TEST` 复用为目录白名单总开关**
位置：main.js:105（`if (SMOKE || process.env.FABULA_EXPORT_TEST === '1') return true;`），被 360/386/463 三处守卫调用。
影响：该变量本是导出通道测试开关，现成为路径白名单总开关——任何置 1 的环境（CI/脚本）下 M-10 纵深防御整体失效，`importPaths` 可读任意用户文件。
修复：目录守卫只认 `SMOKE`，与导出测试开关解耦。

**D-7〔中·确证〕桌面「工程 JSON 备份」导错模型**
位置：main.js:492（读 `fabula.json`）vs settings.js:217（浏览器分支导 `MTG.state.project`=montage 模型）。
影响：桌面用户点备份得到与当前工程无关的旧模型文件；两端行为不一致。N-B4 只接通了通道，未接通数据源。
修复：`export:backupJson` 改读 montage.json（缺则回退并提示）。

### 3.2 低（16 条，摘要）

| 编号 | 位置 | 问题 |
|---|---|---|
| B-1 | settings.js:174 | 轮盘呼出键**清空后仍回退 V**（`radialKey \|\| 'V'`），面板显示「未设置」但按键生效 |
| B-2 | settings.js:488 | 轮盘录制**绕过撞键清理**（不调 setKey）→ 录到已占键位被永久抢占，静默失效 |
| B-3 | devhooks.js:464/537/596 | **三个新探针（penProbe/tlDragProbe/radialProbe）无任何 `--smoke-*` 驱动**——173 行探针"写了不跑"，压感/轮盘/时间轴回归并无自动化保障 |
| B-4 | devhooks.js:540-559, 599-609 | 探针污染全局状态且不恢复：radialProbe 只恢复 `radialRight`，currentBoardId/伪 board/伪 project 残留；tlDragProbe 造 clips 后无清理；penProbe `clearLayer('fg')` 会清空当前线稿 |
| B-5 | devhooks.js:460 vs 492 | 注释断言矛盾（称"首帧 >0.25"实际断言 `<=0.02`） |
| B-6 | core.js:269 | 死状态位 `brush.pressure/usePressure`（N-A8 残留，零读取） |
| B-7 | style.css:19 | 死 CSS `--green` 仍在（只 `--green-rgb` 被消费） |
| B-8 | style.css:526,564,924 + board.js:331 + paint.js:1860 | 衬纸色 `#f5f0ea` 散落 **6 处**无单一来源，未来改色易致 L-20 类 bug 复发 |
| B-9 | board.js:208 + 12 处调用 | 空桩 `syncCursor/paint/refreshRing` 死调用（N-B5 未收口，调用点 8→12） |
| B-10 | app.js:343-353 | `openFolderInner` 打开已有工程时不复位 `MTG.state.dirty`（上工程残留脏 → 多余 autosave） |
| B-11 | app.js:832-849 | `refreshMedia` 未清 `onionLoading`（in-flight 旧图会回填脏缓存）与 `MTG.audio.cache` |
| B-12 | app.js:814 等 5 处 | `saveProject` 仅 saveTick 走 `saving` 串行闸，其余 5 处（323/405/746/754/814）绕过 → 仍可并发全量写 |
| B-13 | assets.js:246 + app.js:837 | `refreshMedia` 调 `resetCaches()` 连带清 `collapsed` → agent 每改一图，素材库折叠状态全被展开 |
| B-14 | app.js:853-865 | `mergeProjects` 未并集 `tagOptions`（当前 MCP 不写，暂无损失） |
| B-15 | main.js:415 | 自媒体抑制用未归一化 `r` 判定，`x/../boards/a.png` 可绕过登记（当前 UI 恒生成规范路径，不可达） |
| B-16 | board.js:532-541 | `thumbUrl` 并发不去重，miss 时并发调用会泄漏 blob URL |
| B-17 | mcp-server.mjs:563 | `send()` 未处理 stdout 背压 |
| B-18 | preload.js:24-25 | onChanged 注释仍缺 `files` 字段 |
| B-19 | 根目录 | `smoke-shot.png`、`smoke.log` 物理残留（已被 ignore，建议删除） |
| B-20 | project-store.test.mjs:23 | 设置不存在的 `st.mediaDirty`（实现无此字段）；setup 未清 mediaFiles/selfMedia |
| B-21 | main.js:498 + preload.js:41 | `export:imageSequence` 仍为死通道（渲染端零调用，数据源还是 fabula 模型） |

---

## 四、测试套件评估

**实跑：`node --test "test/*.test.mjs"` → 25/25 通过，9.09s，0 失败。** 7 文件与 package.json:10 对齐全中。

| 文件 | 用例 | 质量 |
|---|---|---|
| project.test.mjs | 8 | **最好**：值级+正则+deepEqual+边界，含 E_VERSION 用例 |
| mcp-server.test.mjs | 1 | **最硬**：spawn 真进程 + 真磁盘 + 字段级断言 + 锁/tmp 不残留断言 |
| project-store.test.mjs | 4 | 战场覆盖到位（基线 null 首现广播 / media 一次性广播 / 自写抑制 + files / fabula 隔离）；**但绕开真实 fs.watch**，`startWatch` 与 `markSelfWrite` 未覆盖 |
| main-ipc.test.mjs | 2 | 方向正确（专杀 N-A2）；**D-1 缺陷**使其对内部通道静默漏检 |
| prefs / actions | 3+3 | 源码级正则，防回归有效、对重构脆弱 |
| shots-geometry | 4 | **半真**：`starts()` 是测试内复刻品，非 MCP `relayoutTrack` 本体 → 实现漂移测试不红 |

**仍未覆盖的高风险面（按风险）**：① `withProjectLock/withLock` 并发与超时语义（D-2/D-5 的战场，零测试）；② `export:shotFiles` 端到端（N-A2 受害通道本身无测试 + 无自动化驱动）；③ 渲染层 `reloadExternal`/`mergeProjects` 状态机（N-A6/B-12 战场，零测试）；④ 真实 fs.watch + markSelfWrite；⑤ MCP 陈锁窃取/EBUSY 重试/导入回滚；⑥ sniffAsset 品牌判定。
**共性**：三轮"接缝伤"（N-A2、A6、B12、D-1）全部落在**未被测试覆盖**的三类面上——这本身是最可靠的测试优先级信号。

---

## 五、端口 / 残留 / 工程卫生

- **端口：全项目零占用**（复测无 listen/ws/http server；MCP 纯 stdio NDJSON）→ 与 8765/8766/8767 无冲突。
- **残留**：根目录 `smoke-shot.png`、`smoke.log`（已被 .gitignore 覆盖，建议清理）；无锁文件/tmp 残片。
- **.gitignore**：N-B17 已补 `montage.json.lock`、`*.tmp-*` ✅。
- **package.json**：test 脚本与 7 文件对齐全中；`main`/`mcp`/`start` 路径均存在且一致；`.npmrc` 新增（镜像配置，合理）。

---

## 六、三轮趋势

| 轮次 | 新发现问题 | 回归 | 高危 | 修复率 | 主题 |
|---|---|---|---|---|---|
| R1 | 60 + 34 死代码 | — | 9 | — | 架构断裂（双模型/死通知）+ 数据丢失链 + 安全三件套 |
| R2 | 31 | 2（高1中1） | 1 | 78% | 修复自身的接缝伤 + 并发编排缺口 |
| **R3** | **23** | **0** | **0** | **76%** | **并发语义未穷尽 + 防御被测试开关旁路 + 元层（测试自身有洞）** |

**趋势判断**：问题总数与严重度持续下降（60 → 31 → 23，高危 9 → 1 → 0），**连续两轮修复零回归**（本轮 R2 的两条回归全部修净，未新增回归）。风险面已从"功能/架构"下移到"并发语义精度"与"元层"——本轮最有价值的发现（D-1）恰恰是**验证手段自身的缺陷**，这说明项目已进入"需要为验证工具本身建立验证"的阶段。

---

## 七、下一步建议（按优先级）

1. **修 D-1**：`main-ipc.test.mjs` 清洗改逐字符状态机——这是"抓回归的网"自身有洞，优先级高于本轮任何业务修复。
2. **统一锁语义（D-2）**：main 超时改为抛错+渲染端重试（或降级前重读比对），并把陈锁阈值/轮询/超时三参数在 main 与 MCP 间对齐；顺手把 D-5 的窃锁窗口收窄。
3. **MCP 写路径收口（D-3/D-4）**：媒体 IO 移出锁外 + 补 96MB 上限 + `onWriteError` 回滚。
4. **两处"开关越界"（D-6/D-7）**：`FABULA_EXPORT_TEST` 与目录白名单解耦；backupJson 改读 montage.json。
5. **UI 撒谎收尾**：轮盘键清空语义与录制撞键（B-1/B-2）、模糊 title (R)→U（B-10）。
6. **探针接线或删除（B-3/B-4）**：给三个探针加 `--smoke-*` 分支并在 finally 恢复 state，否则它们只是"写了不跑"的 173 行。
7. **测试补射程**：优先 ① 锁并发语义 ② 渲染层 reloadExternal/mergeProjects 状态机 ③ shotFiles 端到端——三轮接缝伤全在这三处。
8. **清理面**：12 处空桩死调用 + imageSequence 死通道 + devhooks 双实现 + `--green` + `brush.pressure/usePressure` + 衬纸色收敛为 `--paper` token。

---

*第三轮审计：4 路并行子代理逐行通读 + 交叉验证；D-1 经只读脚本复现确认（615→522 行、16→15、漏检 app:close-ready），N-A2 经人工状态机复核（16 handler 深度全 0）。测试套件实跑一次（25/25）。全文只读，未改动项目任何文件。*
