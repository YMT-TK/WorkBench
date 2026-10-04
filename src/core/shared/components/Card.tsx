import type { ReactNode } from "react";

/** 通用卡片容器（Widget / 模块面板共用），统一 surface + 圆角 + 边框令牌 */
export function Card({
  children,
  className = "",
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
}) {
  return (
    <div className={`rounded-card border border-border bg-surface ${className}`}>
      {title && (
        <div className="border-b border-border px-4 py-2 text-sm font-medium text-text-secondary">
          {title}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}
