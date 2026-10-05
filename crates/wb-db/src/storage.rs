// 存储与目录模型（AGENTS §20 / 设计文档 §7）。
//
// 默认数据根目录是 `app_data_dir()/WorkBench`（Windows 下即
// `%APPDATA%/com.workbench.app/WorkBench`）。用户可能希望把库放到
// 别的盘 / 移动硬盘，于是引入一个**引导配置文件** `storage.json`：
//
//   { "dataDir": "D:\\WorkBenchData" }   // 缺省或空串 = 用默认目录
//
// ⚠️ 引导文件本身必须留在**默认**数据区：如果它跟着自定义目录走，
// 用户一旦改了路径，下次启动就找不到这份配置，等于无法回退。
//
// 🔴 **用户唯一可配的是「根目录」**，其下一切按固定相对布局展开（设计文档 §7.1）：
//
//   <根目录>/workbench.db     主库
//   <根目录>/media/           媒体文件（导入式）
//   <根目录>/backup/          备份产物
//   <根目录>/keys/            密钥用户侧文件（.wbkey / 导出备份）
//   <根目录>/logs/            运行日志
//
// ⛔ 子目录名与拼接**只允许出现在本文件**：别处一律调 `db_path / media_dir / …`，
// 免得日后改布局要满仓库找 join("media")。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 主库文件名（子目录解析的唯一出处）。
pub const DB_FILE: &str = "workbench.db";
/// 媒体目录（导入式文件落这里）。
pub const DIR_MEDIA: &str = "media";
/// 备份产物目录。
pub const DIR_BACKUP: &str = "backup";
/// 密钥用户侧文件目录（`.wbkey` 等；主密钥本身在 OS 凭据库，不在此）。
pub const DIR_KEYS: &str = "keys";
/// 运行日志目录。
pub const DIR_LOGS: &str = "logs";

/// 引导配置内容（键名保持驼峰，方便人工编辑）。
#[derive(Serialize, Deserialize, Default)]
struct StorageConfig {
    #[serde(rename = "dataDir", default, skip_serializing_if = "Option::is_none")]
    data_dir: Option<String>,
}

/// 引导配置文件路径：始终位于默认数据区的 `WorkBench/` 下。
pub fn bootstrap_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("WorkBench").join("storage.json"))
}

/// 默认数据目录（未自定义时使用）。
pub fn default_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("WorkBench"))
}

/// 配置中显式指定的数据目录；未配置 / 空串 / 解析失败均返回 None。
pub fn configured_override(app: &AppHandle) -> Option<PathBuf> {
    let path = bootstrap_path(app).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    let cfg: StorageConfig = serde_json::from_str(&text).ok()?;
    cfg.data_dir
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// 当前生效的数据目录：有自定义则用之，否则默认。
pub fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    match configured_override(app) {
        Some(dir) => Ok(dir),
        None => default_root(app),
    }
}

/// 写入 / 清除自定义数据目录（`None` = 恢复默认）。
/// 只负责落盘，目录可写性校验由调用方（command 层）负责。
pub fn set_override(app: &AppHandle, dir: Option<String>) -> Result<(), String> {
    let path = bootstrap_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let cfg = StorageConfig {
        data_dir: dir.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
    };
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("写入存储配置失败：{e}"))
}

// ---------- 根目录下的固定相对布局（设计文档 §7.1） ----------
//
// 这几个函数是子目录的**唯一出处**。⛔ 别在别处手拼 `root.join("media")`。
//
// 说明：`backup_dir` / `media_dir` / `media_module_dir` 目前尚无调用方 ——
// 它们是「固定布局」的 API 面，将由后续任务消费（一键备份 → #38、音频模块 → #40）。
// 先固定下来，免得各模块到时各拼各的路径。

/// 主库绝对路径 `<根目录>/workbench.db`。
pub fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_root(app)?.join(DB_FILE))
}

/// 「从备份恢复」的待替换库文件 `<根目录>/workbench.db.restore-pending`。
///
/// 🔴 为什么恢复不直接覆盖 `workbench.db`：进程正持有连接，此时覆盖库文件，
/// 而旁边还留着**属于旧库的** `-wal` / `-shm` —— SQLite 一旦把这个 WAL
/// 回放到换过的库上就是库损坏。而且 Windows 上被打开的文件删不掉、改不了名。
/// 所以改成「写一份待替换文件 → 重启 → 启动早期（还没有任何连接时）完成交换」，
/// 那时删 `-wal` / `-shm` 才是安全的。
pub fn restore_pending_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut name = std::ffi::OsString::from(DB_FILE);
    name.push(".restore-pending");
    Ok(data_root(app)?.join(name))
}

/// 主库的 WAL 附属文件（`-wal` / `-shm`）。
/// ⚠️ 备份/迁移必须连带复制，恢复/换库前必须先清掉（AGENTS §6.3）。
pub fn db_sidecars(db_path: &std::path::Path) -> Vec<PathBuf> {
    ["-wal", "-shm"]
        .iter()
        .map(|suffix| {
            let mut name = db_path.as_os_str().to_os_string();
            name.push(suffix);
            PathBuf::from(name)
        })
        .collect()
}

/// 运行日志目录 `<根目录>/logs`（设计文档 §7.5：日志跟随根目录）。
pub fn logs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_root(app)?.join(DIR_LOGS))
}

/// 密钥用户侧文件目录 `<根目录>/keys`。
pub fn keys_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_root(app)?.join(DIR_KEYS))
}

/// 备份目录 `<根目录>/backup`（设计文档 §7.4）。
pub fn backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_root(app)?.join(DIR_BACKUP))
}

/// 媒体根目录 `<根目录>/media`。
pub fn media_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_root(app)?.join(DIR_MEDIA))
}

/// 某模块的媒体子目录 `<根目录>/media/<module>`（如 `media/audio`）。
#[allow(dead_code)]
pub fn media_module_dir(app: &AppHandle, module: &str) -> Result<PathBuf, String> {
    let module = module.trim();
    if module.is_empty() || module.contains(['/', '\\', ':']) {
        return Err(format!("非法模块名：{module}"));
    }
    Ok(media_dir(app)?.join(module))
}
