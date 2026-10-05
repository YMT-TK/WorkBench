//! WorkBench 平台**运行时能力**（AGENTS §3 规约 7 / §21）。
//!
//! 这里放「平台能做什么」：字段加密与可移植密钥、带校验的复制、备份与恢复、
//! 换数据根目录的搬迁、跨机导入、窗口 bounds 持久化、系统托盘 —— 以及
//! [`commands`] 里对应的 `#[tauri::command]` 门面。
//!
//! 🔴 全部与业务无关。判据是：**换个完全不相干的业务，这些代码能原样用吗？**
//! 不能，就说明它该在 `src/modules/` 里，而不是这里。
//!
//! 🔴 依赖方向：本 crate 只依赖 `wb-db`，⛔ 绝不反向依赖应用壳（AGENTS §21.2）。

pub mod backup;
pub mod commands;
pub mod crypto;
pub mod fsutil;
pub mod migrate;
pub mod transfer;
pub mod tray;
pub mod window_state;

// ---------- 命令函数在 crate 根再导出（AGENTS §21.4）----------
//
// 🔴 **必须**在这里（crate 根）再导出 —— 在命令模块内部再导出是行不通的。
//
// 原因（已读 `tauri-macros` 源码 + rust issue #52234 确认）：
// `generate_handler![wb_runtime::get_setting]` 会把末段换成 `__cmd__` 前缀，实际生成
// `wb_runtime::__cmd__get_setting!(wb_runtime::get_setting, invoke)` —— **两条路径都得解析**。
// 而 `#[tauri::command]` 生成的 `__cmd__*` 是 `#[macro_export]` 的，只落在 **crate 根**；
// 且「macro-expanded 的 macro_export 宏」在**同一个 crate 内**既不能用绝对路径（`crate::`）
// 也不能用相对路径（`super::`）被 `use` 引用 —— 实测两种都报 `cannot determine resolution`。
// 唯一可行的做法：**让函数也待在 crate 根**，与宏同处一地；跨 crate 引用没有这个限制。
//
// 📌 应用壳因此写 `wb_runtime::get_setting`（而非 `wb_runtime::commands::get_setting`）。
// IPC 命令名只取路径末段，所以前端 `invoke("get_setting")` 不受影响。
pub use commands::{
    app_hide_to_tray, app_quit, get_setting, key_export_wbkey, key_import_wbkey, key_status,
    list_plugins, secure_get_setting, secure_set_setting, set_setting, update_plugin,
};
pub use commands::backup::{
    backup_create, backup_delete, backup_list, backup_open_dir, backup_restore,
};
pub use commands::storage::{storage_info, storage_open_dir, storage_set_dir};
pub use commands::transfer::{import_adopt, import_inspect, import_precheck, wbkey_inspect};
