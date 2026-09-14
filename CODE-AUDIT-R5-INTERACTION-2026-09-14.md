# Fabula · 第五轮审计报告（交互修复验证 + 回归排查）

| 项 | 内容 |
|---|---|
| 审计日期 | 2026-09-14 |
| 审计对象 | **当前工作区**（未提交；`git diff --stat` = 15 文件 +945/−105，HEAD 仍是 `dd5da54`） |
| 方法 | 4 路交互专项子代理逐条复核 R4 的 48 条缺陷 + 回归排查 + 探针可信度审查；人工复核环路口径并实跑测试套件 |
| 性质 | 只读审计，未修改任何项目文件 |

---

## 一、执行摘要

**修复质量：高，重点抓得准。** R4 的 8 条 🔴 有 **6 条真修**（S-1/S-2/S-4/S-5/S-6/S-8），14 条 🟠 有 **10 条真修**（H-2/H-3/H-4/H-5/H-6/H-7/H-8/H-11/H-12/H-14）。尤其值得肯定：**画布区三条重灾区（不透明度单位、图层接线、变换跨帧）全部"追到了引擎"**——这正是 R4 最有价值的批评（控件接了假目标），本轮被正面解决；时间轴拖拽五连（换位语义、跨轨跟随、自吸附死区、裁剪吸附、窄块手柄）也都是真改语义而非改文案。

**但本轮出现一个清晰的模式：「修复只覆盖了显式路径」** —— 同一个语义的旁路没堵，占本轮新发现问题的一半：

| 被修的路径 | 没堵的旁路 | 后果 |
|---|---|---|
| 键盘在弹窗期间被拦（S-3） | **轮盘菜单直调 `settings.run`，绕过该守卫**（`radial.js:131`，z-index 400 盖在弹窗上） | 弹窗里按住 V 选一个绑了"下一镜"的扇区 → **照旧换帧、笔迹写错帧**（与 S-3 同级的内容损坏） |
| 分镜表「删除」按钮加了确认 + 清理链（S-7） | **键盘 Delete 仍走 `timeline.deleteSelected()`**（只 `clips.filter`，零确认、不删 board/磁盘） | 用 Delete 删镜头照样攒出**删不掉的孤儿帧** |
| 三个消费者把 `pointercancel` 写成"取消即复位"（M-2/M-3） | **片段拖拽把 `pointercancel` 直接接到了 `up` 上**（`timeline.js:909`） | 笔/触屏被打断时**取消却照常提交**位置 |
| `penToMouse` 重放 down/move/up | **独独不重放 `pointercancel`**（`app.js:499-503`） | 笔的取消被永久吞掉 → `scrubbing` / `TL.dragging` 卡死 |
| 拖拽期间挂起外部同步（H-13） | **`TL.dragging` 只由 pointerup 复位、无任何兜底** | 拖拽中被 render 摘除元素 → `dragging` 永久 true → **外部同步进入永久 500ms 轮询、外部改动永不应用**（本轮唯一"功能整体卡死"级缺陷） |
| 滚轮横向滚动补上了（H-3） | 新分支对**所有** `deltaY≠0` 都 `preventDefault` 转成横向 | **轨道纵向滚动被吃掉**（≥3 轨道即复现，滚轮"完全没反应"） |

**另一个复发的问题：验证网自身又出问题。** 本轮新写的 3 个探针**全部未接线**（`assetLifecycleProbe`/`groupRenameProbe`/`importNamingProbe` 在 `test/` 里零调用），而接进去的两个断言经算术复核是**假绿/空断言**：
- `snapFreeOK`（`devhooks.js:637`）：探针分 4 步、每步 0.1s，`pxPerSec=60` → 吸附容差 0.1333s。**无论候选集是否含被拖片段自身，终值都停在 3.4** —— 该断言无法区分 H-6 修没修。
- `playheadFrozen`（`devhooks.js:1008`）：测量时刻 `p.clips` 只有 1 个片段，此时按 `→` 本来就"已经是最后一镜"、播放头天然不变 → **断言恒真**，S-3 的方向键那半边实际未被验证。

也就是说：S-3 与 H-6 看起来"有保护"，实际没有。这与 R3 的"探针写了不跑"、R4 的"探针测试红着没人发现"是同一个母题的第三次发作。

### 数字总览

| 类别 | 结果 |
|---|---|
| R4 🔴 8 条 | 6 FIXED / 2 PARTIAL（S-3、S-7） |
| R4 🟠 14 条 | 10 FIXED / 4 PARTIAL（H-1、H-9、H-10、H-13） |
| R4 🟡 15 条 | 3 FIXED / 12 NOT FIXED |
| R4 ⚪ 11 条 | **1 FIXED / 10 NOT FIXED**（几乎原封未动） |
| **本轮新发现问题** | **25 条**（🟠 9 / 🟡 12 / ⚪ 4），其中**回归 6 条** |
| 测试（我的沙箱） | 30 用例 / 27 通过 / 3 探针用例红 —— **环境限制，非项目缺陷**（见附录） |

---

## 二、修复验证总表

### 2.1 🔴 严重（8 条：6 FIXED / 2 PARTIAL）

| 编号 | 判定 | 关键证据 |
|---|---|---|
| **S-1** 不透明度滑杆单位 | **FIXED** | 滑杆改 `min=1 max=100`（`index.html:238`）+ `pctToUnit = v => clamp(v/100,0.01,1)`（`app.js:664-682`）+ 回填 `×100`；**引擎侧双保险**：`setParam` 对 `opacity>1` 自动 `/100` 并 clamp（`paint.js:3406-3411`）、`applySavedBrushParams` 读时修正（`2536-2551`）。写入链经 `bp` Proxy 直达引擎 `P` ✅ |
| **S-2** 图层按钮未接引擎 | **FIXED** | `app.js:635-647` 调 `MTG.board.setLayer()` → `board.js:246-252` → 引擎 `setLayer`（`paint.js:3417`）；UI active 态改由 `onLayerChange` **单向回写**（唯一真源）；**无回声循环**（同层时 `setLayer` 返回 false 不通知）；清层经 `withLayer(id)` 清对应层 ✅ |
| **S-3** 弹窗期间全局快捷键 | **PARTIAL** | 主路径已堵：`PM_BLOCK` 集合 + 方向键 + `cmd.del`（`app.js:842-856`），拦截点在动作分发之前；Ctrl+Z 正确放行。**残留三条**：① **轮盘旁路**（见 R5-1，高）；② `PM_BLOCK` 含 `cmd.play`，而空格平移就写在 play 分支里 → **弹窗内无法空格平移**；③ **Esc 关不掉弹窗** |
| **S-4** 变换跨帧 + 方向键双绑定 | **FIXED** | `board.js:497-498/599-601` 在 `clearForShot()` 前补 `B.xfEnd()`；引擎 `loadImageToLayer` 内兜底 `if (xf.on) xfCancel()`（`paint.js:2710`）；宿主 `if (MTG.board.xf && /^Arrow/.test(e.key)) return;`（`app.js:857-859`，document 冒泡早于 window，微调仍生效）✅ |
| **S-5** 保存失败静默 + 无反馈 | **FIXED**（1 处残留） | 顶栏新增 `#save-state` 五态（idle/dirty/saving/saved/failed，`index.html:47` + `style.css:186-191`）；`#btn-save` 包 try/catch + 失败 toast + "保存已恢复"提示（`app.js:514-530`）；自动保存也走 `syncSave`。**残留**：关窗握手（`app.js:906-922`）仍只有 `console.warn`，落盘失败用户不可见 |
| **S-6** 双击画面冲突 | **FIXED** | 分镜表 `sheet.js:210-223`、故事板 `story.js:121-136` 均补 `dblclick` + `stopPropagation` + 单击 220ms 延迟判定；`setView` 在弹窗态被 `app.js:299-305` 挡住（残缺布局一并消除）✅ |
| **S-7** 删镜头无确认/孤儿帧 | **PARTIAL** | 按钮路径已修：二次确认（同一按钮 3s 内再点，`sheet.js:394-401`）+ 复用 `MTG.assets.removeItems` 清理链（boards 条目/引用片段/磁盘回收/缓存）；含**共享帧保护**。**残留**：键盘 `Delete` 仍走 `timeline.deleteSelected()`（`timeline.js:977-985`，只 `clips.filter`）→ 零确认、孤儿帧、不可撤销 |
| **S-8** 放映空镜回填上一镜 | **FIXED** | `const tk = ++S._showToken;` 提到取到镜头后、所有分支之前（`story.js:437`），空镜/缺失分支均在递增之后 ✅ |

### 2.2 🟠 高（14 条：10 FIXED / 4 PARTIAL）

| 编号 | 判定 | 证据要点 |
|---|---|---|
| H-1 自动保存间隔不生效 | PARTIAL | 已订阅 `settings.onChange` → 重排 `setupAutosave`（`app.js:1189-1197`）；**但「全部恢复默认」走 `removeItem+load()+apply()` 不派发 listeners**（`settings.js:302-307`）→ 重置后定时器仍按旧间隔跑。另新增副作用：任何设置写入（含拖笔刷滑杆）都重排定时器（见 R5-2） |
| H-2 顶栏吸附不落设置 | **FIXED** | `app.js:567-570` 改走 `MTG.settings.set('snap')`；listener + `apply()` 三方同值，不再互相覆盖 ✅ |
| H-3 滚轮横向滚动缺失 | **FIXED**（新回归） | `timeline.js:42-45` 补非 Ctrl 分支 + `deltaMode` 折算 + `preventDefault`。**副作用**：`deltaY` 一律转横向 → 纵向滚动被吃（见 R5-3） |
| H-4 换位压缩整轨 | **FIXED** | `timeline.js:811-836` 改为**只交换两个槽位**（`aStart ↔ target.start`）+ `freeStart` 处理时长不等；未触碰片段原地不动 ✅（与 `tlDragProbe.thirdUntouched` 断言一致） |
| H-5 跨轨拖动不跟随 | **FIXED**（隐患） | `timeline.js:849-882` 真 `appendChild(el)` 到目标轨 ✅；**隐患**：换轨/顺推后未重建 pointer capture → 可能中途冻结（见 R5-5） |
| H-6 自吸附死区 | **FIXED** | `snapTime(t, soft, excludeId)` 排除自身（`timeline.js:587-599`），三处被拖路径全传 `clip.id` ✅ |
| H-7 裁剪不参与吸附 | **FIXED** | 左右边缘均过 `snapTime` 并重新夹邻居边界（`timeline.js:787/799`）✅ |
| H-8 窄片段手柄重叠 | **FIXED** | 手柄宽 `Math.max(3, Math.min(7, Math.floor(clipW/3)))`（`timeline.js:384-387`）→ 最小块两端各 3px、互不重叠 ✅ |
| H-9 波形/缩略图刷新族 | PARTIAL | 三条子路径都补齐：同名覆盖导入（`assets.js:464-481`）、外部换音频（`app.js:1023-1038` 含 `ensureLoaded` 重解码）、存帧缩略图（`board.js:550-553` + `timeline.js:412-424`）✅。**残留**：同一次广播同时含 `montage`+`media` 时走 montage 分支 → **`info.files` 被完全丢弃**、音频缓存不作废（见 R5-4）。另：**素材库面板的分镜帧缩略图**仍不刷新（`flush` 只清 `thumb`/时间轴，未清 `A.urlCache`） |
| H-10 笔刷参数跨工具污染 | PARTIAL | 已收敛为**单项 patch**（`app.js:664-679`），但**目标 id 仍用 `MTG.board.brushId`**（只在 5 支画笔间更新）而非当前引擎工具 id → R4 原始复现**仍在**（橡皮上拖大小 → 写进 `brushParams['pen']`）；`stepBrush`（`[`/`]`）更是全量 bp + 同一错误 id（见 R5-6） |
| H-11 空态吞掉指针事件 | **FIXED** | `_blockPaint()` 放行 `hand`/`zoom`/空格（`board.js:27-34,86-91`）✅ |
| H-12 存帧后缩略图不刷新 | **FIXED** | `flush()` 调 `MTG.timeline.refreshBoardThumb(b.id)`（`board.js:550-553`），遍历 `.clip>img` 重设 src ✅（素材库面板侧见 H-9 残留） |
| H-13 外部广播腰斩操作 | PARTIAL | 拖拽期挂起广播 + `resumeExternal` 补跑（`app.js:948-954`、`timeline.js:904-905`）✅；**但 `TL.dragging` 无兜底复位** → 可永久卡死并让外部同步无限轮询（见 R5-7） |
| H-14 素材库并发 render | **FIXED** | 渲染代际令牌 `A._rt`，await 边界后校验，`resetCaches` 作废在途（`assets.js:19/34/73/84/89/396`）✅ 括号纪律正确 |

### 2.3 🟡 中（15 条：3 FIXED / 12 NOT FIXED）

**FIXED**：M-2（轨道行/头 `pointercancel` 取消即复位）、M-3（标尺 `scrubbing` 复位，但笔取消路径被 penToMouse 吞掉）、M-12（空格双击消费，静态推断 `preventDefault` 已生效，**需实测**）

**NOT FIXED（12 条）**：M-1（`#timecode` 仍与播放头脱节——`render()` 仍不写时间码，`app.js:387/403` 直接赋值 playhead）、M-4（`penToMouse` 仍不覆盖素材库起拖）、M-5（**两套"取当前镜头"仍在**，且 `openPaint` 不校验 `currentBoardId === shot.boardId` → 多分镜轨时**弹窗可能编辑另一轨的帧**，与 S-3 同级的静默写坏内容）、M-6（`#f-hex` 非法输入仍不还原 + 仍 blur-only）、M-7（`#f-h/s/v` 仍无焦点保护）、M-8（`#sel-commit` 与 `#sel-cancel` 仍同效）、M-9（拾色器仍双重重绘 + 抖动）、M-10（缩放仍三套 clamp，`#z-in` 连点仍无界）、M-11（`Ctrl+Z`/`Delete` 视图语义仍漂移）、M-13（分割条仍不持久化/双击不复位）、M-14（**素材库删除仍零确认且真删磁盘**）、M-15（`project:writeShotImage` 仍未 `markSelfMedia`）

### 2.4 ⚪ 低（11 条：1 FIXED / 10 NOT FIXED）

已修：波形/缩略图 canvas 与刷新族相关项。未修：`#ref-show` 初始态、`#size-w/h` Enter、`.panning` 死 CSS、`#brush-params` 导入预设不刷新、`#b-size` 200 vs 400、**油漆桶 `fill` 仍无任何入口**、`#tl-info` 的 10s 余量与 `0:60`、缩放锚点不一致、素材落点语义（高亮轨 ≠ 落点轨）、删轨无确认 + 悬空 `activeTrackId`、双击音频在无音频轨时落分镜轨且拖不回来、`overlaps()` 只查相邻对 + 计数口径不一、素材 `<img>` 未 `draggable=false`、导入命名三处不一致、未分组组头宣称可重命名、条目无法拖出分组、分镜表/故事板滚动位置不恢复、故事板格子大小/文字开关不持久化、`#btn-export` title 与行为不符。

---

## 三、本轮新发现问题（25 条）

### 🟠 高（9 条）

**R5-1〔高·确证〕轮盘菜单绕过弹窗模态守卫（内容安全）**
`radial.js:131` `MTG.settings.run(Rad.items[i].id)` 直接执行动作，**不经过 `app.js:842-856` 的 keydown 守卫**；且 `.radial` z-index 400 高于 `.paint-modal` 200（`style.css:798-799` vs `:595-596`）。
复现：绘画弹窗开着 → 按住 `V` 呼出轮盘 → 选绑定 `cmd.next` 的扇区。
预期：模态期间不得切帧。实际：播放头换帧、画布换成别的帧、笔迹与"存帧并关闭"写进错帧——**把 S-3 好不容易堵住的问题从侧门放回**。
修复：把模态白名单**下沉到动作分发层**（`settings.run` / acts 表），一处通吃键盘与轮盘。

**R5-2〔高·确证〕`TL.dragging` 无兜底 → 外部同步永久轮询、外部改动永不应用**
`timeline.js:777` 置位、`:904-905` 唯一复位（依赖被拖元素的 pointerup/cancel）。若拖拽中 `render()` 执行 `innerHTML=''`（窗口 resize `app.js:933`、拖 `#split-h` `app.js:781`），元素被摘除 → capture 隐式释放、pointerup 不再派发 → `dragging` 恒 true → `reloadExternal` 每 ~560ms 自续，**外部改动永不应用且永不停止**。
修复：拖拽开始挂超时兜底 + window 级 capture 的 `pointerup/pointercancel` + `renderTracks()` 前主动收尾。

**R5-3〔高·确证〕滚轮纵滚被吃掉（H-3 修复的副作用）**
`timeline.js:42-45`：所有 `deltaY≠0` 都被 `preventDefault` 并转成 `scrollLeft`。轨道溢出时本应可纵向滚（`.tl-scroll{overflow:auto}`），现在只能拖滚动条；内容不溢出时表现为"滚轮完全无反应"。
修复：仅 `deltaX≠0` 横向；有纵向溢出时交回原生（或 Shift 才横向）。

**R5-4〔高·确证〕`montage`+`media` 同广播时 `info.files` 被吞（H-9 邻症）**
`app.js:958` `if (!sources.includes('montage'))` → 只要含 montage 就整体走重载分支，`refreshMedia(info.files)` 永不执行；而 `assets.resetCaches()` 不清 `MTG.audio.cache`，`applyProject` 的 `ensureLoaded` 又因缓存命中跳过 → **音频永久陈旧（波形空白/无声）**。
修复：montage 分支内也按 `files` 逐键 `dropUrl + audio.cache.delete` 再 `ensureLoaded`。

**R5-5〔中高·确证〕`pointercancel` 在片段拖拽上被接到 `up`（取消却提交）**
`timeline.js:894-909`：`el.addEventListener('pointercancel', up)` 与 `pointerup` 同一函数 → 位置照常 `markDirty()`。同文件标尺（`:68-74`）与轨道行（`:321`）都是"取消即复位"，三处语义不一致。
修复：`up` 拆成 `finish(ev, canceled)`，取消时回滚 `start/dur/offset/trackId` 且不 `markDirty`。

**R5-6〔中高·确证〕`penToMouse` 不重放 `pointercancel` → 会话卡死**
`app.js:499-503`：被归一化的四种事件里**只有 cancel 不 `send(e)`**，捕获阶段吃掉后，标尺/轨道头/轨道行/片段的取消收尾**永远收不到** → `scrubbing` 卡 true（此后悬停标尺即拖播放头）、`TL.dragging` 卡 true（连带 R5-2）。

**R5-7〔中·确证〕H-10 修了一半：参数保存目标 id 错**
`app.js:675` 与 `stepBrush`（`:1077-1080`）仍用 `MTG.board.brushId`（只在 5 支画笔间更新），正确应为 `MTG.board.engine().id`（同一文件内的参数面板用的就是后者，`:202/221-223`）→ 在橡皮/涂抹上拖滑杆仍污染 `brushParams['pen']`。

**R5-8〔中·确证〕`settings.onChange` 订阅让任何设置写入都重排 autosave 定时器**
`app.js:1189-1197` 的 listener 无按键过滤；而 `brushes.saveParams` 经 `__fabulaPrefs.set` → `S.set` → `S.save()` → 派发 listeners（`settings.js:150-156`）→ 拖一个笔刷滑杆就 `clearInterval + setInterval`。连续编辑时定时器被无限推迟，H-1 的"间隔按时生效"失效。
修复：listener 内先判变更键（`save(diffKeys)` 或为 autosave/snap 单独订阅）。

**R5-9〔中·确证〕M-5 未修带来内容安全缺口**
`board.js:441-444`（`clipAtPlayhead`，按轨道序、只含已落帧）与 `:607-611`（`shotAt`，按数组序、含空镜头）仍是两套；`sheet.js:459-461` 先 `setPlayhead` 再依赖 `syncToPlayhead`，**不校验 `currentBoardId === shot.boardId`** → 多分镜轨重叠时弹窗标题指向所点镜头、画布却是另一轨的帧。

### 🟡 中（12 条，摘要）

| 编号 | 位置 | 问题 |
|---|---|---|
| R5-10 | `story.js:254-314/487-490` | **导出与所见不符**：`buildPng` 固定 `perRow=4/cellW=320` 且无条件画文字 → `#st-text`、格子大小对导出**完全无效**；导出期间按钮不禁用、可并发点击 |
| R5-11 | `core.js:164-166` | 标签菜单：从同一枚举字段 A 直接点相邻的 B → **B 的面板刚开就被 A 的 140ms 关闭定时器关掉**（键盘 Tab 必现） |
| R5-12 | `core.js:239-253` | 标签菜单 `position:fixed` 一次性定位、**无 scroll/resize 重定位** → 滚动表格后面板错位停在原地 |
| R5-13 | `core.js:93` vs `projectModel.cjs:22` | **字段漂移**：渲染端用 `remark`，服务端 `DESCRIPTION_KEYS` 用 `notes` → 分镜表写的"备注"在 fabula/MCP 侧读不到；故事板导出双实现（`story.js` vs `devhooks.js:95`）仍在 |
| R5-14 | `sheet.js:125-128` | 分镜表行 `dblclick` **无 target 守卫** → 双击行内输入框（选词/编辑）会直接跳去时间轴视图 |
| R5-15 | `app.js:808-811` + `timeline.js:977-985` | 键盘 `Delete` 删镜头：无确认、不清理 board/磁盘（S-7 的未堵旁路） |
| R5-16 | `sheet.js:181-199` | 分镜表跨轨拖拽后**源轨留洞**（`from<0` 时不重排源轨） |
| R5-17 | `story.js:148-226` | 详情窗：**无 Esc 关闭**、**不在模态守卫内**（Ctrl+Z/Delete 仍作用于工作台）；弹窗与详情窗都缺 Esc 关闭 |
| R5-18 | `app.js:299-326` + `:112-152` | 切回时间轴视图**不刷新 `#shot-panel`**（`syncShotPanel` 只在播放头变化/时长编辑时调用）→ 面板显示旧值 |
| R5-19 | `assets.js:118-120` | 筛选态下 Shift 范围选择：锚点不在 `_order` 时 `indexOf=-1` → 选中错误区间 |
| R5-20 | `assets.js:346` | 素材条目 ✕ 删除按钮先 `disabled=true`，`removeItems` 无 try/finally → 失败后按钮**永久灰掉** |
| R5-21 | `sheet.js:412,417` | 删镜头**双 toast 互相覆盖**（先"已移除 1 项（含 N 个引用片段）"，紧接着"已删除镜头"）→ 关键信息看不到 |

### ⚪ 低（4 条）

`devhooks.js:927-932` 探针"清理遗留文件"分支恒不执行（`legacy` 必为空）→ 注释承诺的清理没发生｜`devhooks.js:889-895/949-952` 两个探针**泄漏全局状态**（置 `storage.mode`/`state.project`、留在 sheet 视图，不还原；对照 `radialProbe`/`tlDragProbe` 都有 finally 还原）｜`app.js:422` 保存状态在 `saveAgain` 场景短暂误报"已保存"｜`app.js:1091` `MTG.ui.autosaveSec` 只写不读（死状态位）。

---

## 四、验证网健康度（本轮重点）

**探针接线状态**：`test/` 里只调用了 3 个探针（`penProbe`、`radialProbe`+`tlDragProbe`、`interactionProbe`）。以下**只定义、从不被调用**：
`assetLifecycleProbe`（`devhooks.js:880`）、`groupRenameProbe`（`:788`，含本轮新加的 IME 场景）、`importNamingProbe`（`:1055`）、`penMouseProbe`（`:751`）、`mediaSuppressProbe`（`:717`）。
→ 本轮为「素材导入两条/删了回来」「输入法重命名」「导入命名」新写的探针**全部未接线**，等于没有回归保护。

**已接线断言的可信度**（逐条核算）：

| 断言 | 结论 | 依据 |
|---|---|---|
| `opacityScaleOK`（`:961`） | ✅ 有判别力 | 其中 `1 → 0.01` 一档：引擎 clamp 只处理 `>1`，若缺 app 侧 `/100` 换算，该档必失败 |
| `layerOK`（`:983`） | ✅ 硬断言 | 实读 `__fabulaEngine.layer()`，只改 `MTG.state.layer` 必红 |
| `delShotOK`（`:1033`） | ✅ 硬断言 | armed + clip/board/磁盘三清 |
| `thirdUntouched`（`:620`） | ✅ 有效（条件性） | 仅当探针自造片段时断言；若冒烟工程已有 ≥2 片段则为 `undefined` |
| **`playheadFrozen`（`:1008`）** | ❌ **空断言** | 测量时 `p.clips` 只有 1 个片段，`→` 本来就是"最后一镜"、播放头天然不变 → 恒真。**S-3 的方向键那半边实际未被验证** |
| **`snapFreeOK`（`:637`）** | ❌ **假绿** | `pxPerSec=60` → 容差 0.1333s；探针 4 步 × 0.1s。旧 buggy 逻辑推演：步1 距自身 0.1 < 0.1333 吸回 3.0 → 步2 到 3.2 不吸 → 步3 距 3.2 为 0.1 吸回 → 步4 到 3.4 不吸 → **终值同为 3.4**。该断言无法区分 H-6 修没修 |
| `renderConcurrentOK`（`:1042`） | ⚠️ 条件性 | 依赖工程内存在可读缩略图才会产生 await 交错窗口 |
| `radialProbe.panOK` | ⚠️ 弱断言 | 只验"视图没动"，探针若失效仍通过 |
| 覆盖缺口 | — | H-1/H-2/S-5/H-9/H-12/H-13/M-14/M-15 与全部低项**零覆盖**；素材库"筛选后删除""删除后孤儿引用"全链路无覆盖 |

**测试套件**：静态计数 27 个非探针用例（与 R4 一致，未退步）；`test/main-ipc.test.mjs` 已自动覆盖本轮新增的 `trashFile`/`assets:remove` 两个通道（handler ≥16 断言）。

---

## 五、修复优先级建议

**第一批：本轮唯一的"卡死级"+ 内容安全（都是十几行的改动）**
1. **R5-2 `TL.dragging` 兜底**（超时 + window 级 pointerup/pointercancel + render 前收尾）——不修则"拖拽中碰到任意外部改动"就会让外部同步永久空转。
2. **R5-1 轮盘并入模态守卫**（把白名单下沉到动作分发层）——唯一能把"写错帧"从侧门放回来的路径。
3. **R5-6 `penToMouse` 重放 `pointercancel`** + **R5-5 片段拖拽取消即回滚**——笔用户的两条卡死/误提交入口。
4. **R5-3 滚轮纵滚交回原生**——一行 `if`，但每天每次滚动都会遇到。

**第二批：把"修了一半"补齐**
5. **R5-7 H-10 目标 id 改 `engine().id`**（含 `stepBrush`）。
6. **R5-9 M-5 统一取镜实现 + `openPaint` 校验 `currentBoardId`**（内容安全）。
7. **R5-4 montage 分支消费 `info.files`**（音频永久陈旧）。
8. **H-1 残留：`settings` 恢复默认派发 listeners** + **R5-8 listener 加按键过滤**。
9. **S-7 旁路：`cmd.del` 改走 `delShot()`**；**M-14 素材删除加确认**。
10. **S-3 残留**：放行空格平移、补 Esc 关弹窗/详情窗（R5-17）。

**第三批：验证网（否则同类问题第四次复发）**
11. 修 `playheadFrozen`（先造第二个镜头再断言）与 `snapFreeOK`（步长 > tol/2 且断言终值偏离自身位置，或直接断言候选集不含自身）。
12. 把 `assetLifecycleProbe`/`groupRenameProbe`/`importNamingProbe`/`penMouseProbe` 接进 `probes.test.mjs`。
13. `probes.test.mjs:14` 的 `canRun` 改为"能产出含 `[smoke-eval]` 的日志才跑，否则 skip"（无头环境当前是硬红而非跳过）。
14. 给 H-13/R5-2、H-9、S-5 补探针——这三处是"必须运行时验证"的修复。

**第四批：清理与对齐**
15. M-1 `#timecode`、M-6/M-7 拾色器输入、M-10 缩放 clamp 收口、M-11 视图语义分派、M-13 分割条持久化。
16. 低项一次性清：`remark`/`notes` 字段统一（R5-13）、导出读 `S.showText/S.size`（R5-10）、标签菜单滚动跟随（R5-12）、`.panning` 死 CSS、`fill` 工具入口或明确砍掉、`#b-size` 上下限对齐、`#tl-info` 去 10s 余量与 `0:60`。

---

## 附录：本轮审计的执行口径（如实记录）

- **测试套件实跑**：`node --test "test/*.test.mjs"` → **30 用例 / 27 通过 / 3 失败**。3 条失败均为探针用例。
- **失败根因（已定位到环境，非项目缺陷）**：沙箱设了 `ELECTRON_RUN_AS_NODE=1`。
  - 不 unset 时 Electron 以 Node 模式启动 → `require('electron')` 返回路径字符串 → `app` 为 undefined → 在 `main/main.js:19` 抛 `Cannot read properties of undefined (reading 'on')`，进程退出码 0 但**无任何输出**（日志镜像装在更后面的位置），故 `smoke.log`/stdout/stderr 三源皆空。
  - unset 后 Electron 真启动（1.58s），但 GUI 无法在本沙箱初始化，退出码 `2147483651`（0x80000003）。
- 因此在本次审计环境中**无法实测 Electron 内的任何交互**；本报告除"测试套件结果"外全部为**代码级静态验证**（各条已标注证据）。**建议本地跑一次 `npm test` 确认 3 个探针用例在你机器上是绿的**——若也是红的，那说明探针断言本身有问题（见第四节）。
- 附带一个可改进点：`main.js` 的 `console` 镜像安装在 `main.js:19` 之后，一旦启动早期抛错，`smoke.log` 会**完全空白**，把故障变成不可诊断（本轮就踩到了）。建议把日志镜像提到文件顶部、或独立于 SMOKE 开关落盘启动异常。

---

*第五轮审计：4 路交互专项子代理 + 人工复核（H-10/R5-7 的 id 链路、`TL.dragging` 复位路径、`snapFreeOK` 算术、H-3 滚轮分支）+ 测试套件实跑与根因定位。全程只读，未修改项目任何文件。*
