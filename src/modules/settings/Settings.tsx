import { useState } from "react";
import { Cog, Eye, HardDrive, Info, Palette, Settings as SettingsIcon } from "lucide-react";
import { registerModule } from "@/app/registry";
import { Card } from "@/core/shared/components/Card";
import { AboutPanel } from "./panels/AboutPanel";
import { AppearancePanel } from "./panels/AppearancePanel";
import { GeneralPanel } from "./panels/GeneralPanel";
import { ModulesPanel } from "./panels/ModulesPanel";
import { StoragePanel } from "./panels/storage/StoragePanel";

/**
 * 设置模块的**壳**：只负责子页导航 + 分发。
 *
 * 各子页的实现都在 `panels/` 下 —— 这个文件曾经是 1082 行、一个大函数里塞着
 * 「数据位置 / 密钥 / 备份 / 模块可见性」全部状态，改一处要通读全篇。
 * 现在参考线是**单文件超过 ~300 行就该拆**。
 *
 * ⚠️ `src/modules/index.ts` 用 `import.meta.glob` 以**单层通配**自动发现模块，
 * 它只匹配『模块目录 / 文件』这一层：`panels/` 与 `components/` 里的文件都在两层及以下，
 * 不会被误注册成模块。新增设置子页时照此放进 `panels/`，别放到模块根目录。
 */

const SubMenus = [
  { id: "appearance", name: "外观", icon: Palette },
  { id: "general", name: "通用", icon: Cog },
  { id: "storage", name: "存储", icon: HardDrive },
  { id: "modules", name: "模块", icon: Eye },
  { id: "about", name: "关于", icon: Info },
] as const;

type SubId = (typeof SubMenus)[number]["id"];

export default function Settings() {
  const [sub, setSub] = useState<SubId>("appearance");
  return (
    <div className="flex h-full">
      <aside className="w-44 shrink-0 border-r border-border p-3">
        <div className="mb-2 px-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">
          设置
        </div>
        <div className="space-y-0.5">
          {SubMenus.map((m) => {
            const Icon = m.icon;
            const active = sub === m.id;
            return (
              <button
                key={m.id}
                onClick={() => setSub(m.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                  active
                    ? "bg-surface font-medium text-accent"
                    : "text-text-secondary hover:bg-surface/60 hover:text-text-primary"
                }`}
              >
                <Icon size={15} className="shrink-0" />
                {m.name}
              </button>
            );
          })}
        </div>
      </aside>
      <section className="min-w-0 flex-1 overflow-auto p-5">
        <div className="mb-3 text-xs font-medium uppercase tracking-wide text-text-muted">
          {SubMenus.find((m) => m.id === sub)?.name ?? "设置"}
        </div>
        <Card>
          {sub === "appearance" && <AppearancePanel />}
          {sub === "general" && <GeneralPanel />}
          {sub === "storage" && <StoragePanel />}
          {sub === "modules" && <ModulesPanel />}
          {sub === "about" && <AboutPanel />}
        </Card>
      </section>
    </div>
  );
}

registerModule({
  id: "settings",
  name: "设置",
  description: "外观、通用行为、存储与跨机导入、模块可见性",
  icon: SettingsIcon,
  component: Settings,
  order: 90,
  system: true,
});
