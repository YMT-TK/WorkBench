// 备份 / 恢复命令（AGENTS §5「迁移 / 备份 / 导出」、设计文档 §7.4）。
//
// 前端只拿结果与列表，快照内部长什么样、库文件怎么安全替换，全在 Rust 侧决定。
// 与 `src/core/shared/api/index.ts` 的 backupCreate / backupList / backupDelete /
// backupRestore / backupOpenDir 一一对应。

use tauri::{AppHandle, State};

use crate::backup::{self, BackupItem, BackupReport, RestoreReport};
use crate::db::{DbPathState, DbState};

/// 立即创建一个备份快照。
#[tauri::command]
pub fn backup_create(
    app: AppHandle,
    db: State<'_, DbState>,
    db_path: State<'_, DbPathState>,
) -> Result<BackupReport, String> {
    backup::create(&app, &db, &db_path.0)
}

/// 列出全部快照（新的在前）。
#[tauri::command]
pub fn backup_list(app: AppHandle) -> Result<Vec<BackupItem>, String> {
    backup::list(&app)
}

/// 删除一个快照。
#[tauri::command]
pub fn backup_delete(app: AppHandle, id: String) -> Result<(), String> {
    backup::delete(&app, &id)
}

/// 从快照恢复。
///
/// 🔴 成功只代表「已就位」，**必须重启程序**才真正生效（库文件走待替换机制）。
/// 前端拿到结果后要提示重启。
#[tauri::command]
pub fn backup_restore(
    app: AppHandle,
    db: State<'_, DbState>,
    db_path: State<'_, DbPathState>,
    id: String,
) -> Result<RestoreReport, String> {
    backup::restore(&app, &db, &db_path.0, &id)
}

/// 在系统文件管理器里打开备份目录（用户据此把快照拷到 U 盘 / 网盘）。
#[tauri::command]
pub fn backup_open_dir(app: AppHandle) -> Result<(), String> {
    let dir = crate::storage::backup_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败：{e}"))?;
    crate::commands::storage::open_in_file_manager(&dir)
}
