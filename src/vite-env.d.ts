/// <reference types="vite/client" />

// 提供 import.meta.glob / import.meta.env 的类型（AGENTS §3 规约 2：注册表自动发现）。
// 缺了它，`import.meta.glob` 会以「Property 'glob' does not exist on type 'ImportMeta'」报错。

// 版本号单一来源：由 vite.config.ts 的 define 注入 package.json 的 version（AGENTS §21.7）。
// 🔴 前端别硬编码版本号；升级只跑 `npm version`。
declare const __APP_VERSION__: string;
