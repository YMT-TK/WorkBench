/** 面板内的分段标题（比 SettingRow 的标签更轻，用来切分「数据位置」「密钥与安全」这类大段）。 */
export function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-text-muted">{title}</span>
      {hint && <span className="text-[11px] text-text-muted">{hint}</span>}
    </div>
  );
}
