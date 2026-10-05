import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppLayout } from "@/app/layout/AppLayout";
import { CommandPaletteProvider } from "@/core/shared/components/CommandPalette";
import { listModules, getHomeModuleId } from "@/app/registry";
import "@/modules"; // 触发模块自注册
import "@/widgets"; // 触发 Widget 自注册

/**
 * 路由表由模块清单生成（AGENTS §4 规约 2：入口来自清单，不硬编码）。
 * 命令面板挂在 Router 内，才能用 useNavigate 跳转。
 */
export function AppRouter() {
  const modules = listModules();
  // 默认落点由注册表决定（pinned 模块），不写死具体 id（AGENTS §2）
  const home = `/${getHomeModuleId() ?? ""}`;
  return (
    <HashRouter>
      <CommandPaletteProvider modules={modules}>
        <Routes>
          <Route path="/" element={<AppLayout />}>
            <Route index element={<Navigate to={home} replace />} />
            {modules.map((m) => (
              <Route key={m.id} path={m.id} element={<m.component />} />
            ))}
            <Route path="*" element={<Navigate to={home} replace />} />
          </Route>
        </Routes>
      </CommandPaletteProvider>
    </HashRouter>
  );
}
