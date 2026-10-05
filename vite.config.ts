import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";

/**
 * 版本号单一来源（AGENTS §21.7）。
 * 前端⛔ 不硬编码版本号 —— 从 package.json 读，经 define 注入为编译期常量 `__APP_VERSION__`。
 * 升级时只跑 `npm version patch|minor`，不必记得同步 N 处（设置页「关于」也会跟着变）。
 * 类型声明在 `src/vite-env.d.ts`。
 */
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as {
  version: string;
};

/**
 * dev 期请求日志（仅开发用）：把 webview 实际请求的路径打到终端。
 * 真机排障关键——能区分「窗口白屏（webview 根本没请求）」与「前端已加载但 IPC 被拒」。
 */
function devRequestLogger() {
  return {
    name: "wb-dev-request-logger",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        // 忽略 HMR 心跳与 favicon 噪音
        if (req.url && !req.url.startsWith("/@vite/client")) {
          console.log(`[req] ${req.method} ${req.url}`);
        }
        next();
      });
    },
  };
}

/**
 * dev 期端到端探针注入（仅 WB_E2E=1 时启用）。
 * 把 scripts/e2e-probe.js 注入 index.html，让它在真实 WebView 里自动点一遍关键交互，
 * 结果经 /__e2e?... 回报到终端 —— 交互类改动也能被程序化验证，而不是只靠肉眼看窗口。
 * 生产构建 apply:'serve' 不生效，故零影响。
 */
function devE2eProbe() {
  return {
    name: "wb-dev-e2e-probe",
    apply: "serve" as const,
    transformIndexHtml(html: string) {
      if (process.env.WB_E2E !== "1") return html;
      const file = path.resolve(__dirname, "scripts/e2e-probe.js");
      if (!fs.existsSync(file)) return html;
      const code = fs.readFileSync(file, "utf8");
      return html.replace("</body>", `<script type="module">${code}</script></body>`);
    },
  };
}

// @tauri-apps/cli 会把 dev 时的前端挂到 http://127.0.0.1:5173
export default defineConfig({
  plugins: [react(), devRequestLogger(), devE2eProbe()],
  // 版本号单一来源：见文件头 `pkg`（AGENTS §21.7）
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  // Tauri 期望固定端口，避免 dev 时端口漂移
  clearScreen: false,
  server: {
    // 必须显式绑定 IPv4 回环：默认 localhost 在本机会只解析到 ::1（纯 IPv6），
    // 而 WebView2 请求 localhost 时可能走 127.0.0.1，导致连不上 → 窗口白屏。
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2020",
    outDir: "dist",
    emptyOutDir: true,
  },
});
