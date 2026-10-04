import { useEffect, useMemo } from "react";
import { Outlet, useLocation, Navigate } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { HeaderActionsProvider } from "./HeaderActions";
import { listModules, getHomeModuleId } from "@/app/registry";
import { useAppSetting } from "@/core/shared/hooks/useAppSetting";
import { notify } from "@/core/shared/components/Toast";

/**
 * 应用主布局：侧边栏 +（顶部栏 / 内容区）外壳。
 * 当前页被隐藏时自动跳安全默认页，避免导航断裂（AGENTS §15）。
 */
export function AppLayout() {
  const location = useLocation();
  const [hidden] = useAppSetting<string[]>("hidden_modules", []);
  const activeId = location.pathname.split("/")[1] || (getHomeModuleId() ?? "");
  const active = listModules().find((m) => m.id === activeId);

  // 安全落点：优先注册表默认落点（pinned，如数据中心），否则第一个可见模块。
  // 不写死具体 id —— 换主界面只改 ModuleManifest.pinned（AGENTS §2 规约 2）。
  const safeTarget = useMemo(() => {
    const mods = listModules();
    const home = mods.find((m) => m.id === getHomeModuleId());
    if (home && (home.system || !hidden.includes(home.id))) return `/${home.id}`;
    const firstVisible = mods.find((m) => m.system || !hidden.includes(m.id));
    return firstVisible ? `/${firstVisible.id}` : "/";
  }, [hidden]);

  const targetName = useMemo(
    () => listModules().find((m) => `/${m.id}` === safeTarget)?.name ?? "主界面",
    [safeTarget],
  );

  const blocked = Boolean(active && !active.system && hidden.includes(active.id));
  const blockedName = active?.name;

  useEffect(() => {
    if (blocked && blockedName) {
      notify("info", `「${blockedName}」已从侧边栏隐藏，已切换到「${targetName}」`);
    }
  }, [blocked, blockedName, targetName]);

  if (blocked) {
    return <Navigate to={safeTarget} replace />;
  }

  return (
    <HeaderActionsProvider>
      <div className="flex h-full">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="min-w-0 flex-1 overflow-auto bg-bg-app">
            <Outlet />
          </main>
        </div>
      </div>
    </HeaderActionsProvider>
  );
}
