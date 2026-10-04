import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";
import { notify } from "@/core/shared/components/Toast";

/**
 * 统一错误上报（AGENTS §11）。
 * - 技术细节写后端日志（data/logs/），不暴露给用户；
 * - 用户只看到友好文案，并提供「复制详情」便于反馈；
 * - 非 Tauri 环境（纯前端调试）自动降级到 console，不抛错。
 */
function safeLog(line: string): void {
  try {
    void logError(line).catch(() => console.error("[log]", line));
  } catch {
    console.error("[log]", line);
  }
}

/** 写一条 info 级诊断日志（前端启动、关键状态打点用） */
export function safeInfo(line: string): void {
  try {
    void logInfo(line).catch(() => console.info("[log]", line));
  } catch {
    console.info("[log]", line);
  }
}

/** 提取可读的错误详情 */
export function errorDetail(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return typeof err === "string" ? err : JSON.stringify(err);
}

/**
 * 上报一个错误：写日志 + 弹错误通知。
 * @param err 原始错误
 * @param friendly 面向用户的友好文案
 */
export function reportError(err: unknown, friendly = "操作失败，请稍后重试"): void {
  const detail = errorDetail(err);
  safeLog(`[ui] ${detail}`);
  notify("error", friendly, {
    action: {
      label: "复制详情",
      onClick: () => {
        void navigator.clipboard?.writeText(detail);
      },
    },
  });
}

/**
 * 安装全局兜底：未捕获的 Promise 拒绝与运行时错误统一上报（AGENTS §11）。
 * 在应用入口调用一次即可。
 */
export function installGlobalErrorHandlers(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("unhandledrejection", (e) => {
    reportError(e.reason, "出现了未预期的错误");
  });
  window.addEventListener("error", (e) => {
    // 资源加载错误无 error 对象，仅记录技术细节
    reportError(e.error ?? e.message, "出现了未预期的错误");
  });
}

/** 供 ErrorBoundary 等非组件场景直接写日志 */
export { safeLog };
