import type { ComponentType } from "react";

/** 插件图标类型：最小契约（size / className），兼容 lucide 组件与自定义组件 */
export type WidgetIcon = ComponentType<{ size?: string | number; className?: string }>;

/** Widget 设置项 schema（驱动配置弹窗表单，AGENTS §4 规约 1） */
export interface SettingField {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "select";
  default: unknown;
  options?: { label: string; value: string }[];
  placeholder?: string;
}

/** Widget 插件清单（声明式注册） */
export interface WidgetManifest {
  id: string;
  name: string;
  description?: string;
  /** 图标（配置面板行 / 卡片头部展示，lucide 组件；缺省用通用图标兜底） */
  icon?: WidgetIcon;
  /** 默认网格尺寸（单位：网格列/行） */
  defaultSize: { w: number; h: number };
  /** 设置项 schema；缺省表示无配置 */
  settingsSchema?: SettingField[];
  /** 组件本体（数据中心渲染用） */
  component: ComponentType<WidgetProps>;
}

/** 传给 Widget 组件的 props */
export interface WidgetProps {
  config: Record<string, unknown>;
  manifest: WidgetManifest;
}
