// 备份与恢复（AGENTS §5「迁移 / 备份 / 导出」、设计文档 §7.4）。
//
// ## 三个设计决定
//
// **1. 快照是一个目录，不是一个压缩包。**
//    `backup/backup_<UTC时间戳>/` 内含 `workbench.db`（已 checkpoint 归并 WAL 的完整库）、
//    `media/`（递归）与 `manifest.json`。选目录而非 zip：不引额外依赖，
//    而且用户可以直接打开看、手工拷到 U 盘 —— 这对下面的第 2 点很关键。
//
// **2. 🔴 备份包同时就是跨机迁移载体。**
//    公司电脑 → 家里笔记本，用的就是这份快照。不另造「导出数据包」的概念：
//    否则「备份」与「导出」两条链路逻辑重复，日后必然行为不一致。
//
// **3. 🔴 备份包里不含密钥 —— 所以 manifest 里记密钥指纹。**
//    主密钥在 OS 凭据库，从没进过数据目录，备份自然带不走它。
//    于是把 `SHA256(K)[0..8]`（明文、本身不敏感）写进 manifest，
//    恢复前比对本机密钥：不匹配就**当场拦下**，让用户先导入正确的 `.wbkey`。
//    这把上一轮「换机后敏感字段解不开」的发现，从**事后才知道**提前到**恢复前就拦截**。
//
// ⛔ 目录名一律来自 `storage.rs`；本文件只负责「快照内部长什么样」。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
// `try_state` 来自 Manager trait，必须显式引入。
use tauri::{AppHandle, Manager};

use crate::db::{DbPathState, DbState};
use crate::{crypto, fsutil, storage};

/// 备份清单格式标识（日后改结构靠它做兼容判断）。
pub const FORMAT: &str = "WBBACKUP/1";
/// 正式备份的目录名前缀。
pub const PREFIX: &str = "backup_";
/// 「恢复前自动留的快照」前缀 —— 单独一类，不会被常规清理删掉。
pub const PRE_RESTORE_PREFIX: &str = "prerestore_";
pub const MANIFEST_FILE: &str = "manifest.json";

/// 自动备份开关的设置键：`"off"`（默认）| `"on_start"`。
pub const SETTING_AUTO: &str = "backup.auto";
/// 保留份数的设置键；缺省 [`DEFAULT_KEEP`]。
pub const SETTING_KEEP: &str = "backup.keep";
pub const DEFAULT_KEEP: u64 = 5;

/// 快照里的一个文件（记录大小与哈希，便于用户/程序自查完整性）。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub file: String,
    pub bytes: u64,
    pub sha256: String,
}

/// 快照清单：写进 `manifest.json`，人可读、可 diff。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub format: String,
    pub id: String,
    /// unix 秒
    pub created_at: i64,
    /// `YYYYMMDD_HHMMSS`（UTC），与目录名后缀一致
    pub utc_stamp: String,
    /// 备份来源的数据根目录（换机后回看能知道它来自哪）
    pub source_dir: String,
    pub app_version: String,
    /// 数据所用的密钥指纹；空串 = 这份数据没有加密字段。
    /// ⚠️ 是 `SHA256(K)` 的前 8 字节，**不是密钥本身**，可以明文存。
    pub key_fingerprint: String,
    pub db: Option<FileEntry>,
    pub media_files: u64,
    pub media_bytes: u64,
}

/// 列表项（给前端渲染）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupItem {
    pub id: String,
    pub path: String,
    pub created_at: i64,
    pub utc_stamp: String,
    /// 整个快照目录的占用
    pub size: u64,
    pub db_bytes: u64,
    pub media_files: u64,
    pub media_bytes: u64,
    pub key_fingerprint: String,
    /// 是否为「恢复前自动快照」（这类不会被常规清理删掉）
    pub is_pre_restore: bool,
    /// 缺 manifest 的老备份/手工文件：信息不全，但仍可恢复
    pub has_manifest: bool,
}

/// 备份结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupReport {
    pub id: String,
    pub path: String,
    pub db_bytes: u64,
    pub media_files: u64,
    pub media_bytes: u64,
    /// 全部文件都过了 SHA-256 回读校验（false 不会出现 —— 失败会直接返回错误）
    pub verified: bool,
    /// 本次顺带清理掉的老备份数
    pub pruned: u64,
}

/// 恢复结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    /// 恢复前自动留的快照 id（出问题可据此回退）
    pub pre_restore_id: String,
    pub db_bytes: u64,
    pub media_files: u64,
    /// 备份要求的密钥指纹（空 = 无加密字段）
    pub key_fingerprint: String,
    /// 本机当前密钥指纹（空 = 本机没有密钥）
    pub local_fingerprint: String,
    /// 恒为 true：库文件走「待替换」机制，必须重启才生效
    pub need_restart: bool,
}

// ---------- 内部：设置项与指纹 ----------

/// 数据所用的密钥指纹（读 `app_settings`；缺失返回空串）。
///
/// 注意与「本机密钥指纹」区分：这份是**数据被哪把钥匙锁的**，
/// 恢复时要拿它跟本机持有的钥匙比对。
pub(crate) fn data_fingerprint(db: &DbState) -> String {
    match db.0.lock() {
        Ok(conn) => crate::commands::get_setting_conn(&conn, crypto::FINGERPRINT_SETTING_KEY)
            .unwrap_or_default()
            .unwrap_or_default(),
        Err(_) => String::new(),
    }
}

/// 本机当前持有的密钥指纹（凭据库里没有则空串）。
/// 🔴 只读，绝不建钥 —— 建钥策略只在 `commands::resolve_key`。
pub(crate) fn local_fingerprint() -> String {
    match crypto::load_key() {
        Ok(Some(key)) => crypto::fingerprint(&key),
        _ => String::new(),
    }
}

fn auto_mode(db: &DbState) -> String {
    match db.0.lock() {
        Ok(conn) => crate::commands::get_setting_conn(&conn, SETTING_AUTO)
            .unwrap_or_default()
            .unwrap_or_default(),
        Err(_) => String::new(),
    }
}

fn keep_count(db: &DbState) -> u64 {
    match db.0.lock() {
        Ok(conn) => crate::commands::get_setting_conn(&conn, SETTING_KEEP)
            .unwrap_or_default()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_KEEP),
        Err(_) => DEFAULT_KEEP,
    }
}

// ---------- 内部：路径与校验 ----------

fn backup_root(app: &AppHandle) -> Result<PathBuf, String> {
    storage::backup_dir(app)
}

/// 把前端传来的 id 解析成快照目录。
/// 🔴 必须校验：id 会拼进路径，放任 `../` 之类的输入等于给了一个任意目录删除/读取的口子。
fn resolve_snapshot(root: &Path, id: &str) -> Result<PathBuf, String> {
    let id = id.trim();
    if id.is_empty()
        || id.contains(['/', '\\', ':'])
        || id == "."
        || id == ".."
        || !(id.starts_with(PREFIX) || id.starts_with(PRE_RESTORE_PREFIX))
    {
        return Err(format!("非法备份标识：{id}"));
    }
    let path = root.join(id);
    if !path.is_dir() {
        return Err(format!("备份不存在：{id}"));
    }
    Ok(path)
}

pub(crate) fn read_manifest(snap: &Path) -> Option<BackupManifest> {
    let text = fs::read_to_string(snap.join(MANIFEST_FILE)).ok()?;
    serde_json::from_str::<BackupManifest>(&text).ok()
}

/// 把一个快照目录读成列表项。
///
/// 抽出来是为了让「本地扫描」(`list`) 与「外部备份包登记」(`transfer::adopt`) 用**同一套**
/// 解析规则 —— 两边各写一份，迟早会一边有 manifest 一边没有，用户在列表里就会看到两种格式。
pub(crate) fn item_at(path: &Path, id: String) -> BackupItem {
    let manifest = read_manifest(path);
    BackupItem {
        is_pre_restore: id.starts_with(PRE_RESTORE_PREFIX),
        utc_stamp: manifest
            .as_ref()
            .map(|m| m.utc_stamp.clone())
            .unwrap_or_else(|| id.clone()),
        db_bytes: manifest
            .as_ref()
            .and_then(|m| m.db.as_ref())
            .map(|d| d.bytes)
            .unwrap_or(0),
        media_files: manifest.as_ref().map(|m| m.media_files).unwrap_or(0),
        media_bytes: manifest.as_ref().map(|m| m.media_bytes).unwrap_or(0),
        key_fingerprint: manifest
            .as_ref()
            .map(|m| m.key_fingerprint.clone())
            .unwrap_or_default(),
        has_manifest: manifest.is_some(),
        created_at: manifest
            .as_ref()
            .map(|m| m.created_at)
            .unwrap_or_else(|| mtime_secs(path)),
        size: fsutil::dir_size(path),
        path: path.to_string_lossy().to_string(),
        id,
    }
}

fn mtime_secs(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------- 对外能力 ----------

/// 创建一个备份快照。
pub fn create(app: &AppHandle, db: &DbState, db_path: &Path) -> Result<BackupReport, String> {
    let root = backup_root(app)?;
    fs::create_dir_all(&root).map_err(|e| format!("创建备份目录失败：{e}"))?;

    let now = fsutil::now_secs();
    let base = format!("{PREFIX}{}", fsutil::stamp(now));
    // 秒级精度可能撞车（连续点两次备份），撞了就加序号，绝不覆盖已有快照。
    let mut dir = root.join(&base);
    let mut seq = 1u32;
    while dir.exists() {
        dir = root.join(format!("{base}_{seq}"));
        seq += 1;
    }
    let id = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or(base.clone());

    // 先在临时名下落内容，成功后再「转正」—— 中途失败不会留下半个快照。
    let staging = root.join(format!(".staging-{base}"));
    let built = build_snapshot(app, db, db_path, &staging, &id, now);
    match built {
        Ok((db_entry, media_files, media_bytes)) => {
            fs::rename(&staging, &dir).map_err(|e| format!("快照落位失败：{e}"))?;

            let fingerprint = data_fingerprint(db);
            let manifest = BackupManifest {
                format: FORMAT.into(),
                id: id.clone(),
                created_at: now,
                utc_stamp: fsutil::stamp(now),
                source_dir: storage::data_root(app)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
                app_version: env!("CARGO_PKG_VERSION").into(),
                key_fingerprint: fingerprint.clone(),
                db: Some(db_entry.clone()),
                media_files,
                media_bytes,
            };
            let json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
            fs::write(dir.join(MANIFEST_FILE), json).map_err(|e| format!("写清单失败：{e}"))?;

            log::info!("backup created: {id} (db {} bytes, media {media_files} files)", db_entry.bytes);
            Ok(BackupReport {
                id,
                path: dir.to_string_lossy().to_string(),
                db_bytes: db_entry.bytes,
                media_files,
                media_bytes,
                verified: true,
                pruned: 0,
            })
        }
        Err(err) => {
            let _ = fs::remove_dir_all(&staging);
            Err(err)
        }
    }
}

/// 把库 + 媒体复制到 `dir`（调用方负责失败时清理 / 成功时转正）。
fn build_snapshot(
    app: &AppHandle,
    db: &DbState,
    db_path: &Path,
    dir: &Path,
    _id: &str,
    _now: i64,
) -> Result<(FileEntry, u64, u64), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建快照目录失败：{e}"))?;

    // 1) WAL 归并：否则快照可能缺最近的事务（AGENTS §6.3）。
    crate::db::checkpoint_wal(db)?;

    // 2) 主库 + WAL 附属文件（TRUNCATE 后 -wal 通常为空，但流程上仍要带上）。
    let mut db_bytes = 0u64;
    for src in std::iter::once(db_path.to_path_buf()).chain(storage::db_sidecars(db_path)) {
        if !src.exists() {
            continue;
        }
        let name = src.file_name().ok_or("库路径非法")?.to_os_string();
        let out = fsutil::copy_file_verified(&src, &dir.join(name), true)?;
        db_bytes += out.stat.bytes;
    }
    let db_entry = FileEntry {
        file: storage::DB_FILE.into(),
        bytes: db_bytes,
        sha256: fsutil::sha256_file(&dir.join(storage::DB_FILE)).unwrap_or_default(),
    };

    // 3) media/（不存在就是空操作，不算错误）
    let media = fsutil::copy_dir_verified(
        &storage::media_dir(app)?,
        &dir.join(storage::DIR_MEDIA),
        true,
    )?;

    Ok((
        db_entry,
        media.stat.files,
        media.stat.bytes,
    ))
}

/// 列出全部快照（新的在前）。
pub fn list(app: &AppHandle) -> Result<Vec<BackupItem>, String> {
    let root = backup_root(app)?;
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut items = Vec::new();
    for entry in fs::read_dir(&root)
        .map_err(|e| format!("读取备份目录失败：{e}"))?
        .flatten()
    {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        // staging 是未转正的中间产物，不展示给用户。
        if !id.starts_with(PREFIX) && !id.starts_with(PRE_RESTORE_PREFIX) {
            continue;
        }
        items.push(item_at(&path, id));
    }
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
    Ok(items)
}

/// 删除一个快照。
pub fn delete(app: &AppHandle, id: &str) -> Result<(), String> {
    let root = backup_root(app)?;
    let snap = resolve_snapshot(&root, id)?;
    fs::remove_dir_all(&snap).map_err(|e| format!("删除备份失败：{e}"))
}

/// 从快照恢复。
///
/// 🔴 顺序约定：**先导入密钥，再恢复数据**。指纹不匹配时这里直接拒绝，
/// 而不是让用户恢复完才发现敏感字段全解不开 —— 拒绝本身就是最好的引导。
///
/// 🔴 库文件不直接覆盖 `workbench.db`，而是写成待替换文件，由启动早期的
/// `db::init` 完成交换（原因见 `storage::restore_pending_path` 的注释）。
pub fn restore(
    app: &AppHandle,
    db: &DbState,
    db_path: &Path,
    id: &str,
) -> Result<RestoreReport, String> {
    let root = backup_root(app)?;
    let snap = resolve_snapshot(&root, id)?;
    let manifest = read_manifest(&snap);

    let required = manifest
        .as_ref()
        .map(|m| m.key_fingerprint.clone())
        .unwrap_or_default();
    let local = local_fingerprint();

    // 没有加密字段的备份（空指纹）不构成约束；否则必须本机持有同一把钥匙。
    if !required.is_empty() && required != local {
        return Err(if local.is_empty() {
            format!(
                "本机还没有密钥，无法恢复这份数据。请先导入指纹为 {required} 的 .wbkey，再执行恢复。"
            )
        } else {
            format!(
                "密钥不匹配：这份数据需要指纹 {required} 的密钥，本机持有的是 {local}。\
                 请先导入对应的 .wbkey 再恢复 —— 否则加密字段将全部无法解开。"
            )
        });
    }

    let src_db = snap.join(storage::DB_FILE);
    if !src_db.exists() {
        return Err("这份备份里没有主库文件，无法恢复".into());
    }

    // 1) 先给「恢复前」的状态留一份快照 —— 恢复搞砸了还能退回来。
    let pre = create_pre_restore(app, db, db_path)?;

    // 2) 主库 → 待替换文件（重启时交换）
    let pending = storage::restore_pending_path(app)?;
    let out = fsutil::copy_file_verified(&src_db, &pending, true)?;

    // 3) media/ 可以立刻覆盖：没有连接持有它们。
    let media = fsutil::copy_dir_verified(
        &snap.join(storage::DIR_MEDIA),
        &storage::media_dir(app)?,
        true,
    )?;

    log::info!("restore staged from {id}: pre-restore snapshot {}", pre.id);
    Ok(RestoreReport {
        pre_restore_id: pre.id,
        db_bytes: out.stat.bytes,
        media_files: media.stat.files,
        key_fingerprint: required,
        local_fingerprint: local,
        need_restart: true,
    })
}

/// 恢复前的自动快照：用 `prerestore_` 前缀，不会被常规清理删掉。
fn create_pre_restore(
    app: &AppHandle,
    db: &DbState,
    db_path: &Path,
) -> Result<BackupReport, String> {
    let root = backup_root(app)?;
    fs::create_dir_all(&root).map_err(|e| format!("创建备份目录失败：{e}"))?;
    let now = fsutil::now_secs();
    let id = format!("{PRE_RESTORE_PREFIX}{}", fsutil::stamp(now));
    let dir = root.join(&id);
    let staging = root.join(format!(".staging-{id}"));

    match build_snapshot(app, db, db_path, &staging, &id, now) {
        Ok((db_entry, media_files, media_bytes)) => {
            fs::rename(&staging, &dir).map_err(|e| format!("快照落位失败：{e}"))?;
            let manifest = BackupManifest {
                format: FORMAT.into(),
                id: id.clone(),
                created_at: now,
                utc_stamp: fsutil::stamp(now),
                source_dir: storage::data_root(app)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
                app_version: env!("CARGO_PKG_VERSION").into(),
                key_fingerprint: data_fingerprint(db),
                db: Some(db_entry.clone()),
                media_files,
                media_bytes,
            };
            if let Ok(json) = serde_json::to_string_pretty(&manifest) {
                let _ = fs::write(dir.join(MANIFEST_FILE), json);
            }
            Ok(BackupReport {
                id,
                path: dir.to_string_lossy().to_string(),
                db_bytes: db_entry.bytes,
                media_files,
                media_bytes,
                verified: true,
                pruned: 0,
            })
        }
        Err(err) => {
            let _ = fs::remove_dir_all(&staging);
            Err(err)
        }
    }
}

/// 按保留份数清理最老的**正式**备份。
/// ⚠️ `prerestore_` 快照不动 —— 它是恢复操作的安全网，只能用户手动删。
pub fn prune(app: &AppHandle, keep: u64) -> Result<u64, String> {
    let mut items = list(app)?;
    items.retain(|i| !i.is_pre_restore);
    if items.len() <= keep as usize {
        return Ok(0);
    }
    let mut removed = 0u64;
    for item in items.into_iter().skip(keep as usize) {
        if fs::remove_dir_all(PathBuf::from(&item.path)).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        log::info!("pruned {removed} old backup(s), keeping {keep}");
    }
    Ok(removed)
}

/// 启动时按设置执行自动备份（在后台线程里跑，不拖慢启动）。
pub fn run_auto_if_enabled(app: &AppHandle) {
    let Some(db) = app.try_state::<DbState>() else {
        return;
    };
    let Some(db_path) = app.try_state::<DbPathState>() else {
        return;
    };
    if auto_mode(&db) != "on_start" {
        return;
    }
    let keep = keep_count(&db);
    let handle = app.clone();
    let db_file = db_path.0.clone();
    // 复制文件可能耗时（媒体多），放进后台线程 —— 但**不持有数据库连接**（AGENTS §5.x）。
    std::thread::spawn(move || {
        let Some(db) = handle.try_state::<DbState>() else {
            return;
        };
        match create(&handle, &db, &db_file) {
            Ok(report) => {
                log::info!("auto backup created: {}", report.id);
                if let Err(e) = prune(&handle, keep) {
                    log::error!("auto backup prune failed: {e}");
                }
            }
            Err(e) => log::error!("auto backup failed: {e}"),
        }
    });
}
