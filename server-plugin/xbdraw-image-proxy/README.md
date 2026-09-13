# XBDraw Image Proxy（xbdraw-image-proxy）

小黑生图（XBDraw）的可选 SillyTavern server plugin。只做一件事：**代理转发 NovelAI 请求**，用来绕过浏览器 CORS 和自签证书限制。不保存任务，不保存 API Key。

插件 id 以 `xbdraw-` 开头，和 LittleWhiteBox 的插件不会撞名，可以同时安装。

## 安装

1. 确认 SillyTavern 使用 Node.js 18 或更新版本。
2. 把本目录完整复制为 `SillyTavern/plugins/xbdraw-image-proxy/`（`tests/` 可以不复制）。
3. 在 `config.yaml` 开启 `enableServerPlugins: true`，重启 SillyTavern。

不需要 `npm install`：V5 流解析器已随附在 `providers/novelai/vendor/`。

## 路由

命名空间：`/api/plugins/xbdraw-image-proxy/`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | `{ok, id, version, capabilities}` |
| POST | `/v1/generate-image` | 旧版契约：`{url(基地址), key, payload, timeout}` → `{ok, base64, mime}` |
| POST | `/v2/generate-image` | `{url(完整端点), key, payload, timeout, insecure}` → `{ok, base64, mime}` |
| POST | `/v1/generate-image-stream` | V5：原样转发 MessagePack 流 |
| POST | `/v1/test`、`/v2/test` | 连接测试 |
| POST | `/v1/encode-vibe` | 氛围编码（**每次扣 2 Anlas**，不重试）：`{key, payload:{image, information_extracted, model}, url?, timeout?}` → `{ok, base64, bytes}`；只接受 V4/V4.5 模型 |
| POST | `/v1/subscription` | 订阅档位只读查询：`{key, url?, timeout?}` → `{ok, subscription}`（上游 `GET /user/subscription`） |

capabilities：

```text
v5-msgpack-stream
novelai-encode-vibe-v1
novelai-subscription-v1
```

## 测试

```sh
node --test tests/
```

测试只连本地假上游，不访问 novelai.net。

## 3.0.0 变更

- 从小白X 的后台任务插件（2.3.0）改名并瘦身：删除后台批量任务（`/v1/jobs`）、后台场景规划运行、回环探针、另外两个画图后端的适配器和 vendor 打包产物。
- 新增 `/v1/encode-vibe`、`/v1/subscription`。
