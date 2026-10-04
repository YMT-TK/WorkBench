import type { ReactNode } from "react";
import { AlertTriangle, Inbox, Loader2, RotateCw } from "lucide-react";

/**
 * 空 / 加载 / 错误 三态组件（AGENTS §12-A 健壮性 UX）。
 * 统一走中心对齐 + 令牌色，避免各模块各写一套 dashed 占位。
 */

export function EmptyState({
  title = "暂无内容",
  description,
  action,
  icon,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-border px-6 py-12 text-center">
      <div className="text-text-muted">{icon ?? <Inbox size={28} strokeWidth={1.5} />}</div>
      <div className="text-sm font-medium text-text-secondary">{title}</div>
      {description && <div className="max-w-md text-xs text-text-muted">{description}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = "加载中…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-text-muted">
      <Loader2 size={16} className="animate-spin" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({
  title = "加载失败",
  description,
  onRetry,
}: {
  title?: ReactNode;
  description?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-2 rounded-card border border-border px-6 py-12 text-center"
    >
      <div className="text-danger">
        <AlertTriangle size={28} strokeWidth={1.5} />
      </div>
      <div className="text-sm font-medium text-text-primary">{title}</div>
      {description && <div className="max-w-md text-xs text-text-muted">{description}</div>}
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-1 inline-flex items-center gap-1.5 rounded-pill border border-border px-3 py-1 text-xs text-accent hover:bg-surface"
        >
          <RotateCw size={13} />
          重试
        </button>
      )}
    </div>
  );
}

/** 卡片骨架（加载占位，避免内容跳变） */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="animate-pulse rounded-card border border-border bg-surface p-4">
      <div className="mb-3 h-3 w-1/3 rounded bg-border" />
      <div className="space-y-2">
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} className="h-2.5 rounded bg-border" style={{ width: `${90 - i * 12}%` }} />
        ))}
      </div>
    </div>
  );
}
