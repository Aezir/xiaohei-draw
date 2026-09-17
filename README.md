# 小黑生图 (XBDraw)

**Based on LittleWhiteBox by biex** — https://github.com/RT15548/LittleWhiteBox (Apache 2.0 + 署名要求，见 `docs/LICENSE.md`)

从小白X 3.1.1（commit `960b323`，2026-09-10）里拆出的 AI 画图功能，做成独立的 SillyTavern 前端扩展，之后按自己的需要改造。
现在只保留 NovelAI 后端（SD WebUI、ComfyUI、后台任务与断线接回已删除），另加了氛围迁移、Anlas 计价、内置画廊（对接 nai-gallery）等功能，详见下方改动记录。

## 安装

**推荐：用链接安装**。酒馆 → 扩展 → 「Install extension」，粘贴：

```
https://github.com/Aezir/xiaohei-draw
```

装好后刷新页面。以后在扩展管理里点更新即可拉到新版本。

手动安装：把整个仓库文件夹放进酒馆的第三方扩展目录（任选其一），刷新页面：

- `SillyTavern/public/scripts/extensions/third-party/xiaohei-draw`
- `SillyTavern/data/<用户名>/extensions/xiaohei-draw`

文件夹叫什么都行，插件自己会识别所在目录。

**别和小白X 的画图同时开**（见下文）。

扩展设置里出现「小黑生图」抽屉 → 选画图后端 → 点「画图设置」。

可选：「API 配置 → 发送方式：后端发送」和氛围编码的兜底通道需要服务端插件，把 `server-plugin/xbdraw-image-proxy` 拷到 `SillyTavern/plugins/` 并在 `config.yaml` 开 `enableServerPlugins: true`。插件 id 已改成 `xbdraw-image-proxy`，和小白X 的插件互不影响。默认「前端直连」不需要插件。

## 和小白X 的区别（改了什么）

| 项 | 小白X | 小黑生图 |
|---|---|---|
| 扩展设置键 `extension_settings[...]` | `LittleWhiteBox` | `XBDraw` |
| 服务端配置文件 | `LittleWhiteBox_NovelDraw.json` 等 | `XBDraw_NovelDraw.json` 等（**画图预设和 LLM 配置要重新填**） |
| 全局对象 | `window.xiaobaixDraw / xiaobaixNovelDraw / ...` | `window.xbdrawDraw / xbdrawNovelDraw / ...` |
| 发送前拦截器 | `xiaobaixGenerateInterceptor` | `xbdrawGenerateInterceptor` |
| 设置页 iframe 通信标识、DOM id | `LittleWhiteBox-NovelDraw`、`xiaobaix-*` | `XBDraw-NovelDraw`、`xbdraw-*` |
| 入口 | 20+ 个功能的总入口 | 只启动画图的 `index.js` |

**故意没改**（保证旧聊天里的图还能显示）：聊天记录里的 `xiaobaixDrawSaved` 键、`[image:id]` 占位符、IndexedDB 库名 `xb_*`。
所以**别和小白X 的画图同时开**：两边会抢着处理同一批占位符。用小黑生图时，把小白X 的画图后端设为「关闭」。

**删掉的一处**：NovelAI 出图后原本会调小白X 的「HTML 代码块渲染器」重绘这层楼，那是小白X 另一个功能，已移除（`novel-draw.js` 的最终 DOM 同步处）。

## 自己的改动记录（重跑拆分脚本前先看这里）

- 2026-09-15 设置页新增「日志」标签页（左栏 + 手机底栏，`#view-log`）：
  - 一次配图（楼层配图 `generateAndInsertImages`、文本配图 `generateImagesFromText`）记一条，最多 50 条，存本机 IndexedDB 库 `xb_draw_logs`，不写酒馆设置文件。两个函数改成「开日志 → 调原来的 `run…` → 记结果」的外壳，原逻辑搬进 `runGenerateAndInsertImages` / `runGenerateImagesFromText`，只多收一个 `drawLog` 参数。
  - 记三块：场景 Agent 每一轮（分析 / 纠错）的实际请求 messages、模型原始回复、没过校验的错误码 / 路径 / 说明、耗时（`onDiagnosticUpdate` 折进日志；`draw-agent-runtime.js` 的 attempts 每轮多存一份 `modelOutput`，通过校验的那轮也能看到回复）；NAI 每张图实际 payload 里的正负向、角色提示词和坐标、模型、尺寸、步数、CFG、采样器、种子、氛围图数量和成败（`runNovelImageBatch` 多收 `drawLog`）；楼层渲染（`message-rerender.js` 加可选 `onRenderReport`，`draw-common.js` 补上 MVU 忙不忙、有没有 `<StatusPlaceHolderImpl/>`、半秒后状态栏是 iframe 还是代码，自愈补发与补发后是否恢复；给了回调时最后一次补发后会多查一次，只报告不补发）。
  - 新文件：`shared/draw-log.js`（纯函数：打码、base64 省略、裁剪、折叠诊断、NAI 摘要、渲染报告、复制文本）、`shared/draw-log-store.js`（IndexedDB + 内存，所有入口吞错，日志坏了不影响生图 / 渲染）、`providers/novelai/ui/draw-log-view.js`（页面，样式由脚本注入；提示词用 nai-prompt-highlight 上色，长文本默认折叠）。宿主消息 `GET_DRAW_LOGS` / `CLEAR_DRAW_LOGS` → `DRAW_LOGS_DATA`，日志变化推 `DRAW_LOGS_CHANGED`。
  - 打码：字段名（authorization / api_key / token / password …）+ 正则兜底（Bearer、pst-、sk-、AIza、GitHub 令牌、JWT、URL 里的 key=）。图片 base64 / 氛围 token 不存，只存数量。
  - 测试：新增 `tests/novelai/draw-log.test.mjs`；`message-rerender.test.mjs` 加 onRenderReport 用例。

- 2026-09-14 图片管理页拆成「文生图 / 画廊」两块，完整画廊直接嵌在页面里：
  - `novel-draw.html` 的 `#view-gallery`：上「文生图」（缓存统计条、`#nd_gallery_container`、空状态，原样搬进 `section`），下「画廊」（`#nd-gallery-web-slot`）。删了 `#nd-gallery-link-slot`（精简画廊浏览网格）；它的 `/* nd-gallery-link */` 样式段没删（连接块还在用 `nd-gl-*`，浏览网格那几条成了闲置样式）。
  - `ui/gallery-web-launcher.js` 改成常驻 iframe（不再弹全屏浮层）：第一次切到图片管理页才加载 `gallery-web/index.html?embed=xiaohei`，高度 = 设置页滚动区可视高度（最少 420px），手机同样。没连画廊同步仓库时上方一条提示（本机画廊有图时说明这里看不到、去 API 配置连接后合并）。
  - `ui/gallery-browser.js` 只留：API 配置的画廊连接块（`#nd-gallery-auth-slot`，连接 / 断开 / 合并本机画廊）、预设栏「从画廊导入」（现在跳到图片管理页的画廊并提示点「加入绘图参数预设」）、导入为参数预设的完整流程（起名 → 同来源查重 → 同名查重 → `IMPORT_GALLERY_PRESET`，宿主回执照旧），对外 `window.NDGallery.importRecord(record, {vars, varIndex})`。状态提示改发 `nd:gallery-import-status` 事件，由画廊区域显示并转成画廊里的 toast。浏览网格、详情、「存为角色标签」按钮删掉（宿主的 `SAVE_GALLERY_CHARACTER_TAG` 没动，暂时没有入口）；`gallery-sync/thumb-queue.js` 不再被页面用到，文件和测试保留。
  - 新文件 `shared/gallery-sync/embed-bridge.js`：设置页 ↔ 嵌入画廊的消息约定（`hello` → `link {repo,tok,key}|null`；`import-preset {record, vars, varIndex}`；`toast`；`resync`）。只认同源 + 来自那个 iframe 的消息，发送 targetOrigin 写死本源，导入请求只挑 record/vars/varIndex。
  - 登录打通：插件连着仓库时，嵌入的画廊启动就拿到插件那份 `{repo,tok,key}`，只放内存（`SYC.host`），不写画廊自己的 `nai.sync`，画廊设置里显示「用的是小黑生图里连好的仓库」并藏掉「断开」。插件连接 / 断开后自动重新加载 iframe；插件往仓库批量存图 / 合并本机画廊后通知画廊同步一次。
  - 画廊网站（nai-gallery 源文件）加嵌入模式：`?embed=xiaohei` 且在 iframe 里才生效，`data-theme="xiaohei"`（#191919 / #2a2a2a / #2e2e2e + 粉色 #e889b0，所有边框透明，选中改粉色底），藏主题切换和「NAI 额度」，详情里加「加入绘图参数预设」。平常直接打开不变。
  - `tools/sync-gallery-web.mjs` 加 `--worktree`（拷 nai-gallery 没提交的工作区文件，`VENDOR.json` 记 `ref: WORKTREE`，检查和漂移测试跟着和工作区比）。这次 gallery-web 就是这样拷的；nai-gallery 提交以后不带参数再跑一次。
  - 测试：新增 `tests/gallery/gallery-embed.test.mjs`（消息校验、导入请求清洗、只回三个凭据字段、画廊页嵌入模式只在 xiaohei 下生效、内联脚本能解析、插件凭据不落 `nai.sync`）；`gallery-web-drift.test.mjs` 加嵌入地址。

- 2026-09-13 聊天图片长按面板 + 卡面去角标去底框 + 灯箱缩放（前端；改前备份 `docs/plans/backup/pre-cardmenu/`）：
  - 共享操作注册表 + 面板组件新文件 `shared/image-action-menu.js`：`registerImageAction({id, icon, label, when(ctx), run(ctx), order, surfaces})`，`surfaces` 取 `'chat'`（聊天图片长按）/ `'lightbox'`（灯箱长按），缺省两处都有；`listImageActions(ctx, surface)`；`createImageActionMenu`（Notion 暗色 #252525、粉色强调、Remix 图标、零边线，出视口翻转，触屏项高 44px）；`openChatImageMenu(x, y, ctx)` 整页一个，外面按下 / 滚动 / Esc / 宽度变化自动关，关面板的那次按下落在图片上不会顺带开灯箱。`image-lightbox.js` 的 `registerLightboxAction` 保留为兼容包装（不写 surfaces 时只进灯箱），`listLightboxActions(ctx)` = lightbox 处的项。
  - 聊天图片长按（触摸）/ 右键（鼠标）在按压位置弹面板，恰好两项：「下载」（原图，同原来的长按下载）、「同步到 Gallery」（原「存入画廊」，逻辑不变：连了仓库存远端、没连存本机，批次 = 角色名，webp，用参数快照）。长按后不再触发单击 / 双击；`bindGestures` 拦 contextmenu（有面板时也不冒泡给酒馆）和 selectstart。`attachChatImageCardGestures` 新增 `actions.menu(card, {x, y})`，没传才退回直接下载。宿主 `novel-draw.js` 的 `openCardActionMenu` 取预览记录后开面板。
  - 灯箱面板：保存到服务器（只对未保存预览）+ 下载（原「下载原图」）+ 同步到 Gallery；`gallery-actions.js` 注册时带 `surfaces: ['chat', 'lightbox']`，label 常量 `GALLERY_SAVE_LABEL`。
  - 卡面：删常驻版本角标 `.xb-nd-ver`；切换版本时（滑动、灯箱里设为显示）由 `flashImageCardPosition` 在图片底部短暂显示「2 / 3」半透明小胶囊，约 1.2 秒淡出并移除，只有一张不显示。等待占位卡保留「等待生成 · 1 / 2」（图到了就消失）。
  - 亮色酒馆主题下的「暗框」：真实图片卡去掉 `padding: 4px` 和 #2a2a2a 底色，只剩圆角图片；占位卡改中性半透明底 `rgba(128,128,128,0.14)`，文字跟随 `--SmartThemeBodyColor`，按钮半透明底，亮暗主题都能看。
  - 灯箱缩放：双指捏合 + 双指平移；滚轮 / 触控板捏合以光标为锚缩放；放大后拖动平移（不越出适应大小时的框）；双击 / 双指点在适应和 2 倍之间切换；范围 1–6 倍。放大时横滑是平移，只在适应大小时切版本；长按面板任何缩放都能用；切版本、重新打开回到适应。灯箱 `touch-action: none` + 拦 wheel / gesturestart / touchmove / dblclick，页面本身不缩放。纯函数 `clampZoomScale` / `clampZoomPan` / `zoomAtPoint`，控制器 `lightbox.zoom`。
  - 测试：`tests/novelai/chat-image-ui.test.mjs`（卡面无角标、无底框、共享注册表 surfaces、面板贴位、缩放数学）、`tests/gallery/gallery-actions.test.mjs`（新 label + surfaces）；harness `docs/plans/harness/chat-image-harness.html` 新增聊天面板、角标、卡面底色（含亮色主题）、灯箱缩放 / 平移 / 捏合用例。
  - 导入参数预设前先起名（新文件 `shared/preset-naming.js`，纯函数 + 注入对话框）：页内输入框预填默认名并全选，Enter 确认、Esc 取消（取消 = 什么都不导入），去首尾空白、空名字就地提示不关框；和已有预设同名（忽略大小写和多余空白）时问「返回修改 / 自动改名（名称 (2)）/ 覆盖」，Esc = 返回修改。画廊来源查重（覆盖 / 另存 / 取消）照旧先问；同来源已选覆盖时，同名只给「自动改名 / 返回修改」，免得一次动两个预设。
    - 画廊「导入为参数预设」（`ui/gallery-browser.js`）：名字输入框直接放进原来的导入弹框，默认名 = 批次（角色名）或前 3 个 tag + 短 id。消息 `IMPORT_GALLERY_PRESET` 新增 `name`、`onNameConflict: 'overwrite'|'rename'`；宿主 `gallery-preset-import.js` 按 `name` 存，同名没给决定时回新消息 `GALLERY_PRESET_NAME_CONFLICT`（iframe 列表过期时由宿主查出），iframe 再问一次后重发。同名覆盖 = 替换那个预设并保留它的 id 和氛围。不带 `name` 的旧消息行为不变。
    - 云端预设导入（`novel-draw.js` 的 `OPEN_CLOUD_PRESETS`）：默认名 = 预设自己的名字，走 `askPresetName` + `applyNamedPresetImport`；取消时回调返回 false，`cloud-presets.js` 的按钮复原、不显示「成功」。
    - 预设栏没有「参数预设 JSON 文件导入」这条路径（`nd_prompt_preset_import` 是提示词预设），所以没改。
    - `shared/xb-dialog.js`：`openXbDialog` 的 `input.validate(value)` 返回提示文字时不关闭、在输入框下显示 `.xb-dlg-hint`，重新输入后消失；`xbPrompt` 透传 `validate / detail / icon`。输入框聚焦改为粉色底色（无描边环），选中文字粉色底。
    - 测试：`tests/gallery/preset-naming.test.mjs`（名称校验、自动改名、同名三选一、取消、落列表、画廊默认名、对话框适配）、`tests/gallery/preset-import-host.test.mjs`（消息带名字、name-conflict / rename / overwrite、来源查重优先）；`gallery-harness.html` 新增起名框（预填全选、空名提示、Esc 取消、Enter 确认）、宿主同名三选一、返回修改保留输入、validate 用例。
  - 图片管理（`providers/novelai/novel-draw.html`）里用户能看到的「保存到服务器」改成「保存到本地」：弹窗按钮 `#nd_modal_save`、保存后复原的按钮文字、「清空全部图片记录」确认里的说明。行为不变（仍存进酒馆的用户图片目录）。灯箱长按面板的「保存到服务器」是另一处独立字符串（`shared/image-action-menu.js`），没有共用，保持原样。

- 2026-09-13 悬浮球尺寸覆盖在设置页说真话（改前备份 `docs/plans/backup/pre-sizefix/`）：
  - 新增纯函数 `providers/novelai/novel-effective-size.js`（覆盖白名单解析、实际尺寸、提示条文案），`compiler.js` 的 `applySizeOverride` 改用它，口径唯一。
  - 设置页绘图参数「图片设置」卡片内新增 `#nd_size_override` 提示条「悬浮球尺寸覆盖中：W × H」+「取消覆盖」；预设宽高照常可改。提示条和计价由 `ui/nd-cost-bar.js` 管：收 `INIT_DATA.settings.overrideSize` 和新消息 `OVERRIDE_SIZE`；「取消覆盖」发新消息 `SAVE_OVERRIDE_SIZE`，宿主走 `updateSettingsPersistent` 保存并 `refreshPresetSelectAll()` 刷新悬浮球菜单，保存后总会回发真实值。
  - 宿主 `updateSettingsPersistent` 在任何入口（悬浮球 / 楼层菜单 / 快捷设置）改动 `overrideSize` 后都给打开着的设置页发 `OVERRIDE_SIZE`。
  - 计价按实际尺寸：底栏、生成前确认（`presetPricingConfig(preset, overrideSize)`）、编辑后重新生成确认（`presetGenerateConfirm(..., overrideSize)`）。免费绿标：覆盖时宽高框不标，标在提示条上。
  - 复位（`planFreeReset(config, view, { overrideSize })`）的决定：覆盖尺寸免费就保留覆盖、不动表单宽高；覆盖尺寸不免费就直接取消覆盖（全局快捷设置，立即保存），再按表单宽高判断要不要改。目前白名单尺寸都 ≤ 1024²，这条分支只在测试里用 `{width,height}` 覆盖触发。
  - 测试 `tests/novelai/effective-size.test.mjs`。
  - 清理：SD/ComfyUI 已删，`shared/agent-settings-surface.css`、`agent-core/ui/settings-surface.css` 去掉全部 `border: 1px solid`、`border-color`、focus 描边环 `box-shadow`，改成底色（原生按钮 / 输入框留 `border: 0` 清浏览器默认）；`novel-draw.html` 场景 Agent 覆盖块里非控件元素的多余 `border: 0` 删掉（页面全局零边线兜底仍在，表现不变）。

- 2026-09-13 NovelAI 设置页导航重排（`providers/novelai/novel-draw.html` 侧栏 + 手机底栏）：绘图参数、角色标签 | 提示词模板、场景 Agent、世界书 | 图片管理 | API 配置、快速测试；默认打开页从「快速测试」改为「绘图参数」。SD WebUI、ComfyUI 未改。
- 2026-09-13 NovelAI 设置页换成 Notion 暗色紧凑主题：整块替换 `novel-draw.html` 的 `<style>`；零边框/描边/分割线，层级只靠底色（页面 #191919 < 卡片 #202020 < 块/按钮 #2a2a2a < 输入框 #2e2e2e）；间距字号降一档。场景 Agent 的共用样式在本页内覆盖，没改 `shared/agent-settings-surface.css`。`novel-draw.js` 里设置页外框底色同步改成 #191919。聊天消息里的图片样式未改。
- 2026-09-13 设置页 F1-F3（`novel-draw.html`，改前备份 `docs/plans/backup/novel-draw.pre-F1.html`）：
  - F1 外壳：Remix Icon 4.6.0 本地化到 `assets/remixicon/`（css + woff2 + woff + LICENSE；css 的 @font-face 只留 woff2/woff），删 Font Awesome 和全部 emoji。侧栏去分组间隔，7 项顺序：绘图参数、角色标签、提示词模板、世界书、图片管理、API 配置、快速测试。场景 Agent（`#nd-agent-settings-surface`，id 不变）并入 API 配置底部，删 `#view-llm`，切到 API 页时发 `ENSURE_AGENT_SETTINGS`。删「后台任务」开关及其 JS（`useImageBackendJobs` 不再随 `SAVE_API_CONFIG` 发送）；插件安装指南改为 `xbdraw-image-proxy`；新增手动档位下拉 `#nd_sub_tier`（暂只是控件，不保存）；预留 `#nd-gallery-auth-slot`、`#nd-gallery-link-slot`、`#nd-preset-import-slot`、`#nd-float-fields`、`#nd-cost-bar`。其余页改紧凑网格。底栏抖动修复：body 不滚，`.app-main` 唯一滚动 + `scrollbar-gutter:stable`，底栏进 flex 流，切页滚回顶部。
  - F2 绘图参数仿 NovelAI：预设栏在顶；左栏 模型、正/负向固定（质量标签、UC 预设放进框底）、参考图 `#nd-vibe-slot`；右栏 图片设置（宽×高常显 + 交换 + 竖/横/方）、AI 设置、高级设置（含数量限制），滑条与数字框双向同步；吸底 `#nd-cost-bar` 占位。id 全部保留；JS 只加了 UC 预设分组显隐、`syncNaiControls`/`initNaiControls`。没有「角色提示词」「图片张数」对应字段，未做。
  - F3 自绘下拉 `providers/novelai/ui/nd-select.js`：原生 select 隐藏保留为数据源，自动接管后插入的 select；手机为底部面板。
- 2026-09-13 P0 删减 + V1 氛围底层 + VP 计价模块（Vibe agent；回滚基线见 `docs/plans/execution-plan.md` §5）：
  - P0 删除后台任务（Draw Run、image-job 恢复/接回、pending/recoverable 记录、page-farewell、backend-image-jobs、novel-backend-job-result）和 SD WebUI、ComfyUI 两个 Provider（整个目录）。`index.js` 只剩「关闭 / NovelAI」，旧存档里的另外两个值自动改成关闭并保存；`settings.html` 删两个 option。`novel-draw.js` 的 transport 只看 `sendMode`；`floating-panel.js`、`draw-common.js` 去掉对应 import 和分支（`refreshDrawRunUiState` 改名 `refreshGenerationUiState`）。
  - 服务端插件改名 `server-plugin/xbdraw-image-proxy` 3.0.0：只留 `/status`、`/v1|v2/generate-image`、`/v1/generate-image-stream`、`/v1|v2/test`，新增 `/v1/encode-vibe`、`/v1/subscription`；capabilities 为 `v5-msgpack-stream`、`novelai-encode-vibe-v1`、`novelai-subscription-v1`。前端插件路径常量集中在 `novel-request-config.js` 的 `NAI_BACKEND_BASE`，最低版本 3.0.0。插件测试不再依赖 `@msgpack/msgpack`（`tests/helpers/msgpack-encode.js`）。
  - V1 氛围底层（还没接到生成流程和界面，V2/V3 接）：`novel-vibe-config.js`（预设 `vibes` 规范化，已接进 `normalizeParamsPreset`）、`novel-vibe-format.js`（.naiv4vibe）、`novel-vibe-store.js`（IndexedDB `xb_novelai_vibes`）、`novel-vibe-api.js`（`encodeVibeRaw` 直连，网络/CORS 失败且插件有能力时改走插件，不重试）、`novel-vibe-resolve.js`（autoEncode 默认关，编码失败整批中止）。`compiler.js` 仍同步：只有 V4/V4.5 写 `reference_image_multiple` + `reference_strength_multiple`，V3/V5 不写；是否附带 IE 数组由常量 `NOVEL_VIBE_SEND_INFORMATION_EXTRACTED`（默认 false）控制。
  - VP 计价：`novel-anlas-pricing.js`（`estimateAnlasCost`、`toFreeConfig`、`isFreeOption`，纯函数）、`novel-subscription.js`（直连 → 插件 → 手动档位；只有函数，还没调用）。档位未知、手动档位、V5 额度未知时一律 approx 且不判免费。
  - 测试：`node --test "tests/novelai/*.test.mjs"`（前端纯函数，fetch 全部 mock）；插件 `node --test "tests/*.test.js"`。全程没有访问 NovelAI。
- 2026-09-13 设置页布局修正（前端；改前备份 `docs/plans/backup/pre-layoutfix/`）：
  - 自绘下拉 `ui/nd-select.js` 去掉手机底部面板和遮罩，所有屏宽都贴在触发器正下方（间距 4px），下方放不下整张列表且上方更宽时才翻到上方；宽度不小于触发器、不出视口，列表过长内部滚动；触屏选项高 40px，触屏不自动聚焦过滤框；视口变化时重新贴位不关闭。
  - 绘图参数：「质量增强 / 质量标签（V5）+ Transparent BG」挪到「正向固定」标题行右侧，「负面预设 / UC 预设（V5）」挪到「负向固定」标题行右侧；控件宽度随内容、最宽 132px、文字省略；id、V5 显隐逻辑、change 处理都没变。
- 2026-09-13 F4 聊天图片手势 + 灯箱长按面板 + 悬浮球选字段（前端；改前备份 `docs/plans/backup/pre-F4/`、`pre-hostselect/`）：
  - 聊天图片卡统一由新文件 `shared/chat-image-card.js` 渲染（删掉 `novel-draw.js` 和 `draw-common.js` 各自那份）；数据格式不变，`xiaobaixDrawSaved`、`[image:id]`、IndexedDB `xb_novel_draw_previews` 的老图照常显示。真实图片卡没有按钮（去掉 nav-pill、⋮菜单、删除），只留一个「第几版 / 共几版」角标；预览态用底色区分。失败/等待占位卡保留「重新生成 / 编辑提示词 / 移除」，换 Remix 图标。零边线零阴影。
  - 手势 `shared/chat-image-gestures.js`（Pointer Events，鼠标拖动也算滑动）：右往左滑看更新的一张、已是最新则重新生成该槽位；左往右滑看更旧的一张；单击开灯箱；双击编辑提示词（面板重新设计）；长按直接下载原图（优先缓存 base64，没有才用 savedUrl）；竖滑/斜滑放行给聊天滚动。阈值：移动 >10px 才判方向，|dx|>1.5|dy| 算横滑；横滑成立要 |dx|>50，或 |dx|>30 且 <300ms；按住 550ms 不动算长按；单击延迟 300ms，其间相距 <30px 的第二击算双击。卡片、图片容器、图片都带 `data-swipe-ignore="true"`，挡住酒馆的消息滑动。
  - 灯箱改到新文件 `shared/image-lightbox.js`（`gallery-cache.js` 只注入保存/设为显示/下载）：删缩略条、删除按钮和 emoji；左右滑、左右键切版本；长按或右键图片在按压位置弹出操作面板（出屏自动翻转），内置「保存到服务器」（只对未保存预览）和「下载原图」；扩展点 `registerLightboxAction({id, icon, label, when(ctx), run(ctx), order})`，ctx 为 `{slotId, messageId, preview, index, total, lightbox}`，从 `gallery-cache.js` 也能 import。生成后仍不自动保存。
  - `shared/remixicon-loader.js` 往酒馆主页面注入一次本地 Remix Icon；聊天卡、灯箱、悬浮球、云端预设弹窗、`chat-message-images.js` 的 `[img:…]` 卡全部换 Remix 图标并去边线。
  - 悬浮球 / 楼层按钮：`floating-panel.js` 重写样式（Notion 暗色零边线，CSS 拆到 `ui/floating-panel-styles.js`），emoji 状态图标全换 `ri-*`。菜单行由 `providers/novelai/float-fields.js` 生成。新设置 `floatFields`（数组，可选 preset/size/model/sampler/steps/scale/seed，缺省 `['preset','size']`），存 `XBDraw_NovelDraw.json`（`draw-settings.js` 白名单已加）；设置页 `#nd-float-fields` 勾选后发 `SAVE_FLOAT_FIELDS`，宿主保存后 `rebuildMenus()` 实时生效。预设/尺寸改全局快捷设置，其余字段改当前参数预设。
  - 主页面也不用原生下拉：`shared/host-select.js` 把 `nd-select.js` 加载进酒馆主页面，只接管 XBDraw 容器（`.xbdraw-settings, .nd-float, .xb-nd-img, #nd-gallery-overlay, .cloud-presets-overlay, [data-xbdraw-ui]`）；`index.js` 在抽屉插入后调用一次。原生 select 仍是数据源，jQuery change 照常触发。
  - 验证：`node --test "tests/novelai/*.test.mjs"`（新增 `float-fields.test.mjs`、`chat-image-ui.test.mjs`）；harness `docs/plans/harness/chat-image-harness.html`（假数据 + stub，不发网络请求）。
- 2026-09-13 快速测试并入绘图参数 + 删「同步总结的过滤规则」（前端；改前备份 `docs/plans/backup/pre-job3/`）：
  - 删掉「快速测试」分页（侧栏和手机底栏，剩 6 项）。绘图参数左栏加「测试提示词」卡（Prompt 接在正向固定后，可选 Undesired Content 接在负向固定后）；吸底栏 `#nd-cost-bar` 变成仿 NAI 的生成栏：「生成」按钮（仍是 `#nd_test_single` + `TEST_SINGLE` 消息，只在点击时发送，生成中禁用）、费用位 `#nd_cost_value`（暂显示「—」，F5 接计价）、状态 `#nd_status`；结果预览 `#nd_preview` 放右栏顶部，有结果才出现。宿主 `TEST_SINGLE` 多收一个可选 `uc`，留空时请求和原来完全一样。
  - 删「同步总结的过滤规则」按钮、页面里的 `SYNC_SUMMARY_FILTER_RESULT` 处理和宿主的 `SYNC_SUMMARY_FILTER_RULES`（它读的是小白X 总结模块的配置）；过滤规则本身没动。
- 2026-09-13 改名「小黑生图」+ 删页头署名 + 原项目说明（前端；改前备份 `docs/plans/backup/pre-job4/`）：
  - 用户能看到的名字全部改成「小黑生图」：`manifest.json` display_name、抽屉标题和开关文字、`EXT_NAME`、控制台前缀、toast 标题、设置页提示、插件描述、事件调试帮助、拆分脚本的改名规则。内部标识一律没改（文件夹、`EXT_ID = "XBDraw"`、`extension_settings.XBDraw`、`XBDraw_*.json`、`xbdraw*` 全局和 DOM id、`XBDraw-NovelDraw` 消息源、插件 id `xbdraw-image-proxy`），存档不受影响。
  - 删设置页页头的作者署名（`#nd_credits`、`shuffleCredits` 及其样式）。
  - API 配置最底部加原项目说明：LittleWhiteBox（小白X）by biex 的仓库链接、Apache 2.0 + 署名要求（链到 `docs/LICENSE.md`，写明 Based on LittleWhiteBox by biex）、非官方版本声明。
- 2026-09-13 画廊对接 G0：原样拷贝 nai-gallery 同步核心 + 客户端桩 + 测试（画廊 agent；只新增文件，没改任何现有文件，没碰 nai-gallery；原记录 `docs/plans/gallery-G0-changelog.md`）：
  - 新增 `tools/sync-gallery-core.mjs`：从 nai-gallery 已提交的 `index.html` 按标记截取同步核心、PNG 元数据函数、`IMG_META/IMG_BATCH` 两个常量，原文不改，写到 `modules/draw/shared/gallery-sync/vendor/`，并在 `VENDOR.json` 记来源 commit（当前 `ed8458d`）、SCHEMA（2）和每块 sha256。`--check` 检查手改和上游格式漂移（退出码 0/2/1）。
  - 新增 `modules/draw/shared/gallery-sync/gallery-client.js`：`connect`（默认不替画廊初始化加密）、`readState`（格式太新时只读）、`listImages`（过滤 + 分页）、`loadImage` / `createThumbQueue`（按需解密取图）、`imageIdOf`（和画廊同款 id）、`addImages`（每 30 张一次，只经 `SyncCore.sync` 写入，按远端去重，墓碑需 `reAdd`）。
  - 新增 `tests/gallery/`：内存假 GitHub（`fake-github.mjs`）+ 22 条测试，`node --test "tests/gallery/*.test.mjs"`，全程不联网。
  - `docs/plans/gallery-plan.md` 更新到 v2（画廊网站与数据分离后的新格式、G1/G2 挂载点），旧版留在 `gallery-plan-v1.md`。
  - 画廊凭据只会存在酒馆页面的 IndexedDB（G1 实现），不存密码，不进 `XBDraw_NovelDraw.json`。
- 2026-09-13 V2 氛围接入生成 + V3 氛围卡 + F5 计价条（Vibe agent；改前备份 `docs/plans/backup/pre-V2/`）：
  - V2：新文件 `novelai/novel-vibe-generation.js`（`ensureNovelVibesEncoded`、`buildNovelGenerationSnapshot`，纯函数）。`novel-draw.js` 的单张（刷新、重试、快速测试、`generateNovelImage`）、文本配图、楼层批量/自动三条路径都在编译前调 `ensureGenerationVibes`，前端/后端发送都只发 token。自动编码永远关：启用的氛围在当前模型 + 信息提取下缺编码就停下并说明；编码失败整批中止；V3/V5 剥掉氛围并提示。生成成功写预览缓存时多存 `params` 快照（prompt、uc、seed、model、steps、scale、sampler、noiseSchedule、宽高、smea/dyn、cfgRescale、角色提示词、氛围摘要，不含 Key/token）；`storePreview` 加 `params` 字段，编辑 TAG 时保留。
  - 订阅档位：设置页打开、改 Key、保存 API 配置后，宿主调 `resolveNovelSubscription`（免费 GET `/user/subscription`，直连 → 插件 → 手动档位），结果只在内存，发 `SUBSCRIPTION_DATA`（来源字段叫 `subscriptionSource`，因为 `source` 被消息协议占用）。`#nd_sub_tier` 改动发 `SAVE_SUB_TIER`，存为设置 `subTier`（只作兜底；`draw-settings.js` 白名单已加）。
  - V3：新文件 `novelai/ui/novel-vibe-panel.js` 画在 `#nd-vibe-slot`：导入图片 / .naiv4vibe（可拖入）、缩略图、总开关、每个氛围的启用、强度、信息提取（数字框 + 滑条）、导出 .naiv4vibe、移除；默认最多启用 4 个；V3/V5 提示。「编码 · 2 Anlas」按钮（先确认）是唯一编码入口，发 `VIBE_ENCODE`，宿主编码后回 `VIBE_ENCODE_RESULT`。氛围图和编码直接读写同源 IndexedDB `xb_novelai_vibes`；保存预设时带 `vibes`。认不出的 .naiv4vibe 模型键只提示，不做映射下拉。
  - F5：新文件 `novelai/ui/nd-cost-bar.js`：底栏实时显示估价（免费为 0 + 绿色，档位未查到显示「约」，超限显示「参数超出上限」）、档位小字、「复位」（`toFreeConfig`，只改步数/尺寸/超出的氛围，不动提示词，不自动保存；档位没经接口确认时置灰）。免费选项加 `.nd-free`（尺寸预设、模型、采样器、调度、宽高、步数、引导、种子、重缩放、SMEA、已编码氛围徽标；步数滑条标出 ≤28 区间），只用文字色/底色。「生成」在 V5、预计收费或档位不确定时弹确认。
  - 测试：`tests/novelai/vibe-generation.test.mjs`、`cost-bar.test.mjs`（fetch 全 mock，不访问 NovelAI）。
- 2026-09-13 画廊对接 G1a：新文件打底（记住登录 / 本机画廊 / 初始化仓库 / 导入预设 / 聊天图存入 / 灯箱注册助手）（画廊 agent；只新增文件，没改任何现有文件，没碰 nai-gallery，没联网；原记录 `docs/plans/gallery-G1a-changelog.md`）：
  - 新增 `modules/draw/shared/gallery-sync/idb-kv.js`：极简 IndexedDB 键值封装 + 内存版（接口一致，测试注入）。
  - 新增 `gallery-sync/credential-store.js`：IndexedDB 库 `xb_gallery_link` 存 `{repo, tok, key}` 和连接状态（local / connected / error / disconnected）；只挑这三个字段存，传进来的密码一律丢掉；不进 `XBDraw_NovelDraw.json`；`logout` 删凭据并清空缩略图库 `xb_gallery_thumbs`；`thumbCache()` 给 `loadImage` / `createThumbQueue` 用；连接失败只记不含秘密的错误状态。
  - 新增 `gallery-sync/local-store.js`：纯本地画廊，IndexedDB 库 `xb_gallery_local`。`state` 和画廊 `state.bin` 同结构、同 id 规则，`gallery-client.listImages` 能直接列；webp 文件和「传到过哪些仓库」单独记，不写进 state 的 `blobs`。`mergeToRemote` 只走 `SyncCore.sync`（逐条合并、乐观锁、版本守卫、删除保护），远端没有文件的图随提交上传，每次 30 张；写回本机时不把远端独有记录拉进来，换仓库会重新上传。
  - 新增 `gallery-sync/repo-init.js`：仓库没有 `meta.json` 时，经确认（「将把这个仓库设为画廊加密数据仓库」）后用原样拷贝的 `SyncCore.connect` 初始化（就是画廊网站自己的初始化代码），写完按画廊格式自检（v1 / PBKDF2-SHA256 / 310000 / 16 字节盐 / 47 字节校验）。空仓库（没有提交）→ `empty`，有 state.bin 没 meta.json → `orphan`，已初始化 → 只验密码不写。
  - 新增 `gallery-sync/preset-from-gallery.js`：画廊记录 → 参数预设（对照表见 gallery-plan-v1 §4）；种子默认随机；对不上的 `nai` 字段列进 `unsupported`；V5 `tag_hint_*` / `quality_boost` / `straight_alpha` 不猜映射，原样放 `source.v5Hints`；角色提示词单独返回；`source:{kind:'nai-gallery', id, varIndex}` 查重。
  - 新增 `gallery-sync/chat-image-export.js`：聊天图 → 画廊记录 + webp 两档（420 q0.74 / 1216 q0.95，浏览器用画廊的 `toWebp`，Node 注入 codec）。参数优先级：V2 参数快照 `preview.params` → PNG 里的 NAI 元数据 → 旧预览字段；`meta.batch` = 角色卡名（群聊取说话的角色）；按画廊 id 去重，本机目标已有就不转码；目标可选本机或远端。
  - 新增 `gallery-sync/gallery-actions.js`：`registerGalleryLightboxAction(registerLightboxAction, deps)`（灯箱「存入画廊」，没连仓库存本机，删过的先确认）、`createTargetResolver`、`buildImportGalleryPresetMessage`（`IMPORT_GALLERY_PRESET` 消息）。当时只导出，没有接到任何地方（G1b / G2 接线）。
  - 新增测试 `tests/gallery/`：`fake-indexeddb.mjs`（内存 IndexedDB 垫片）+ 6 个测试文件共 29 条；画廊测试合计 51 条全过，`node --test "tests/gallery/*.test.mjs"`，全程不联网。
  - G1b / G2 要改现有文件的清单：`docs/plans/gallery-G1b-G2-edits.md`。
- 2026-09-13 画廊 G1b + G2 接线 + 页内对话框 + 改名「小黑生图」（画廊 agent；改前备份 `docs/plans/backup/pre-G1b/`；没联网、没碰 nai-gallery、没动酒馆配置）：
  - 改名：用户能看到的名字从「黑生图」改成「小黑生图」（manifest display_name、抽屉标题和开关、`EXT_NAME`、控制台/toast 前缀、设置页提示和原项目说明、插件描述、事件调试帮助、拆分脚本改名规则、README、`gallery-decisions.md` 第 6 条等 19 个文件）；内部标识不变（`XBDraw`、`xbdraw*`、`XBDraw_*.json`、`xbdraw-image-proxy`）。
  - 页内对话框 `modules/draw/shared/xb-dialog.js`：`xbConfirm / xbAlert / xbPrompt / xbChoose / openXbDialog`，全部返回 Promise，设置页 iframe 和酒馆主页面共用（加载后挂 `window.XBDialog`）。Esc 和点遮罩 = 最安全的选项，Tab 焦点困在框内，关闭后焦点回原处；Notion 暗色零边线，Remix 图标，≤480px 按钮 40px 高。替换掉全部原生 `alert / confirm / prompt`：设置页 20 处（删除/重命名预设、清空角色、导入结果、恢复默认、清空图片、删除图片……，生成确认改 async）、`nd-cost-bar.js` 生成前确认（`confirmGenerate` 变 async）、`novel-vibe-panel.js`「编码 · 2 Anlas」、`novel-draw.js` 7 处（TAG 为空、刷新/保存失败、移除占位符）、`cloud-presets.js` 导出预设的作者/简介（取消 = 不导出）、`agent-core/ui/settings-panel.js` 新建/重命名 Agent 预设。原因：部分内嵌浏览器屏蔽原生对话框，按钮会没反应。
  - G1b 新文件 `providers/novelai/ui/gallery-browser.js`（设置页 module 脚本，直接读写同源 IndexedDB，令牌/密钥不走 postMessage）：
    - `#nd-gallery-auth-slot`「画廊同步仓库」：令牌 + 加密密码 + 仓库（可空，令牌只能访问一个仓库或有 `*/nai-gallery-data` 时自动识别，认不出列出仓库名）→ 连接；记住登录（repo/tok/key 存 `xb_gallery_link`，密码不存，不进设置文件）；连接成功清空密码框；仓库没初始化时弹「将把这个仓库设为画廊加密数据仓库」确认，确认后 `initGalleryRepo`，取消不写；已连接显示仓库、「合并本机画廊（N 张）」（`mergeToRemote`，带进度）、「断开」（确认后删凭据 + 清缩略图缓存）。
    - `#nd-gallery-link-slot`「画廊」：没连仓库浏览本机画廊，连了浏览仓库；每页 24 张分页，缩略图 IntersectionObserver 懒加载（新文件 `gallery-sync/thumb-queue.js`：并发 4、同 id 一次、403/429 整队暂停 30 秒重试、翻页取消排队）；搜索、分段（全部 / 收藏 / V4.5 / V5）、批次自绘下拉；徽标「本机 / 已同步」、收藏星标、无图占位；隐私模式（默认开，正面提示词含 nsfw 模糊，点一下显示，开关存 localStorage）；格式太新提示只读；连着仓库时提示「本机画廊还有 N 张没合并」。详情：大图、提示词分支下拉（默认当前分支）、正/负提示词、参数表、角色提示词「复制 / 存为角色标签」、「导入为参数预设」。
    - 「导入为参数预设」弹框列出没导入的 NAI 参数和说明，「固定种子」默认不勾；已从同一来源导入过时问「覆盖 / 另存一份 / 取消」（Esc = 取消），然后发 `IMPORT_GALLERY_PRESET`。宿主查出重复回 `GALLERY_PRESET_DUPLICATE` 时也会问。
    - `#nd-preset-import-slot`：预设栏「从画廊导入」图标按钮 → 跳到图片管理的画廊并进入选择模式，导入成功后切回绘图参数。
    - `novel-draw.html`：加 `/* nd-gallery-link */` 样式段、加载 `xb-dialog.js` 和 `gallery-browser.js`、`ndGetState()`。
  - 宿主 `novel-draw.js`：新文件 `providers/novelai/gallery-preset-import.js`（纯函数 `applyGalleryPresetImport` / `characterTagFromGallery` / `sanitizeGallerySource`）。`normalizeParamsPreset` 保留 `source`（含 `v5Hints`）；新消息 `IMPORT_GALLERY_PRESET`（只取预设字段，夹带的其他字段丢掉；覆盖 = 同 id 并保留原氛围，另存 = 新 id；存完切到该预设并回 `GALLERY_PRESET_IMPORTED`）、`SAVE_GALLERY_CHARACTER_TAG`（名字用户填，外观 = 角色提示词，负面 = 角色 UC，按 girl/boy/woman/man 猜类型，centers 丢弃）。
  - G2：初始化时注册一次灯箱长按「存入画廊」（`registerGalleryLightboxAction`；连了仓库存远端，没连存本机画廊；批次 = 生成那条消息的角色名，只在预览属于当前聊天时取消息，否则用角色卡名；删过的图用页内对话框问要不要加回；结果走 toastr），清理时注销。图片管理每个角色栏加「存入画廊」按钮、画廊弹窗加「存入画廊」（单张）→ `GALLERY_BATCH_EXPORT` → 新文件 `gallery-sync/batch-export.js`：同批重复只算一次，本机先查重、远端先读一次仓库 state 查重（已有/删过的不转 webp），攒够 30 张提交一次，单张失败继续，远端写入出错整批停；进度和结果写到「图片管理」状态栏，完成后画廊列表自动刷新。
  - 小修：`local-store.js` / `gallery-client.js` 识别别的 realm 传来的 Uint8Array（设置页 iframe ↔ 主页面）。缩略图除了 IntersectionObserver 还有兜底：挂上 250ms 后直接加载已在视口里的卡片（有些 WebView / 后台标签页不回调）。画廊两个槽位加 `[hidden]{display:none!important}`（带 display 的类会压过 hidden 属性）。
  - 测试：新增 `tests/gallery/batch-export.test.mjs`（4）、`preset-import-host.test.mjs`（5，导入消息经结构化克隆到宿主的完整路径）、`thumb-queue.test.mjs`（4）；`node --test "tests/gallery/*.test.mjs"` 64 条、`tests/novelai` 90 条、插件 33 条全过。依赖闭包（入口 index.js + 设置页 module 脚本）107 个文件，缺失 0。
  - harness：新增 `docs/plans/harness/gallery-harness.html`（假 GitHub + 内存存储 + 假宿主，iframe 里跑真实设置页，外网请求全部拦截；`shim-node-crypto.js` 让测试用的假 GitHub 在浏览器里跑）72 项全过：本机模式批量存入与去重、自动识别连接、记住登录不含密码、远端网格/分页/懒加载/筛选/搜索/隐私、详情、导入/覆盖/另存/Esc 取消/宿主查重、存为角色标签、对话框（聚焦、Tab 困住、Esc、遮罩、回车）、合并本机画廊、连上后批量存入去重、断开清缓存、未初始化仓库确认初始化（Esc 不写）、预设栏选择模式、375px 不溢出、边线审计 0、可见原生 select 0、原生对话框调用 0。`chat-image-harness.html` 加灯箱「存入画廊」检查，49 项全过。harness 要用独立端口的静态服务打开（别在酒馆 8000 端口开，避免碰到真实 IndexedDB）。
- 2026-09-13 下一轮前端 1-3：编辑提示词窗口 + 统一 NAI 语法高亮 + 场景 Agent 报错指引（前端；任务单 `docs/plans/next-round-frontend.md`；改前备份 `docs/plans/backup/pre-next-round/`；中途会话崩溃过一次，续做前逐个和备份比对过）：
  - 语法高亮：`tools/sync-gallery-core.mjs` 新增 `prompt-highlight` 块，从 nai-gallery `index.html` 原样截取分词/上色函数（`hlPrompt` 等，第 1926-2040 行）到 `shared/gallery-sync/vendor/prompt-highlight.js`，`VENDOR.json` 记 sha256，漂移检查覆盖它。新文件 `shared/nai-prompt-highlight.js` 只做 DOM 接线：textarea 包一层 `.xbhl-wrap`，文字透明只留光标，上面盖同字体/同内边距/同换行的 `<pre>`（不接收点击），滚动同步、ResizeObserver 跟尺寸、滚动条宽度补到右内边距；程序赋值（含 jQuery `.val()`）自动重画；配色只改颜色和背景（Notion 暗色，避开主题色），未配对括号红色波浪线、可疑写法黄色波浪线。接入：设置页 `#nd_positive`、`#nd_negative`、`#nd_test_tags`、`#nd_test_uc`、角色标签的外貌/负向/服装/动态外貌 TAG（MutationObserver 接管动态渲染的表单），聊天图片编辑窗口的场景和角色框。提示词模板（给场景 Agent 的 markdown）不接。
  - 编辑提示词窗口（`shared/chat-image-card.js`）：样式对齐设置页（卡片 #202020、输入框 #2e2e2e、设置页字体和字号、主按钮实心主题色），真实图片卡和失败占位卡同一个窗口，按钮统一为「保存并重新生成」。流程在新文件 `providers/novelai/novel-edit-regenerate.js`（校验 → 保存 → 花费规则 → 生成一次，连点忽略）；`novel-draw.js`：真实卡走 `saveEditedTags` + `refreshSingleImage`（新图成为最新版本），失败卡走 `retryFailedImage`。花费规则抽成 `novel-cost-rule.js`（`nd-cost-bar.js` 原样转出旧导出），宿主用 `presetGenerateConfirm(当前参数预设, 内存里已查到的档位)`：估算不为 0、档位未知、参数超限或 V5 时用页内对话框确认；取消 = 提示词已保存但不生成。滑动重新生成没改。
  - 场景 Agent：`draw-agent-runtime.js` 的 `describeProviderErrorHint`：provider 为 `openai-responses`、状态码 404/405/500/501（读 status 或信息里的数字）且信息含 not implemented / not found / unsupported 时，在「Provider 请求失败：…」后追加改用「OpenAI 兼容」的中文指引。
  - 测试：新增 `tests/novelai/prompt-highlight.test.mjs`（往返校验：两套默认预设正/负、测试提示词默认值、`docs/plans/test-prompts/lin-feikai.md` 两段、13 条边界用例；与 vendor `hlPrompt` 输出一致；样式不改字宽）、`edit-regenerate.test.mjs`、`agent-error-hint.test.mjs`，`chat-image-ui.test.mjs` 加按钮文字检查。`chat-image-harness.html` 加 7 项：叠层对齐（位置/字体/内边距/滚动高度）、上色、连点只保存一次生成一次、档位未知弹页内确认、Esc 只保存不生成。
- 2026-09-13 主题色换成粉色（前端；改前备份 `docs/plans/backup/pre-pink/`）：金色 `#d4a574 / #e0b588 / rgba(212,165,116,…)` 全部换成粉色。唯一来源新文件 `shared/xb-theme.js`（`XB_ACCENT #e889b0`、`XB_ACCENT_HOVER #f0a3c3`、`xbAccentSoft(alpha)`、`XB_ON_ACCENT #1a1a1a`），JS 注入样式的文件都从这里取：`xb-dialog.js`、`chat-image-card.js`、`host-select.js`、`image-lightbox.js`、`cloud-presets.js`、`gallery-cache.js` 和 `novel-draw.js` 的 info toast（粉底配深色字）。设置页 `novel-draw.html` 用同值变量 `--accent / --accent-hover / --accent-soft`（0.16）和新增 `--accent-soft-strong`（0.26），云端预设按钮的行内金色改成 `var(--accent)`。悬浮球「生成中」胶囊底色从暖金暗色 #2c2720 换成粉调暗色 #2e2228。对比度：粉字在 #202020 上 6.7，#1a1a1a 字在粉底上 7.2，粉字在淡粉底上 5.0；免费绿 #4dab6f 不变。背景层级色、警告黄、成功绿、高亮配色没动；扩展抽屉（`style.css` / `settings.html`）本来就没有主题色。
- 2026-09-13 绘图参数布局（前端；改前备份 `docs/plans/backup/pre-jobC/`）：预设栏 `#view-params > .preset-bar` 吸顶（sticky，top 取 `.app-main` 上内边距的负值：桌面 -12px，≤768px -10px）；生成栏 `#nd-cost-bar` 去掉吸底，作为普通块留在绘图参数内容最后。只改 CSS，DOM 和 id 没动。
  - 验证（A/B/C 合计）：`tests/novelai` 106 条、`tests/gallery` 64 条、插件 33 条全过；`node tools/sync-gallery-core.mjs --check` 与 nai-gallery ed8458d 一致；依赖闭包（index.js + 设置页 module 脚本）113 个文件，缺失 0；旧金色 grep 0 处（备份和文档除外）。浏览器（独立端口 8765）：设置页 1440px / 375px 高亮叠层 4 个框全部对齐、主题粉生效（侧栏/手机底栏当前项、主按钮、生成按钮、下拉选中项、滑块）、边线/阴影审计 0、可见原生 select 0、375px 不横向溢出、预设栏滚动时贴顶、生成栏在内容末尾、控制台无报错；`chat-image-harness` 56/56、`gallery-harness` 72/72。
- 2026-09-14 仓库从 `D:\projects\XBDraw` 搬到 `D:\projects\xiaoheidraw`（酒馆 junction 已改指）。本轮改动（上面 52、63、92、114 行的旧描述以这里为准）：
  - 生图排队：`shared/serial-image-request-queue.js` 加跨标签页独占锁（Web Locks，名 `xiaohei-draw:nai-request`，覆盖「请求 + 冷却」全程；别的标签页持锁时报 queued `{crossTab:true}`；等锁时可取消；无 `navigator.locks` 回退页内队列）。氛围编码也进同一队列。只管同一浏览器；跨设备排队用户决定不做。「测试连接」与订阅查询仍不排队。
  - 请求间隔默认 150–300ms（`novel-draw.js` / `novel-draw.html` DEFAULTS）；设置版本 8→9，旧设置里的间隔一次性迁移成 150–300。
  - 灯箱：删整条底栏（版本/日期、「设为显示」、提示文字）和「已保存」角标，`gallery-cache.js` 的 `openGallery(slotId, messageId)` 不再带回调。
  - 删「保存到服务器 / 保存到本地」：灯箱菜单内置项、图片管理 `#nd_modal_save`、宿主 `saveSingleImage` 和 `SAVE_GALLERY_IMAGE`。旧聊天里已有 `savedUrl` 的图照常显示。
  - 参数预设、提示词预设即写即存（防抖 500ms），删 `#nd_params_save` / `#nd_prompt_preset_save` / `#nd_prompts_save`；切 tab、切预设、生成前、页面隐藏时立即写；填充表单时不触发；自动保存成功不回发 INIT_DATA（避免光标跳）。「复位」现在会自动保存；恢复默认立即写。
  - 悬浮球（仅全局那颗）静止 3 秒淡到 0.45，悬停/按下/拖动/菜单展开/非空闲状态时恢复；新文件 `novelai/ui/float-idle-dim.js`。
  - 完整画廊网站：`gallery-web/`（nai-gallery ed8458d 逐字节拷贝，`data.json` 恒为空模板，`VENDOR.json` 记 sha256），`tools/sync-gallery-web.mjs [--check]` 同步与漂移检查；图片管理（画廊）tab 顶部「完整画廊」卡片 → 全屏 iframe（新文件 `novelai/ui/gallery-web-launcher.js`）。存储键 `nai.*` / `nai-gallery` 与插件 `xb_*` 不冲突；完整画廊需在里面单独登录一次。
  - 测试：新增 `request-queue-lock`（4）、`preset-autosave`（5）、`float-idle-dim`（11）、`gallery-web-drift`（5）；`tests/novelai` + `tests/gallery` 219 条、插件 33 条全过。未在真实酒馆里实测。
- 2026-09-14 MVU 变量卡三个 bug（状态栏变代码 / 图片丢位置 / 场景 Agent 看到状态栏代码）：
  - 状态栏变代码：插件自己 `.mes_text.html(messageFormatting(...))` 整楼重写又不发事件，酒馆助手只在 `CHARACTER_MESSAGE_RENDERED / USER_MESSAGE_RENDERED / MESSAGE_UPDATED / MESSAGE_SWIPED` 时把代码块换成 iframe。新文件 `shared/message-rerender.js`：走酒馆 `updateMessageBlock`（认 `display_text`、补代码块按钮和媒体）再 `emit(MESSAGE_UPDATED)`；同楼层同一轮的多次请求合并成一次；规划中的文本（带占位符、还没写进 `mes`）用浅拷贝显示，不落盘。`draw-common.js` 转出 `rerenderChatMessage` / `isSelfEmittedMessageUpdate`，`novel-draw.js` 的占位渲染、最终同步和 `draw-common.js` 的整楼重建都改走它；插件自己发的 `MESSAGE_UPDATED` 触发的预览刷新不再整楼重建（防循环）。
  - 丢位置：MVU（bundle 事件 `mag_variable_update_started / mag_variable_update_ended`，走酒馆 eventSource，不带楼层号；`Mvu.isDuringExtraAnalysis()`）在酒馆停止生成之后才解析变量、追加 `<UpdateVariable>`、补 `\n\n<StatusPlaceHolderImpl/>` 并重渲染，插件以前一见正文变化就放弃写入。新文件 `shared/mvu-settle.js`：自动配图先等楼层落定（MVU 不忙 + 正文 800ms 不变；有 MVU 但还没占位符再多等 3 秒；最多 20 秒）；手动点画图只在 MVU 正忙时才等。`scene-source.js` 新增叙事映射（去掉临时标记和空白后逐字比对），`scene-placement.js` 新增 `rebaseScenePlacements`：只差尾部标记时把插图位置映射到新正文，规划后、生图中、写入时都会先试映射，叙事真改了仍报 `SCENE_SOURCE_CHANGED`。`tail` 尾插放到尾部占位符之前。MVU 读正文 → await → 整段写回的窗口里若盖掉了刚存的槽位（全部消失、叙事没变、期间有 MVU 活动），保存后自动按原位置补回一次。
  - 场景 Agent：默认过滤规则搬到新文件 `shared/message-filter-rules.js`（`novel-draw.html` 的副本有测试守着必须一致），新增 `<StatusPlaceHolderImpl/>`、```` ```html ```` 代码块、`<!DOCTYPE html`/`<html` 整页。过滤规则「起止填同一个记号」现在表示只删这个记号（以前会当成成对块）。整行只有 `<story>` 这类标签不再算正文，开头标签后、结尾标签后不再冒插图点。设置版本 9→10：已存过自定义过滤规则的老存档一次性把新规则补到末尾。
  - 测试：新增 `scene-source-mvu`（12，含 CRLF + `<story>` + 尾部占位符的开场白形状）、`message-rerender`（7）、`mvu-settle`（6）；`tests/novelai` + `tests/gallery` 244 条、插件 33 条全过。未在真实酒馆里实测。
- 2026-09-14 修悬浮球闲置变淡导致整页卡死：`float-idle-dim.js` 的 MutationObserver 回调里「忙」状态每次都 `classList.remove('is-dim')`，Chromium 里类不存在也会产生 class 变更记录（实测），observer → refresh → remove 无限微任务循环，悬停 / 点击悬浮球 / 出图时页面冻结。改成 `setDim(on)`：状态真要变才写 class。测试加浏览器式假 observer（每次写都通知），旧实现会失败、新实现通过；245 条全过。酒馆页实测悬停 → 恢复 → 离开 3 秒变淡，共 2 次变更，页面不卡。
- 2026-09-15 存入画廊即时反馈 + 图片管理性能：
  - 「同步到 Gallery」（聊天长按 / 灯箱）点下立刻提示「正在存入画廊…」，存完再报结果（`gallery-actions.js`）。
  - `gallery-cache.js` 数据库版本 3→4，新增 `preview_meta` 表（imgId、slotId、角色、时间、状态、savedUrl、字节数，不含图片），和图片表在同一事务里写（存图、导入、删除、过期清理、清空）；打开时数量对不上就整表扫一次重建。`getCacheStats` / `getGallerySummary` 只读元数据，不再把所有 base64 读进内存。
  - 展开角色：宿主新 `getCharacterPreviewMeta` 只回编号和时间；设置页每次渲染 60 组，底部哨兵滚到再追加；缩略图 IntersectionObserver 进屏幕才发 `LOAD_PREVIEW_IMAGES`（每批 ≤8 张，只取最新版），宿主 `getPreviewImages` 回 `PREVIEW_IMAGES_LOADED`；点开大图才取这一组的其他版本。`getCharacterPreviews` 保留给批量存入画廊用。
  - 验证：263 条测试全过；本地静态页模拟宿主 150 组（300 张）：首屏 60 组、只请求最新版、批量 ≤8、追加到 150 组、大图按需加载都对。预览面板隐藏导致 IntersectionObserver 不触发，「滚进屏幕才加载」走的是无 observer 回退路径验证的；未在真实酒馆里实测。
- 2026-09-16 Tag 过滤规则：提示词模板页新增卡片，一条一词、每条可开关、停手 500ms 自动保存（离开页面时立即写）。存在共享画图设置 `tagStripRules: [{text, enabled}]`（全局，不跟提示词预设走），宿主消息 `SAVE_TAG_STRIP_RULES`。新文件 `shared/tag-strip.js`：写的词原样删、不分大小写、删完清理多余逗号，没匹配上原样返回。`compile()` 里统一剥：场景 tag + LLM 写的角色 appear / costume / action / interact；负面、角色库、固定前缀、编辑窗口直接传入的 characterPrompts 不动。请求、存下的 tags、日志里 NAI 收到的提示词都是剥过的。测试新增 `tag-strip`（4），267 条全过；本地静态页模拟宿主验证了渲染、开关、新增聚焦、防抖保存、删除。未在真实酒馆里实测。
- 2026-09-16 API 配置底部「导出配置」：勾选「包含 API Key」才带 Key（勾上显示提醒）。宿主消息 `EXPORT_SETTINGS {includeKeys}`，导出 `{app, kind, exportedAt, includesKeys, novelDraw: getSettings(), sharedDraw: getSharedDrawSettings(), sceneAgent: loadSharedAgentSettings()}`，文件名 `小黑生图配置-YYYYMMDD-HHmm[-含Key].json`。新文件 `shared/settings-export.js`：`stripSecrets` 按字段名清空字符串密钥（apiKey / *ApiKey / proxy_password / password / token / tok / secret），结构保留。图片缓存、画廊、日志不导出。测试新增 `settings-export`（3），270 条全过。
- 2026-09-16 导入配置 + 增补提示词：
  - 导入：导出旁边「导入」→ 选 JSON → 设置页先查 `app/kind` 再弹确认（列出覆盖哪几块、带不带 Key）→ 宿主 `IMPORT_SETTINGS`：先下载一份当前配置（带 Key，文件名带「导入前备份」），再把文件里有的每一块**整份覆盖**：`novelDraw` 走 `persistSettingsNow`、`sharedDraw` 清空后换成 `normalizeSharedDrawSettings(文件)`、`sceneAgent` 走 `saveSharedAgentSettings`。Key 也按文件，不带 Key 的文件会清空现有 Key（用户决定）。之后刷新设置页、悬浮球和场景 Agent 面板。`settings-export.js` 新增 `validateSettingsImport`，`settingsExportFileName` 加 label 参数。
  - 增补提示词（原「测试提示词」卡）：插件设置 `supplementPrompt: {enabled, prompt, uc}`，全局一份、不跟参数预设；卡片标题旁「启用」开关 + 小问号悬停浮窗（触屏点开、点别处关），停手 500ms 自动保存（`SAVE_SUPPLEMENT_PROMPT`）。新文件 `shared/supplement-prompt.js`：开着时正向接在场景 tag 后、负向接在负向固定后，已包含同样内容不重复加。接入 `compile()`（聊天配图、悬浮球）、单张重新生成、失败重试。设置页底部「生成」仍总是用两个框出测试图，不看开关。
  - 悬浮球菜单新增「增补」开关字段（`float-fields.js` kind `toggle`，默认显示）；配置版本 10→11：自定义过菜单项的老存档一次性补上 `supplement`。`floating-panel.js` 导出 `refreshAllFieldControls`，设置页改开关后悬浮球同步。
  - 测试：新增 `supplement-prompt`（3），`settings-export` +1，`float-fields` 默认项断言更新；274 条全过。本地静态页模拟宿主验证：增补卡回填、自动保存、开关、浮窗开关与不被裁切、导入拒绝非本插件文件和坏 JSON、确认框内容、发出 `IMPORT_SETTINGS`。宿主侧真实覆盖写入、备份下载未在真实酒馆里实测。
- 2026-09-16 修悬浮球「增补」开关点不动：酒馆 `style.css` 给所有 `input[type=checkbox]` 加 `appearance:none` + 主题正文色底 + `::before` 画勾，在悬浮菜单里是白方块、看不出勾选。`float-fields.js` 的 toggle 改成自绘 `<button role="switch" aria-checked>`（`.nd-switch` + `.nd-switch-knob`，纯填充无描边），点击先乐观翻转再保存，保存后 sync 按真实值回写；原生 checkbox 不再出现在菜单里。Harness `docs/plans/harness/float-switch.html`（模拟酒馆 checkbox 样式）验证：开 / 关各一次，`supplementPrompt.enabled` 跟着变、增补内容保留，开关 36×20、关灰开粉。274 条测试全过；未在真实酒馆里实测。

## 目录地图（改哪里）

```
index.js                         入口：设置抽屉、后端切换、window.xbdrawDraw 门面
settings.html / style.css        扩展设置抽屉
core/                            小工具：常量、事件管理、服务端文件存储、日志
modules/draw/
  providers/novelai/             NovelAI：novel-draw.js 主控，novel-draw.html 全屏设置页，
                                 compiler.js 拼请求参数，floating-panel.js 消息旁的画图按钮
  providers/novelai/ui/          设置页组件：自绘下拉、费用栏、氛围卡、画廊浏览
  providers/novelai/novel-vibe-* 氛围迁移（编码、存储、接入生成）
  providers/novelai/novel-anlas-pricing.js / novel-subscription.js   Anlas 计价、订阅档位
  shared/scene-planner*.js       让 LLM 读剧情、规划画几张画什么
  shared/prompts/*.md            给 LLM 的规划规则（改出图风格先看这里）
  shared/draw-common.js          插图到消息、发送前清掉图片痕迹
  shared/chat-image-card.js / chat-image-gestures.js / image-lightbox.js   聊天图片卡、手势、放大看图
  shared/gallery-cache.js        聊天图片缓存
  shared/gallery-sync/           内置画廊：对接 nai-gallery（vendor/ 是原样拷贝，改前先跑漂移检查）
  shared/xb-dialog.js / xb-theme.js / nai-prompt-highlight.js       页内弹窗、粉色主题、NAI 语法高亮
modules/agent-core/              LLM 调用框架（dist/ 是打包产物，源码在上游仓库）
shared/host-llm/                 走酒馆后端发 LLM 请求
libs/                            msgpack（NAI V5 流）、fflate、js-yaml
server-plugin/                   可选的 Node 服务端插件（原样）
```

## 同步上游

拆分是脚本做的（依赖闭包 + 改名规则），上游更新后重跑脚本即可，别手动逐个文件比对。
脚本快照在 `tools/`：`closure.mjs` 算依赖，`build-xbdraw.mjs` 复制加改名（开头的源码路径、壳文件路径要先改成你机器上的位置）。
注意：重跑会生成一份全新目录，你自己改过的地方要用 git 等工具合并回去。建议现在就 `git init` 并提交一次原始状态。
