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

/** 数据根目录下的一个固定子目录（设计文档 §7.1） */
export interface StorageSubDir {
  /** 目录名标识，如 "media" */
  id: string;
  /** 用途说明 */
  label: string;
  /** 绝对路径 */
  path: string;
  /** 是否已存在（惰性创建：没用到就没有） */
  exists: boolean;
  /** 递归占用字节数 */
  size: number;
}

/** 数据存储概况（对应 Rust StorageInfo，AGENTS §20 / 设计文档 §7） */
export interface StorageInfo {
  /** 配置里生效的数据根目录（用户唯一可配项） */
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
  /** 根目录下固定布局的子目录（media / backup / keys / logs） */
  dirs: StorageSubDir[];
  /** 运行日志目录（= `<根目录>/logs`）：用户要看日志得知道去哪儿找 */
  logDir: string;
  /** 日志目录里已有的文件（新的在前）。命名规则见 Rust 侧注释：按生成时间保存 */
  logFiles: LogFileItem[];
}

/** 日志目录里的一个文件（对应 Rust LogFileItem） */
export interface LogFileItem {
  name: string;
  size: number;
  /** unix 秒（修改时间） */
  modified: number;
}

/** 搬迁的一部分（主库 / media / keys），对应 Rust MigrationPart */
export interface MigrationPart {
  label: string;
  files: number;
  skipped: number;
  bytes: number;
}

/**
 * 搬迁结果（对应 Rust MigrationReport，设计文档 §7.3）。
 * `verified` 为 true 表示每个复制过的文件都回读比对过 SHA-256 ——
 * 校验失败时 Rust 侧会整体回滚并直接返回错误，所以这里拿到的必然是验过的。
 */
export interface MigrationReport {
  /** 目标目录；空串 = 本次没发生搬迁 */
  target: string;
  files: number;
  skipped: number;
  bytes: number;
  verified: boolean;
  parts: MigrationPart[];
  /** 一句话说明，可直接展示给用户 */
  note: string;
}

/**
 * 备份快照（对应 Rust BackupItem，设计文档 §7.4）。
 *
 * 🔴 **备份包不含密钥** —— 密钥在 OS 凭据库，从没进过数据目录。
 * 所以 `keyFingerprint` 是恢复前校验用的：本机密钥指纹与它不一致就该先导入 .wbkey。
 */
export interface BackupItem {
  id: string;
  path: string;
  /** unix 秒 */
  createdAt: number;
  /** `YYYYMMDD_HHMMSS`（UTC） */
  utcStamp: string;
  /** 整个快照目录占用 */
  size: number;
  dbBytes: number;
  mediaFiles: number;
  mediaBytes: number;
  /** 数据所用的密钥指纹；空串 = 这份数据没有加密字段 */
  keyFingerprint: string;
  /** 是否为「恢复前自动快照」（不会被常规清理删掉） */
  isPreRestore: boolean;
  /** 缺 manifest 的老备份 / 手工文件：信息不全，但仍可恢复 */
  hasManifest: boolean;
}

/** 备份结果（对应 Rust BackupReport） */
export interface BackupReport {
  id: string;
  path: string;
  dbBytes: number;
  mediaFiles: number;
  mediaBytes: number;
  verified: boolean;
  /** 本次顺带清理掉的老备份数 */
  pruned: number;
}

/**
 * 恢复结果（对应 Rust RestoreReport）。
 * 🔴 `needRestart` 恒为 true：库文件走「待替换」机制，必须重启才真正生效。
 */
export interface RestoreReport {
  /** 恢复前自动留的快照 id（出问题可据此回退） */
  preRestoreId: string;
  dbBytes: number;
  mediaFiles: number;
  /** 备份要求的密钥指纹（空 = 无加密字段） */
  keyFingerprint: string;
  /** 本机当前密钥指纹（空 = 本机没有密钥） */
  localFingerprint: string;
  needRestart: boolean;
}

/** 自动备份开关（设置项 `backup.auto`） */
export type BackupAutoMode = "off" | "on_start";

/**
 * 密钥三态（对应 Rust KeyState，设计文档 §8.5）。
 * `mismatch` / `missing` 都必须**拒绝加解密**，并引导用户导入密钥。
 */
export type KeyState =
  | "first_run"
  | "adopt_existing"
  | "ok"
  | "mismatch"
  | "missing";

/**
 * 密钥状态（对应 Rust KeyStatus，AGENTS §7 / 设计文档 §8）。
 * 只读快照，查询本身不会生成密钥。
 */
export interface KeyStatus {
  /** 本机凭据库中是否已有密钥 */
  exists: boolean;
  /** 三态判定 */
  state: KeyState;
  /** 本机密钥指纹（SHA256 前 8 字节 hex） */
  fingerprint: string | null;
  /** 数据库里记录的指纹 */
  storedFingerprint: string | null;
  /** 凭据库服务名 */
  service: string;
  /** 凭据库账号名 */
  account: string;
  /** 加密算法标识 */
  algorithm: string;
}

/** 导入 .wbkey 的结果 */
export interface ImportKeyResult {
  fingerprint: string;
  state: KeyState;
  /** 是否顶掉了本机原有的另一把密钥 */
  replaced: boolean;
  /** 被顶掉的那把的指纹（未替换时为 null） */
  previousFingerprint: string | null;
}

// ---------- 跨机导入（设计文档 §7.6 / ADR-17） ----------

/** `.wbkey` 的明文头（**不需要口令**即可读，用于先判断「文件选对没有」） */
export interface WbkeyHeader {
  /** 文件自带的密钥指纹 */
  fingerprint: string;
  /** 导出时间（unix 秒，0 = 未记录） */
  created: number;
}

/** 外部备份包的概况（对应 Rust PackInfo）。**只读**，不往磁盘写任何东西。 */
export interface PackInfo {
  path: string;
  /** 登记时用的 id（目录名；非法字符会被规范化） */
  id: string;
  /** 目录名被改动过（会比原名多一个 backup_ 前缀） */
  idAdjusted: boolean;
  /** 有没有 manifest.json */
  hasManifest: boolean;
  format: string;
  utcStamp: string;
  createdAt: number;
  /** 打包时的数据根目录 —— 让用户确认「这确实是我那份」 */
  sourceDir: string;
  appVersion: string;
  /** 这份数据要求哪把钥匙（空 = 没有加密字段 / 没有清单） */
  keyFingerprint: string;
  dbBytes: number;
  mediaFiles: number;
  mediaBytes: number;
  size: number;
}

/**
 * 预检结论。
 * `mismatch` 必须**拦住**流程；`replaces_local_key` 需要用户显式确认才能继续。
 */
export type ImportVerdict =
  | "no_key_needed"
  | "ready"
  | "replaces_local_key"
  | "mismatch";

/** 跨机导入的完整预检结果（对应 Rust Precheck）。全程只读。 */
export interface ImportPrecheck {
  pack: PackInfo;
  providedFingerprint: string;
  providedCreated: number;
  localFingerprint: string;
  storedFingerprint: string;
  verdict: ImportVerdict;
  /** 给用户看的一句话结论 */
  summary: string;
  /** 不阻断流程、但必须让用户看到的提醒 */
  warnings: string[];
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

  // 密钥（设计文档 §8）：主密钥首要存 OS 凭据库，冗余副本是口令加密的 .wbkey
  /** 密钥状态：三态判定 + 指纹（只读，不会触发密钥生成） */
  keyStatus: () => invoke<KeyStatus>("key_status"),
  /** 导出口令加密的可移植密钥文件 .wbkey，返回实际写入路径 */
  keyExportWbkey: (path: string, passphrase: string) =>
    invoke<string>("key_export_wbkey", { path, passphrase }),
  /**
   * 导入 .wbkey：解开后写入本机凭据库，并校验与库中指纹是否一致。
   * 🔴 `replace` 是「替换本机在用密钥」的显式确认，默认 false ——
   * 本机数据锁在另一把钥匙下时，不带这个确认会被直接拒绝（免得把现有密文作废）。
   */
  keyImportWbkey: (path: string, passphrase: string, replace = false) =>
    invoke<ImportKeyResult>("key_import_wbkey", { path, passphrase, replace }),

  // 数据目录（AGENTS §20）：改目录需重启生效
  storageInfo: () => invoke<StorageInfo>("storage_info"),
  /**
   * 设置 / 恢复数据根目录。
   * `migrate = true` 时把主库 + media/ + keys/ 一起搬过去，
   * 每个文件都回读校验 SHA-256，任一失败则整体回滚（Rust 侧不改写配置）。
   */
  storageSetDir: (dir: string | null, migrate: boolean) =>
    invoke<MigrationReport>("storage_set_dir", { dir, migrate }),
  storageOpenDir: (path?: string | null) =>
    invoke<void>("storage_open_dir", { path: path ?? null }),

  // 备份与恢复（设计文档 §7.4）：备份包同时是跨机迁移载体
  /** 立即创建一个快照（含 main db + media/ + manifest.json） */
  backupCreate: () => invoke<BackupReport>("backup_create"),
  /** 列出全部快照（新的在前） */
  backupList: () => invoke<BackupItem[]>("backup_list"),
  backupDelete: (id: string) => invoke<void>("backup_delete", { id }),
  /**
   * 从快照恢复。
   * 🔴 密钥指纹不匹配会被**当场拒绝**（返回错误），请先导入对应的 .wbkey。
   * 成功只代表已就位，必须重启程序才生效。
   */
  backupRestore: (id: string) => invoke<RestoreReport>("backup_restore", { id }),
  /** 打开备份目录（用户据此把快照拷到 U 盘 / 网盘） */
  backupOpenDir: () => invoke<void>("backup_open_dir"),

  // 跨机导入（设计文档 §7.6 / ADR-17）：公司电脑 → 家里笔记本
  // 前三个是**只读预检**，最后一个才动手复制。
  /** 只读 `.wbkey` 的明文头 —— 不需要口令，先判断「文件选对没有」 */
  wbkeyInspect: (path: string) => invoke<WbkeyHeader>("wbkey_inspect", { path }),
  /** 读一个外部备份包目录（只读）：它要求哪把钥匙、装了些什么 */
  importInspect: (dir: string) => invoke<PackInfo>("import_inspect", { dir }),
  /** 完整预检（只读）：解密钥 + 比对指纹 + 给判定；不匹配时返回 verdict 而非抛错 */
  importPrecheck: (dir: string, wbkeyPath: string, passphrase: string) =>
    invoke<ImportPrecheck>("import_precheck", { dir, wbkeyPath, passphrase }),
  /** 把外部备份包校验复制进本机 backup/ 并登记成一份本地快照 */
  importAdopt: (dir: string) => invoke<BackupItem>("import_adopt", { dir }),

  // 进程与托盘（AGENTS §19）
  /** 真正退出程序（走托盘退出同一路径） */
  appQuit: () => invoke<void>("app_quit"),
  /** 把主窗口收进托盘，进程继续驻留 */
  appHideToTray: () => invoke<void>("app_hide_to_tray"),
};
