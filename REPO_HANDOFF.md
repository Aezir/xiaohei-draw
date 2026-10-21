# 小黑生图：窗口交接速读

> 更新：2026-10-22。基于本地源码快速阅读；非完整审计。后续窗口先读本文件，按任务打开相关源码，无需通读 README。

## 当前状态

- 用户：这是基于 SillyTavern「小白X」二改的文生图插件。已完成快速阅读交接，随后修复多图队列中失败处理异常导致整批中断的问题。
- 项目名：小黑生图 / XBDraw；从 LittleWhiteBox 3.1.1（`960b323`）拆出，原作者 biex。署名与许可证见 `docs/LICENSE.md`。
- 当前分支 `main`，修复基线 HEAD `9a86c99`。本次交付新增本文件及 `tests/novelai/batch-partial-failure.test.mjs`，修改 `novel-draw.js`；未做真实酒馆验收。
- 纯浏览器 ES modules，依赖酒馆宿主；根目录无 package.json、无常规 npm 构建流程，不能直接当独立网页运行。可选服务端代理单独为 CommonJS。
- 仅保留 NovelAI 后端；SD/ComfyUI、后台任务和断线接回已移除，个别旧命名/存储声明仍残留，不代表功能仍受支持。

## 主链路与修改入口

`index.js` 启动 → `novel-draw.js` 协调 → 场景 Agent 读剧情规划 → `compiler.js` 编译提示词/参数 → NovelAI 串行请求 → 缓存图片并写入聊天插图槽位 → 重渲染/补卡。

| 需求 | 先读的位置（相对仓库根目录） |
|---|---|
| 启停、抽屉、全局门面、扩展更新 | `index.js`、`manifest.json`、`settings.html`、`core/constants.js` |
| 生图主流程、自动/手动配图、设置消息处理 | `modules/draw/providers/novelai/novel-draw.js`（约 5k 行，先搜索函数） |
| 设置页、悬浮球 | 同目录 `novel-draw.html`、`floating-panel.js`、`float-fields.js`、`ui/` |
| 拼提示词、V4/V4.5/V5 请求 | 同目录 `compiler.js`、`novel-request-config.js`、`novel-v5-*` |
| 氛围迁移、计价与订阅 | 同目录 `novel-vibe-*`、`novel-anlas-pricing.js`、`novel-cost-rule.js`、`novel-subscription.js` |
| 场景规划/校验/插图位置 | `modules/draw/shared/scene-planner*.js`、`scene-plan-*`、`scene-source.js`、`scene-placement.js` |
| LLM 提示词/连接 | `modules/draw/shared/prompts/`、`draw-agent*.js`；`modules/agent-core/`；`shared/host-llm/` |
| MVU 时序、楼层重渲染 | `modules/draw/shared/mvu-settle.js`、`message-rerender.js`、`draw-common.js` |
| 图片卡、编辑、长按菜单、灯箱 | `modules/draw/shared/chat-image-card.js`、`chat-image-gestures.js`、`image-action-menu.js`、`image-lightbox.js` |
| 图片缓存、去重、请求排队 | `modules/draw/shared/gallery-cache.js`、`generated-image-runtime.js`、`serial-image-request-queue.js` |
| 配置导入导出、Tag 过滤、增补提示词、日志 | `modules/draw/shared/settings-export.js`、`tag-strip.js`、`supplement-prompt.js`、`draw-log*.js` |
| 画廊同步与嵌入 | `modules/draw/shared/gallery-sync/`、`providers/novelai/ui/gallery-*.js`（位于 `modules/draw/` 下）、`gallery-web/` |
| 可选服务端代理 | `server-plugin/xbdraw-image-proxy/`，接口前缀 `/api/plugins/xbdraw-image-proxy/`，独立 README |

主控搜索锚点：`initNovelDraw`、`cleanupNovelDraw`、`generateAndInsertImages` / `runGenerateAndInsertImages`、`generateImagesFromText` / `runGenerateImagesFromText`、`runNovelImageBatch`。

## 必须保留的兼容边界

- 设置命名空间 `extension_settings.XBDraw`，全局 `window.xbdrawDraw` / `window.xbdrawNovelDraw`，拦截器 `xbdrawGenerateInterceptor`，iframe 标识 `XBDraw-NovelDraw`。
- **故意保留**聊天键 `xiaobaixDrawSaved`、`[image:id]` 占位符与 `xb_*` IndexedDB 名称，保证旧聊天兼容；不要批量改名。避免与小白X 的画图同时启用。
- 服务端文件存储见 `core/server-storage.js` / `storage-file.js`：`XBDraw_NovelDraw.json`、`XBDraw_CommonSettings.json`，场景 Agent 使用 `XBDraw_Assistant.json`。图片/氛围/日志等另有本机存储。
- 入口当前固定 NovelAI，由总开关控制；README 中「选择画图后端」文字已落后于源码。
- 配置导入按文件中提供的配置块整份覆盖；不带 Key 的配置会清空对应现有 Key，导入前会下载含 Key 备份。修改此处需关注既有语义。
- `modules/agent-core/dist/` 是随附打包产物；`gallery-sync/vendor/`、`gallery-web/index.html` / `icon.svg` 有来源/哈希记录，应走同步脚本，不直接手改副本。

## 最近改动（继续开发时注意）

- 2026-10-22 修复：`runNovelImageBatch` 隔离失败/取消结果回调的异常，写失败记录或渲染失败卡报错不再中断后续请求，异常记控制台/配图日志；聊天最终提交只保留已落库结果槽位，部分失败时强制最终 DOM 同步。7 个模拟宿主回归覆盖首/中/尾失败、全失败、全成功及失败记录/失败卡异常。修复前后两个异常用例由失败变为通过。普通接口单项失败原本能继续，用户现场的具体底层异常尚无日志确认。
- `9a86c99` / `5f2f7fe`：规划后正文变化，按前文锚点近似重定位插图，找不到则尾插；`allowApproximate: false` 保留拒绝行为，变化写入日志。
- `93d03c1`：图片卡被 TauriTavern 异步重绘冲掉后定时补卡并记上屏日志；Agent 连接错误提示、官方 Provider 快选；V5 不再单独触发生成确认；触屏编辑不自动聚焦。
- `98a816f`：单击图片开灯箱，编辑移至长按菜单，编辑框居中；参数测试图支持下载/存画廊。
- `5ad3cc9`：Tag 过滤、配置导入导出、增补提示词与悬浮球开关。
- 更早有 MVU 落定等待、增量缩略图、画廊 iframe、氛围迁移与计价等二改，细节按需查 README「自己的改动记录」。

## 验证与同步

本机 Node v24.15.0。2026-10-22 已运行前端全部测试：288 项，286 通过、2 项外部仓库漂移检查因 Git ownership 限制跳过、0 失败；`git diff --check` 通过。代理本轮未改、未重跑测试。命令：

```powershell
# 根目录：前端纯函数/模拟宿主测试
node --test tests/novelai/*.test.mjs tests/gallery/*.test.mjs
# 根目录：代理测试（本地假上游）
node --test server-plugin/xbdraw-image-proxy/tests/*.test.js
# 只读漂移检查；上游默认 D:/projects/nai_gallery，可用 --src 指定
node tools/sync-gallery-core.mjs --check
node tools/sync-gallery-web.mjs --check
```

- 部分漂移测试缺少外部 nai-gallery 仓库会跳过，不能把跳过视为上游一致。`gallery-web/VENDOR.json` 当前记录 `ref: WORKTREE, dirty: true`，来源含未提交内容，不能直接用 HEAD 覆盖。
- `tools/build-xbdraw.mjs` / `closure*.json` 是历史上游拆分工具，依赖未随附的源码/壳目录；不是当前项目日常构建命令，重跑前需合并保护二改。
- `.claude/launch.json` 配置静态服务 8791 和外部画廊 8792；README 提及的 `docs/plans/harness/` 当前不在仓库内。
- 单测不证明真实酒馆、TauriTavern、MVU 或 iframe 联动通过。当前宿主版本未确认；本轮未安装、启用、更新插件，未调用付费生图。

后续接手：先 `git status --short` / `git log -5 --oneline` 确认状态，再沿上表只读相关模块；新增改动后更新本文件的状态与验证结果。
