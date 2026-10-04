import { invoke } from "@tauri-apps/api/core";

/**
 * 是否运行在 Tauri 宿主内。
 * 用于区分两类失败：浏览器里调试（预期降级，静默）vs 真实 IPC 故障（必须报错）。
 * —— 之前统一静默降级，把 WebView2 崩溃这类致命问题藏了 43 分钟。
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 插件状态（对应 plugins 表，AGENTS §3 数据存储） */
export interface PluginState {
  id: string;
  enabled: number; // 0=隐藏 1=显示
  sort: number;
  config: string; // JSON
}

/** 数据存储概况（对应 Rust StorageInfo，AGENTS §20） */
export interface StorageInfo {
  /** 配置里生效的数据目录 */
  dataDir: string;
  /** 本次进程实际打开数据库的目录 */
  runningDir: string;
  /** 运行中的数据库文件绝对路径 */
  dbPath: string;
  /** .db / -wal / -shm 合计字节数 */
  dbSize: number;
  isCustom: boolean;
  defaultDir: string;
  /** 配置已改、需重启才生效的目标目录；无需重启为 null */
  pendingDir: string | null;
}

/**
 * 前端唯一碰后端入口（AGENTS §3 规约 5）。
 * 所有文件/数据库/原生操作都经此处 invoke Rust commands。
 */
export const api = {
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  listPlugins: () => invoke<PluginState[]>("list_plugins"),
  updatePlugin: (id: string, patch: Partial<Omit<PluginState, "id">>) =>
    invoke<void>("update_plugin", { id, patch }),

  // 敏感字段：加解密在 Rust 侧完成，主密钥不出后端（AGENTS §7）
  secureSetSetting: (key: string, value: string) =>
    invoke<void>("secure_set_setting", { key, value }),
  secureGetSetting: (key: string) => invoke<string | null>("secure_get_setting", { key }),
  /** 导出主密钥用于离线备份（忘密会导致敏感字段不可恢复） */
  exportMasterKey: () => invoke<string>("export_master_key"),

  // 数据目录（AGENTS §20）：改目录需重启生效，migrate=true 时先复制现有库
  storageInfo: () => invoke<StorageInfo>("storage_info"),
  storageSetDir: (dir: string | null, migrate: boolean) =>
    invoke<void>("storage_set_dir", { dir, migrate }),
  storageOpenDir: (path?: string | null) =>
    invoke<void>("storage_open_dir", { path: path ?? null }),

  // 进程与托盘（AGENTS §19）
  /** 真正退出程序（走托盘退出同一路径） */
  appQuit: () => invoke<void>("app_quit"),
  /** 把主窗口收进托盘，进程继续驻留 */
  appHideToTray: () => invoke<void>("app_hide_to_tray"),
};
