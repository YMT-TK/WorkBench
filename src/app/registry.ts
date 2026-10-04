import type { ComponentType } from "react";

/**
 * 模块图标类型：只依赖 size/className 两个最小契约，
 * 兼容 lucide 图标（其 size 为 `string | number`）与自定义组件。
 */
export type ModuleIcon = ComponentType<{ size?: string | number; className?: string }>;

/** 功能模块清单（侧边栏一级导航入口，AGENTS §2） */
export interface ModuleManifest {
  id: string; // 路由段，如 "data-center"
  name: string;
  /** 命令面板/设置页展示用的简短说明 */
  description?: string;
  icon: ModuleIcon;
  component: ComponentType;
  order: number;
  /** 系统级模块（数据中心/设置）默认常驻，业务模块允许隐藏 */
  system?: boolean;
  /**
   * 置顶主入口：渲染在侧边栏「主界面」分组首项，且作为应用默认落地页候选。
   * 目前由数据中心占用（AGENTS §15）。
   */
  pinned?: boolean;
}

const registry = new Map<string, ModuleManifest>();

export function registerModule(m: ModuleManifest): void {
  registry.set(m.id, m);
}

export function listModules(): ModuleManifest[] {
  return Array.from(registry.values()).sort((a, b) => a.order - b.order);
}

export function getModule(id: string): ModuleManifest | undefined {
  return registry.get(id);
}

/**
 * 应用默认落点模块 id（唯一来源）。
 *
 * 优先级：pinned（主界面，如数据中心）→ 第一个系统级模块 → 第一个模块。
 * 路由 index / 404、隐藏模块的安全落点、面包屑兜底都读它，
 * ⛔ 不要在别处写死 "data-center" —— 以后换主界面只改 `pinned` 一处即可。
 */
export function getHomeModuleId(): string | undefined {
  const mods = listModules();
  return mods.find((m) => m.pinned)?.id ?? mods.find((m) => m.system)?.id ?? mods[0]?.id;
}
