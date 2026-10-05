import type { ReactNode } from "react";

export type NoteTone = "info" | "warning" | "danger" | "success";

const TONE_CLASS: Record<NoteTone, string> = {
  info: "border-border bg-bg-sidebar text-text-muted",
  warning: "border-warning/40 bg-warning/10 text-text-secondary",
  danger: "border-danger/40 bg-danger/10 text-text-secondary",
  success: "border-success/40 bg-success/10 text-text-secondary",
};

/**
 * 说明条：设置页里大量「这段话必须让用户看到」的地方用它。
 *
 * 统一成一个组件是为了**语义固定**：`danger` 只用于「会造成不可逆损失」，
 * `warning` 用于「你要知道，但可以继续」。各页面自己拼 border/bg 时，
 * 这两档迟早被混用，红色就失去警示力了。
 */
export function Note({
  tone = "info",
  icon,
  title,
  children,
}: {
  tone?: NoteTone;
  icon?: ReactNode;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex items-start gap-2 rounded-card border px-3 py-2 text-xs leading-relaxed ${TONE_CLASS[tone]}`}
    >
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <span>
        {title && <span className="font-medium text-text-primary">{title}　</span>}
        {children}
      </span>
    </div>
  );
}
