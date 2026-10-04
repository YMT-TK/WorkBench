import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type ToastLevel = "success" | "info" | "warning" | "error";

export interface ToastOptions {
  /** 自定义按钮（如「撤销」「重试」） */
  action?: { label: string; onClick: () => void };
  /** 自定义停留时长(ms)；error 默认不自动消失 */
  duration?: number;
}

interface ToastItem {
  id: number;
  level: ToastLevel;
  message: string;
  action?: ToastOptions["action"];
}

interface ToastContextValue {
  notify: (level: ToastLevel, message: string, opts?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// 默认自动消失时长：error 不自动消失
const DEFAULT_DURATION: Record<ToastLevel, number> = {
  success: 3000,
  info: 3000,
  warning: 5000,
  error: 0,
};

// 解耦订阅：非 React 代码（如 event-bus 监听）也能直接调用 notify()
const listeners = new Set<(level: ToastLevel, message: string, opts?: ToastOptions) => void>();
let seq = 0;

export function notify(level: ToastLevel, message: string, opts?: ToastOptions): void {
  listeners.forEach((l) => l(level, message, opts));
}

const LEVEL_STYLE: Record<ToastLevel, { bar: string; icon: string }> = {
  success: { bar: "border-l-success", icon: "✓" },
  info: { bar: "border-l-accent", icon: "ℹ" },
  warning: { bar: "border-l-warning", icon: "⚠" },
  error: { bar: "border-l-danger", icon: "✕" },
};

function ToastCard({ item, onClose }: { item: ToastItem; onClose: () => void }) {
  const style = LEVEL_STYLE[item.level];
  return (
    <div
      role={item.level === "error" ? "alert" : "status"}
      aria-live={item.level === "error" ? "assertive" : "polite"}
      className={`pointer-events-auto rounded-card border border-border ${style.bar} border-l-4 bg-surface p-3 shadow-lg`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-sm font-bold text-text-secondary">{style.icon}</span>
        <div className="flex-1 text-sm text-text-primary">{item.message}</div>
        <button
          onClick={onClose}
          className="text-text-muted hover:text-text-primary"
          aria-label="关闭"
        >
          ×
        </button>
      </div>
      {item.action && (
        <div className="mt-2 text-right">
          <button
            onClick={() => {
              item.action?.onClick();
              onClose();
            }}
            className="text-sm font-medium text-accent hover:underline"
          >
            {item.action.label}
          </button>
        </div>
      )}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback<ToastContextValue["notify"]>(
    (level, message, opts) => {
      const id = ++seq;
      const duration = opts?.duration ?? DEFAULT_DURATION[level];
      setToasts((t) => [...t, { id, level, message, action: opts?.action }]);
      if (duration > 0) setTimeout(() => remove(id), duration);
    },
    [remove],
  );

  useEffect(() => {
    listeners.add(push);
    return () => {
      listeners.delete(push);
    };
  }, [push]);

  return (
    <ToastContext.Provider value={{ notify: push }}>
      {children}
      {/* 右下角项目内通知（AGENTS §10） */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <ToastCard key={t.id} item={t} onClose={() => remove(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** 在组件内获取 notify（也可用模块级 notify 直接调用） */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast 必须在 ToastProvider 内使用");
  return ctx;
}
