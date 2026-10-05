// 数据目录相关命令（AGENTS §20）。
//
// 与前端 `src/core/shared/api/index.ts` 的 storageInfo / storageSetDir / storageOpenDir 对应。
// 前端只拿信息与结果，路径解析、可写性校验、数据搬迁全在 Rust 侧完成。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::migrate as migrate_cmd;
use wb_db::db::{DbPathState, DbState};
use wb_db::storage;

use crate::fsutil;

/// 数据存储概况（字段驼峰，直接给前端用）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    /// 配置里生效的数据目录（改过就是自定义目录）
    pub data_dir: String,
    /// 本次进程实际打开数据库的目录
    pub running_dir: String,
    /// 运行中的数据库文件绝对路径
    pub db_path: String,
    /// 数据库三件套（.db / -wal / -shm）合计字节数
    pub db_size: u64,
    /// 是否使用了自定义目录
    pub is_custom: bool,
    /// 默认数据目录（用于「恢复默认」提示）
    pub default_dir: String,
    /// 配置已改但需重启才生效时的目标目录；无需重启则为 null
    pub pending_dir: Option<String>,
    /// 根目录下的固定相对布局（设计文档 §7.1）：子目录 + 占用字节数。
    /// ⛔ 这些路径只在 Rust 侧解析，前端只负责展示与「打开」。
    pub dirs: Vec<StorageSubDir>,
    /// 运行日志目录（= `<根目录>/logs`）。
    /// 用户要看日志就得知道去哪儿找 —— 这里把地址给出来，页面里不另做日志浏览。
    pub log_dir: String,
    /// 日志目录里已有的文件（新的在前，最多 20 个）。
    /// 命名规则：`workbench.log` 是当前文件，超过 5MB 滚动为
    /// `workbench_<YYYY-MM-DD_HH-MM-SS>.log` —— **按生成时间保存**，保留最近 10 份。
    pub log_files: Vec<LogFileItem>,
}

/// 日志文件目录里的一个文件。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileItem {
    pub name: String,
    pub size: u64,
    /// unix 秒（修改时间）
    pub modified: i64,
}

/// 根目录下的一个固定子目录。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSubDir {
    /// 相对路径标识（即目录名，如 "media"）
    pub id: String,
    /// 用途说明（面向用户）
    pub label: String,
    /// 绝对路径
    pub path: String,
    /// 是否存在（惰性创建：没用到就没有）
    pub exists: bool,
    /// 递归占用的字节数
    pub size: u64,
}

/// 统计数据库文件占用：WAL 模式下数据可能在 -wal / -shm 里，必须一起算（AGENTS §6.3）。
fn db_size(db_path: &Path) -> u64 {
    let mut total = 0u64;
    for suffix in ["", "-wal", "-shm"] {
        let p = with_suffix(db_path, suffix);
        if let Ok(meta) = std::fs::metadata(&p) {
            total += meta.len();
        }
    }
    total
}

/// `workbench.db` + `-wal` → `workbench.db-wal`
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    if suffix.is_empty() {
        return path.to_path_buf();
    }
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

/// 递归统计目录占用（目录不存在记 0）。
fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            total += dir_size(&entry.path());
        } else {
            total += meta.len();
        }
    }
    total
}

/// 组装根目录下的固定子目录清单（设计文档 §7.1）。
fn sub_dirs(app: &AppHandle) -> Vec<StorageSubDir> {
    let specs = [
        (storage::DIR_MEDIA, "媒体文件（导入式）"),
        (storage::DIR_BACKUP, "备份产物"),
        (storage::DIR_KEYS, "密钥文件与导出备份"),
        (storage::DIR_LOGS, "运行日志"),
    ];
    let root = storage::data_root(app).ok();
    specs
        .into_iter()
        .filter_map(|(id, label)| {
            let path = root.as_ref()?.join(id);
            Some(StorageSubDir {
                id: id.to_string(),
                label: label.to_string(),
                exists: path.is_dir(),
                size: dir_size(&path),
                path: path.to_string_lossy().to_string(),
            })
        })
        .collect()
}

/// 列出日志目录里的文件（新的在前）。
///
/// 日志由 `tauri-plugin-log` 写，当前文件 `workbench.log`，滚动后按生成时间命名。
/// 这里只做**只读列举**，不提供日志浏览页面 —— 用户拿地址自己去看文件即可。
fn log_files(dir: &Path) -> Vec<LogFileItem> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut items: Vec<LogFileItem> = entries
        .flatten()
        .filter(|e| e.path().is_file())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".log") {
                return None;
            }
            let meta = e.metadata().ok()?;
            Some(LogFileItem {
                name,
                size: meta.len(),
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0),
            })
        })
        .collect();
    items.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| b.name.cmp(&a.name)));
    items.truncate(20);
    items
}

/// 读取存储概况。
#[tauri::command]
pub fn storage_info(app: AppHandle, db_path: State<'_, DbPathState>) -> Result<StorageInfo, String> {
    let configured = storage::data_root(&app)?;
    let default_dir = storage::default_root(&app)?;
    let running_db = db_path.0.clone();
    let running_dir = running_db
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| default_dir.clone());

    let is_custom = configured != default_dir;
    let pending_dir = if configured != running_dir {
        Some(configured.to_string_lossy().to_string())
    } else {
        None
    };

    let logs = storage::logs_dir(&app)?;
    Ok(StorageInfo {
        data_dir: configured.to_string_lossy().to_string(),
        running_dir: running_dir.to_string_lossy().to_string(),
        db_path: running_db.to_string_lossy().to_string(),
        db_size: db_size(&running_db),
        is_custom,
        default_dir: default_dir.to_string_lossy().to_string(),
        pending_dir,
        dirs: sub_dirs(&app),
        log_files: log_files(&logs),
        log_dir: logs.to_string_lossy().to_string(),
    })
}

// 迁移相关的类型与实现见 `commands/migrate.rs` —— 本文件只管「目录在哪 / 概况 / 打开目录」。

/// 设置 / 恢复数据目录。
///
/// - `dir = None` 或空串：恢复默认目录；
/// - `migrate = true`：把**主库 + media/ + keys/** 一起搬到新目录
///   （先 checkpoint 归并 WAL，逐个文件复制并**回读校验 SHA-256**，
///   **只复制不删除**，旧目录原样保留，用户可自行清理或回滚）。
///
/// 🔴 校验失败 = 整体回滚：删掉本次新建的文件，并且**不改写配置**（也就是不重指向）。
/// 半份数据比不搬家更糟 —— 与其让用户重启到一个坏库，不如原地报错。
/// 🔴 **目标已有 `workbench.db` = 直接拒绝**（ADR-18）：静默跳过会骗人（提示成功、
/// 重启后打开的却是目标里的旧库），覆盖可能毁掉目标那份。拒绝时**连配置都不写**。
/// 🔴 为什么必须带上 media/：只搬主库的话，媒体文件会静默丢失，
/// 换机后打开只剩一堆「文件已移动」的灰条目。
///
/// 目录变更一律**重启后生效**（数据库连接在进程启动时就打开了，没法热切换）。
#[tauri::command]
pub fn storage_set_dir(
    app: AppHandle,
    db: State<'_, DbState>,
    db_path: State<'_, DbPathState>,
    dir: Option<String>,
    migrate: bool,
) -> Result<migrate_cmd::MigrationReport, String> {
    let target = dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    // 1) 目标目录解析（此时**还不创建**任何东西）。
    let resolved = match &target {
        Some(p) => {
            if !p.is_absolute() {
                return Err("请填写绝对路径，例如 D:\\WorkBenchData".into());
            }
            p.clone()
        }
        None => storage::default_root(&app)?,
    };

    let running_db = db_path.0.clone();
    let running_dir = running_db.parent().map(Path::to_path_buf);
    let want_migrate =
        migrate && target.is_some() && running_dir.as_deref() != Some(resolved.as_path());

    // 2) 🔴 目标已有一份主库 → 拒绝（ADR-18）。放在**一切写操作之前**：
    // 连可写性探针文件都不写 —— 被拒绝时目标目录必须零痕迹。
    // 静默跳过是更坏的选择：提示「已复制并通过校验」，重启后打开的却是目标里的旧库。
    if want_migrate && migrate_cmd::has_existing_db(&resolved) {
        return Err(migrate_cmd::conflict_message(&resolved));
    }

    // 3) 目标目录准备 + 可写性预检：宁可现在就报错，也别等重启后才发现写不进去。
    //    只在用户显式指定目录时创建 —— 「恢复默认」不该凭空造出一个默认目录。
    if target.is_some() {
        std::fs::create_dir_all(&resolved).map_err(|e| format!("无法创建目录：{e}"))?;
        let probe = resolved.join(".workbench-write-test");
        std::fs::write(&probe, b"ok").map_err(|e| format!("目录不可写：{e}"))?;
        let _ = std::fs::remove_file(&probe);
    }

    // 4) 可选搬迁：主库 + media/ + keys/，逐个校验，失败整体回滚。
    let mut parts = Vec::new();
    let mut stat = fsutil::CopyStat::default();
    let mut migrated = false;
    let mut refused: Option<String> = None;

    if want_migrate {
        let (p, s) = migrate_cmd::run(&app, &db, &running_db, &resolved)?;
        parts = p;
        stat = s;
        migrated = true;
    } else if migrate && target.is_some() {
        // 目标就是当前运行目录 = 原地不动。别报告成「搬迁成功」，那会让用户以为换了地方。
        refused = Some("目标目录与当前数据目录相同，无需搬迁".to_string());
    }

    // 5) 落盘引导配置（None = 清除自定义，回到默认目录）
    storage::set_override(&app, target.map(|p| p.to_string_lossy().to_string()))?;

    let note = refused.unwrap_or_else(|| migrate_cmd::note_for(migrated, &stat));

    Ok(migrate_cmd::MigrationReport {
        target: if migrated {
            resolved.to_string_lossy().to_string()
        } else {
            String::new()
        },
        files: stat.files,
        skipped: stat.skipped,
        bytes: stat.bytes,
        verified: true,
        parts,
        note,
    })
}

/// 在系统文件管理器里打开数据目录（缺省 = 当前生效目录）。
#[tauri::command]
pub fn storage_open_dir(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let target = match path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => storage::data_root(&app)?,
    };
    let _ = std::fs::create_dir_all(&target);
    open_in_file_manager(&target)
}

/// 用系统默认文件管理器打开目录（不引额外插件，三平台各一条命令）。
pub(crate) fn open_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";

    std::process::Command::new(program)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开目录失败：{e}"))
}
