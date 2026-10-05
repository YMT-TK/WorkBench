import { listModules } from "@/app/registry";

/** 关于：架构说明**从模块清单推导**，不罗列模块名 —— 否则加了模块必然过时（AGENTS §2 规约 2）。 */
export function AboutPanel() {
  const mods = listModules();
  const home = mods.find((m) => m.pinned);
  const business = mods.filter((m) => !m.system && !m.pinned);
  const archText = [home?.name, ...business.map((m) => m.name)].filter(Boolean).join(" + ");

  return (
    <div className="space-y-1.5 text-sm text-text-secondary">
      <div className="flex items-center gap-2 text-text-primary">
        <img src="/app-icon.png" alt="" className="h-6 w-6 rounded-md" />
        <span>WorkBench · 桌面工作台</span>
      </div>
      <div>版本 0.1.0</div>
      <div>插件化架构：{archText || "—"}</div>
      <div className="pt-1 text-xs text-text-muted">
        命令面板 Ctrl+K · 数据存于本机 SQLite（单实例独占写） · 关闭默认收进系统托盘
      </div>
    </div>
  );
}
