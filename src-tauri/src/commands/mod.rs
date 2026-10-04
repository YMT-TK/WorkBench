// 前端唯一可调用的后端命令层（AGENTS §3 规约 5：前端不直接碰数据库/文件系统）。
//
// 命令与前端 `src/core/shared/api/index.ts` 一一对应：
//   get_setting / set_setting / list_plugins / update_plugin
//   进程与托盘：app_quit / app_hide_to_tray
//   数据目录：见子模块 `storage`
//
// 错误统一以 String 返回（Result<T, String>），前端 try/catch 后 notify('error') + 写日志。

pub mod storage;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::db::DbState;

/// 插件行（对应 plugins 表），字段名与前端 PluginState 对齐。
#[derive(Serialize)]
pub struct PluginRow {
    pub id: String,
    pub kind: String,
    pub enabled: i64,
    pub sort: i64,
    pub config: String,
}

/// 读取一个设置项；不存在返回 None。
#[tauri::command]
pub fn get_setting(state: State<'_, DbState>, key: String) -> Result<Option<String>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// 写入/更新一个设置项（变更即落库，AGENTS §6.4）。
#[tauri::command]
pub fn set_setting(state: State<'_, DbState>, key: String, value: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at)
         VALUES (?1, ?2, strftime('%s', 'now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 列出全部已注册插件（按 sort 降序，越大越靠前）。
#[tauri::command]
pub fn list_plugins(state: State<'_, DbState>) -> Result<Vec<PluginRow>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, kind, enabled, sort, config FROM plugins ORDER BY sort DESC, id ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(PluginRow {
                id: row.get(0)?,
                kind: row.get(1)?,
                enabled: row.get(2)?,
                sort: row.get(3)?,
                config: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// 更新插件的部分字段（enabled / sort / config），不存在则先登记。
#[derive(Deserialize, Default)]
pub struct PluginPatch {
    pub enabled: Option<i64>,
    pub sort: Option<i64>,
    pub config: Option<String>,
    pub kind: Option<String>,
}

#[tauri::command]
pub fn update_plugin(
    state: State<'_, DbState>,
    id: String,
    patch: PluginPatch,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    // 先确保行存在（首次登记），已存在则忽略。
    conn.execute(
        "INSERT OR IGNORE INTO plugins (id, kind) VALUES (?1, ?2)",
        params![id, patch.kind.as_deref().unwrap_or("widget")],
    )
    .map_err(|e| e.to_string())?;

    // 仅更新 patch 中显式给出的字段（COALESCE 保留原值），变更即落库。
    conn.execute(
        "UPDATE plugins SET
             enabled    = COALESCE(?2, enabled),
             sort       = COALESCE(?3, sort),
             config     = COALESCE(?4, config),
             updated_at = strftime('%s', 'now')
         WHERE id = ?1",
        params![id, patch.enabled, patch.sort, patch.config],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- 敏感字段：加密读写（AGENTS §7 方案 A） ----------

/// 加密写入：明文先经 AES-256-GCM 加密再落库，主密钥不出 Rust 侧。
#[tauri::command]
pub fn secure_set_setting(
    state: State<'_, DbState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let encrypted = crate::crypto::encrypt(&value)?;
    set_setting(state, key, encrypted)
}

/// 加密读取：取出密文解密后返回明文；不存在返回 None。
#[tauri::command]
pub fn secure_get_setting(
    state: State<'_, DbState>,
    key: String,
) -> Result<Option<String>, String> {
    match get_setting(state, key)? {
        Some(encrypted) => Ok(Some(crate::crypto::decrypt(&encrypted)?)),
        None => Ok(None),
    }
}

/// 导出主密钥（base64）供用户离线备份，避免忘密死锁（AGENTS §7）。
#[tauri::command]
pub fn export_master_key() -> Result<String, String> {
    crate::crypto::export_key()
}

// ---------- 进程与托盘（AGENTS §19） ----------

/// 真正退出程序。**必须**先置「主动退出」标志，
/// 否则窗口的 `CloseRequested` 拦截会把退出流程自己拦下，导致关不掉。
#[tauri::command]
pub fn app_quit(app: AppHandle) {
    crate::tray::mark_quitting();
    app.exit(0);
}

/// 把主窗口收进托盘（进程继续驻留，不做退出）。
#[tauri::command]
pub fn app_hide_to_tray(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    window.hide().map_err(|e| e.to_string())
}
