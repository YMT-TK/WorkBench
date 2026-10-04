import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { api } from "@/core/shared/api";
import { installGlobalErrorHandlers, safeInfo, reportError } from "@/core/shared/utils/errors";
import "./styles/global.css";

// 全局错误兜底（AGENTS §11）：未捕获异常统一写日志 + 友好提示
installGlobalErrorHandlers();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

/**
 * 启动自检：验证「前端 ↔ Rust」的 IPC 通路是否真的可用。
 * 若对所有 invoke 一律静默降级，会把「命令层不可用」这类致命问题藏起来，
 * 造成「界面看着正常、数据却完全存不下来」的假象。这里显式打点、失败即上报。
 */
async function bootstrapSelfCheck(): Promise<void> {
  try {
    await api.setSetting("ui_last_boot", new Date().toISOString());
    const plugins = await api.listPlugins();
    safeInfo(`ui booted · ipc ok · plugins=${plugins.length} · ua=${navigator.userAgent}`);
  } catch (err) {
    reportError(err, "前端与后端通信失败，数据可能无法保存");
  }
}

void bootstrapSelfCheck();
