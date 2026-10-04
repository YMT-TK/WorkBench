import type { WidgetManifest } from "./types";

/**
 * Widget 注册表 —— 数据中心只读这份表渲染（AGENTS §2 铁律）。
 * 新增 Widget：widgets/<id>/manifest.ts 调 registerWidget 一行即可，不动数据中心代码。
 */
const registry = new Map<string, WidgetManifest>();

export function registerWidget(manifest: WidgetManifest): void {
  registry.set(manifest.id, manifest);
}

export function getWidget(id: string): WidgetManifest | undefined {
  return registry.get(id);
}

export function listWidgets(): WidgetManifest[] {
  return Array.from(registry.values());
}
