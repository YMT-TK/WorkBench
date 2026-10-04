// 数据目录相关命令（AGENTS §20）。
//
// 与前端 `src/core/shared/api/index.ts` 的 storageInfo / storageSetDir / storageOpenDir 对应。
// 前端只拿信息与结果，路径解析、可写性校验、数据搬迁全在 Rust 侧完成。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::db::{DbPathState, DbState};
use crate::storage;

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

    Ok(StorageInfo {
        data_dir: configured.to_string_lossy().to_string(),
        running_dir: running_dir.to_string_lossy().to_string(),
        db_path: running_db.to_string_lossy().to_string(),
        db_size: db_size(&running_db),
        is_custom,
        default_dir: default_dir.to_string_lossy().to_string(),
        pending_dir,
    })
}

/// 设置 / 恢复数据目录。
///
/// - `dir = None` 或空串：恢复默认目录；
/// - `migrate = true`：把当前数据库复制到新目录（先 checkpoint 把 WAL 归并入主库，
///   **只复制不删除**，旧目录原样保留，用户可自行清理或回滚）。
///
/// 目录变更一律**重启后生效**（数据库连接在进程启动时就打开了，没法热切换）。
#[tauri::command]
pub fn storage_set_dir(
    app: AppHandle,
    db: State<'_, DbState>,
    db_path: State<'_, DbPathState>,
    dir: Option<String>,
    migrate: bool,
) -> Result<(), String> {
    let target = dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    // 1) 目标目录准备 + 可写性预检：宁可现在就报错，也别等重启后才发现写不进去。
    let resolved = match &target {
        Some(p) => {
            if !p.is_absolute() {
                return Err("请填写绝对路径，例如 D:\\WorkBenchData".into());
            }
            std::fs::create_dir_all(p).map_err(|e| format!("无法创建目录：{e}"))?;
            let probe = p.join(".workbench-write-test");
            std::fs::write(&probe, b"ok").map_err(|e| format!("目录不可写：{e}"))?;
            let _ = std::fs::remove_file(&probe);
            p.clone()
        }
        None => storage::default_root(&app)?,
    };

    // 2) 可选搬迁：把现有库复制过去（WAL 先归并，避免只搬主库丢最新事务）
    let running_db = db_path.0.clone();
    if migrate && target.is_some() && resolved != running_db.parent().unwrap_or(Path::new("")) {
        if let Ok(conn) = db.0.lock() {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        copy_db_files(&running_db, &resolved)?;
    }

    // 3) 落盘引导配置（None = 清除自定义，回到默认目录）
    storage::set_override(
        &app,
        target.map(|p| p.to_string_lossy().to_string()),
    )
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

/// 复制 `workbench.db` / `-wal` / `-shm` 到目标目录。
/// ⚠️ 目标已存在同名库时**跳过**，绝不覆盖 —— 覆盖等于不可逆的数据毁坏。
fn copy_db_files(from_db: &Path, to_dir: &Path) -> Result<(), String> {
    let Some(name) = from_db.file_name() else {
        return Err("数据库路径非法".into());
    };
    std::fs::create_dir_all(to_dir).map_err(|e| e.to_string())?;

    let dest_main = to_dir.join(name);
    if dest_main.exists() {
        log::info!("target database already exists, skip copy: {dest_main:?}");
        return Ok(());
    }

    for suffix in ["", "-wal", "-shm"] {
        let src = with_suffix(from_db, suffix);
        if !src.exists() {
            continue;
        }
        let dst = to_dir.join(src.file_name().ok_or("路径非法")?);
        std::fs::copy(&src, &dst).map_err(|e| format!("复制 {src:?} 失败：{e}"))?;
    }
    log::info!("database copied to {to_dir:?}");
    Ok(())
}

/// 用系统默认文件管理器打开目录（不引额外插件，三平台各一条命令）。
fn open_in_file_manager(path: &Path) -> Result<(), String> {
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
