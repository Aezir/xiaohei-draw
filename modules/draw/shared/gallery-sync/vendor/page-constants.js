// 自动生成，禁止手改。重新生成：node tools/sync-gallery-core.mjs
// 来源：nai-gallery index.html @ ed8458d9a17383228f22d88fc9824cac5829d1b9 第 4111, 4186 行
// 原文 sha256：a76c1aa30929ac1cc9d35505c8742b6acd01fbfbb8d54732678035cbc7154af1
// 适配：只在原文前后加了标记注释和一行 export，原文一个字符都没改。
// 运行环境要求（浏览器和 Node 18+ 都自带）：fetch、crypto.subtle、CompressionStream、Response、Blob、btoa/atob、TextEncoder。
// ==VENDOR-BEGIN page-constants==
const IMG_META = ['name', 'prompt', 'uc', 'seed', 'steps', 'scale', 'sampler', 'model', 'at', 'file', 'w', 'h', 'noimg', 'pngMeta', 'nai', 'batch'];
const IMG_BATCH = 30;                             // 一次提交最多带 30 张图（约 9MB），剩下的下一轮接着传
// ==VENDOR-END page-constants==
export { IMG_META, IMG_BATCH };
