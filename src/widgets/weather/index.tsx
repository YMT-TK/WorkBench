import { CloudSun, MapPin } from "lucide-react";
import type { WidgetProps } from "@/core/plugin-host/types";

/** 天气 Widget（阶段二会接真实数据源；此处为插件模型验证用） */
export default function WeatherWidget({ config }: WidgetProps) {
  const city = (config.city as string) || "北京";
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-semibold text-text-primary">24</span>
          <span className="text-sm text-text-secondary">°C</span>
        </div>
        <div className="mt-1 inline-flex items-center gap-1 text-xs text-text-secondary">
          <MapPin size={12} className="text-text-muted" />
          {city} · 晴
        </div>
      </div>
      <CloudSun size={30} className="shrink-0 text-warning" strokeWidth={1.5} />
    </div>
  );
}
