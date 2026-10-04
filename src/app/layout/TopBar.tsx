import { useLocation } from "react-router-dom";
import { Command, Moon, Search, Sun } from "lucide-react";
import { listModules, getHomeModuleId } from "@/app/registry";
import { useTheme } from "@/app/theme/ThemeProvider";
import { useCommandPalette } from "@/core/shared/components/CommandPalette";
import { useHeaderActionsValue } from "./HeaderActions";

/**
 * 顶部栏 = 全模块统一的 header（AGENTS §18.1 / §18.6）。
 * - 左侧：当前模块名（加粗）+ 模块功能描述（比模块名小一号）；
 *   ⛔ 不再显示产品名前缀（WorkBench / >），面包屑只承载「我在哪」这一件事。
 * - 右侧：当前模块注册的动作槽（useHeaderActions）+ 命令面板入口 + 主题快切；
 * - data-tauri-drag-region 使空白处可拖动窗口（按钮等子元素不带该属性，仍可正常点击）。
 */
export function TopBar() {
  const location = useLocation();
  const activeId = location.pathname.split("/")[1] || (getHomeModuleId() ?? "");
  const active = listModules().find((m) => m.id === activeId);
  const ActiveIcon = active?.icon;
  const { resolved, setTheme } = useTheme();
  const { open } = useCommandPalette();
  const actions = useHeaderActionsValue();

  return (
    <header
      data-tauri-drag-region
      className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border bg-bg-sidebar px-3"
    >
      {/* 面包屑：模块图标 + 模块名（加粗）+ 功能描述（小一号，取 ModuleManifest.description） */}
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
        {ActiveIcon && <ActiveIcon size={15} className="shrink-0 text-text-muted" />}
        <span className="shrink-0 text-sm font-semibold text-text-primary">
          {active?.name ?? "WorkBench"}
        </span>
        {active?.description && (
          <>
            <span className="mx-0.5 hidden h-3.5 w-px shrink-0 bg-border md:inline-block" />
            <span
              className="hidden min-w-0 truncate text-xs text-text-muted md:inline"
              title={active.description}
            >
              {active.description}
            </span>
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {actions}

        <button
          onClick={open}
          title="命令面板（Ctrl+K）"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-surface hover:text-text-primary"
        >
          <Search size={14} />
          <span>搜索</span>
          <kbd className="ml-0.5 inline-flex items-center gap-0.5 rounded border border-border px-1 text-[10px] text-text-muted">
            <Command size={9} />K
          </kbd>
        </button>

        <button
          onClick={() => setTheme(resolved === "dark" ? "light" : "dark")}
          title={resolved === "dark" ? "切换到浅色" : "切换到深色"}
          aria-label="切换主题"
          className="grid h-7 w-7 place-items-center rounded-md border border-border text-text-secondary hover:bg-surface hover:text-text-primary"
        >
          {resolved === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
    </header>
  );
}
