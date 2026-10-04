import { Box, GripVertical } from "lucide-react";
import type { WidgetManifest } from "@/core/plugin-host/types";

/**
 * 数据中心插件卡片（AGENTS §18.7）。
 * 视觉：类卡片式设计 —— 令牌圆角 + 分级阴影 + hover 上浮高光 + 入场动画；
 * 交互：hover 显示拖拽把手，拖拽反馈由外层控制。
 */
export function WidgetCard({
  manifest,
  config,
  index,
}: {
  manifest: WidgetManifest;
  config: Record<string, unknown>;
  index: number;
}) {
  const Icon = manifest.icon ?? Box;
  const Comp = manifest.component;

  return (
    <article
      data-widget-card={manifest.id}
      className="group relative flex h-full min-h-[124px] flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-card-hover animate-card-in"
      style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}
    >
      {/* hover 顶部高光条 */}
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100" />

      <div className="flex items-center gap-2 px-3.5 pt-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent transition-transform duration-200 group-hover:scale-105">
          <Icon size={15} />
        </span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
          {manifest.name}
        </h3>
        <GripVertical
          size={14}
          className="shrink-0 text-text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        />
      </div>

      <div className="min-w-0 flex-1 px-3.5 pb-3.5 pt-3">
        <Comp manifest={manifest} config={config} />
      </div>
    </article>
  );
}
