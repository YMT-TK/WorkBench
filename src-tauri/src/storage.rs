// 数据目录解析（AGENTS §20）。
//
// 默认数据目录是 `app_data_dir()/WorkBench`（Windows 下即
// `%APPDATA%/com.workbench.app/WorkBench`）。用户可能希望把库放到
// 别的盘 / 移动硬盘，于是引入一个**引导配置文件** `storage.json`：
//
//   { "dataDir": "D:\\WorkBenchData" }   // 缺省或空串 = 用默认目录
//
// ⚠️ 引导文件本身必须留在**默认**数据区：如果它跟着自定义目录走，
// 用户一旦改了路径，下次启动就找不到这份配置，等于无法回退。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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
