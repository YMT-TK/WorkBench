import type { ReactNode } from "react";

/**
 * 页面内容容器：统一内边距与最大宽度（AGENTS §18.1 复用优先）。
 *
 * 注意：页面**不再自带头部**。模块名称 / 功能描述由外层统一 header（`app/layout/TopBar`）
 * 以面包屑形式呈现，模块专属操作按钮经 `useHeaderActions` 注册到顶栏 —— 这样内容区
 * 不再被内层标题栏占用，显示面积最大化。
 */
export function PageContainer({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`mx-auto w-full max-w-[1440px] p-5 ${className}`}>{children}</div>;
}
