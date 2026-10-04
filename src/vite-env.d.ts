/// <reference types="vite/client" />

// 提供 import.meta.glob / import.meta.env 的类型（AGENTS §3 规约 2：注册表自动发现）。
// 缺了它，`import.meta.glob` 会以「Property 'glob' does not exist on type 'ImportMeta'」报错。
