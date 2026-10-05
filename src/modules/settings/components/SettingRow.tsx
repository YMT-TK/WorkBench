import type { ReactNode } from "react";

/**
 * 设置项外框：左上是「标签 + 灰色补充说明」，下面是控件。
 *
 * 抽出来是因为存储页里有二十多个条目 —— 各写各的必然间距与字号不一致，
 * 而这种「看起来没对齐」的毛病最耗返工时间。
 */
export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-sm text-text-secondary">{label}</span>
        {hint && <span className="text-xs text-text-muted">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
