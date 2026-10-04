import { CloudSun } from "lucide-react";
import { registerWidget } from "@/core/plugin-host/registry";
import type { SettingField, WidgetManifest } from "@/core/plugin-host/types";
import WeatherWidget from "./index";

const weatherSettings: SettingField[] = [
  { key: "city", label: "城市", type: "text", default: "北京", placeholder: "如 北京" },
];

/** Widget 插件清单（声明式注册，AGENTS §4 规约 1） */
export const weatherManifest: WidgetManifest = {
  id: "weather",
  name: "天气",
  description: "本地天气概览卡片",
  icon: CloudSun,
  defaultSize: { w: 1, h: 1 },
  settingsSchema: weatherSettings,
  component: WeatherWidget,
};

registerWidget(weatherManifest);
