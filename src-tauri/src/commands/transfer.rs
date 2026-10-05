// 跨机导入命令（设计文档 §7.6 / ADR-17）。
//
// 与前端 `src/core/shared/api/index.ts` 的
//   wbkeyInspect / importInspect / importPrecheck / importAdopt
// 一一对应。前端只负责**串顺序与展示**，判定与落盘全在 Rust 侧。
//
// 🔴 前三个命令都是**只读**的：预检阶段绝不在用户磁盘上留下任何东西。
//    真正动手的是 `import_adopt`（复制备份包）与既有的 `key_import_wbkey` / `backup_restore`。

use std::path::Path;

use tauri::{AppHandle, State};

use crate::backup::BackupItem;
use crate::crypto::WbkeyHeader;
use crate::db::DbState;
use crate::transfer::{self, PackInfo, Precheck};

/// 只读 `.wbkey` 的**明文头**（`fp` / `created`）—— **不需要口令**。
/// 用它先判断「文件选对没有」，对上了再向用户要口令。
#[tauri::command]
pub fn wbkey_inspect(path: String) -> Result<WbkeyHeader, String> {
    transfer::wbkey_header(Path::new(path.trim()))
}

/// 读一个外部备份包目录（只读）：它要求哪把钥匙、装了些什么。
#[tauri::command]
pub fn import_inspect(dir: String) -> Result<PackInfo, String> {
    transfer::inspect(Path::new(dir.trim()))
}

/// 完整预检（**只读**）：解密钥 → 比对指纹 → 给判定与提醒。
/// 不匹配时**不会**报错，而是返回 `verdict = "mismatch"`，让界面把原因讲清楚。
#[tauri::command]
pub fn import_precheck(
    state: State<'_, DbState>,
    dir: String,
    wbkey_path: String,
    passphrase: String,
) -> Result<Precheck, String> {
    transfer::precheck(
        &state,
        Path::new(dir.trim()),
        Path::new(wbkey_path.trim()),
        &passphrase,
    )
}

/// 把外部备份包**校验复制**进本机 `<根目录>/backup/<id>`，登记成一份本地快照。
/// 复制完成它才出现在备份列表里，也才能被后续的 `backup_restore` 用上。
#[tauri::command]
pub fn import_adopt(app: AppHandle, dir: String) -> Result<BackupItem, String> {
    transfer::adopt(&app, Path::new(dir.trim()))
}
