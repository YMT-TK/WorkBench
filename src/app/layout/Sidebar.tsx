import { NavLink } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { listModules, type ModuleManifest } from "@/app/registry";
import { useAppSetting } from "@/core/shared/hooks/useAppSetting";

/**
 * 侧边栏：模块清单驱动渲染（AGENTS §15）。
 * - hidden_modules 控制隐藏入口（不删数据）；sidebar_collapsed 控制整体收起。
 * - 收起态只留图标，用 title 提供悬浮提示，避免无法辨认。
 */
export function Sidebar() {
  const modules = listModules();
  const [hidden] = useAppSetting<string[]>("hidden_modules", []);
  // 默认收起（AGENTS §15）：只留图标栏，内容区更宽；用户展开后持久化其选择
  const [collapsed, setCollapsed] = useAppSetting<boolean>("sidebar_collapsed", true);

  // 系统级模块常驻；业务模块按 hidden_modules 隐藏入口
  const visible = modules.filter((m) => m.system || !hidden.includes(m.id));
  // 分组顺序：主界面（pinned，如数据中心）→ 工作模块 → 系统
  const groups = [
    { label: "主界面", items: visible.filter((m) => m.pinned) },
    { label: "工作模块", items: visible.filter((m) => !m.pinned && !m.system) },
    { label: "系统", items: visible.filter((m) => !m.pinned && m.system) },
  ].filter((g) => g.items.length > 0);

  return (
    <nav
      className="flex h-full shrink-0 flex-col border-r border-border bg-bg-sidebar transition-[width] duration-200"
      style={{ width: collapsed ? 56 : 208 }}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 overflow-hidden px-3">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accent text-[13px] font-bold text-white">
          W
        </span>
        {!collapsed && (
          <span className="truncate text-sm font-semibold text-text-primary">WorkBench</span>
        )}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-2 pb-2">
        {groups.map((g) => (
          <div key={g.label}>
            {!collapsed && (
              <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">
                {g.label}
              </div>
            )}
            <div className="space-y-0.5">
              {g.items.map((m) => (
                <NavItem key={m.id} m={m} collapsed={collapsed} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={() => setCollapsed(!collapsed)}
        title={collapsed ? "展开侧边栏" : "收起侧边栏"}
        aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
        className="m-2 flex h-8 items-center justify-center gap-1.5 rounded-md text-xs text-text-muted hover:bg-surface/60 hover:text-text-primary"
      >
        {collapsed ? (
          <ChevronRight size={15} />
        ) : (
          <>
            <ChevronLeft size={15} />
            <span>收起</span>
          </>
        )}
      </button>
    </nav>
  );
}

function NavItem({ m, collapsed }: { m: ModuleManifest; collapsed: boolean }) {
  const Icon = m.icon;
  return (
    <NavLink
      to={`/${m.id}`}
      title={collapsed ? m.name : undefined}
      className={({ isActive }) =>
        `relative flex items-center gap-2.5 rounded-md py-2 text-sm transition-colors ${
          collapsed ? "justify-center px-2" : "px-2"
        } ${
          isActive
            ? "bg-surface font-medium text-accent"
            : "text-text-secondary hover:bg-surface/60 hover:text-text-primary"
        }`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
          )}
          <Icon size={17} className="shrink-0" />
          {!collapsed && <span className="truncate">{m.name}</span>}
        </>
      )}
    </NavLink>
  );
}
