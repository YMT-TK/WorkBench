// 数据根目录迁移（AGENTS §5「迁移 / 备份 / 导出」、设计文档 §7.3）。
//
// 与 `commands/storage.rs` 的分工：
//   - `storage.rs` 只管「目录在哪 / 概况 / 打开目录」；
//   - 本文件只管「把数据搬过去」。
// 拆开的理由：迁移是本仓库**最危险**的一段路径（写用户磁盘 + 改指向），
// 它值得独立文件、独立测试，而不是混在概况查询里。
//
// ## 三条安全约定
// 1. 🔴 **只复制不删除**：旧目录原样保留，用户可自行清理或回退。
// 2. 🔴 **任一文件校验失败 → 整体回滚**：凭 `CopyOutcome.created` 清单只删本次新建的，
//    目标目录里原有文件一个都不碰；并且**不改写配置**（不重指向）。
// 3. 🔴 **目标已有 `workbench.db` → 直接拒绝**（ADR-18）：这时「以谁为准」没有安全答案。
//    静默跳过会骗人（提示成功、重启后是旧数据），覆盖可能毁掉目标那份。
//    拒绝是唯一不会造成损失的选择。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

use crate::db::DbState;
use crate::{fsutil, storage};

/// 搬迁的一部分（主库 / media / keys），用于向用户报告。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPart {
    pub label: String,
    pub files: u64,
    pub skipped: u64,
    pub bytes: u64,
}

/// 搬迁结果：搬了多少、跳过多少、**是否全部通过哈希校验**。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    /// 目标目录（空串 = 本次没发生搬迁）
    pub target: String,
    pub files: u64,
    pub skipped: u64,
    pub bytes: u64,
    /// 每个复制过的文件都回读比对过 SHA-256（false 不会出现：失败直接返回错误）
    pub verified: bool,
    pub parts: Vec<MigrationPart>,
    /// 给用户的一句话说明
    pub note: String,
}

/// 目标目录里是否已经躺着一份主库。
/// 判定用「文件存在」而非「目录非空」：目录里只有 media/ 或 keys/ 时照常可以搬。
pub fn has_existing_db(dir: &Path) -> bool {
    dir.join(storage::DB_FILE).is_file()
}

/// 拒绝迁移时给用户看的说明（把「怎么解决」也写进去，别只报错）。
pub fn conflict_message(dir: &Path) -> String {
    format!(
        "目标目录里已经有一份主库：{}\n\
         迁移会与它冲突，而且没法安全判断该以哪一份为准，所以本次没有搬任何文件，\
         也没有改动你的数据目录设置。\n\
         请换一个空目录，或先把那份旧库挪走（改名/移走都可以）再试。",
        dir.join(storage::DB_FILE).display()
    )
}

/// 执行搬迁：主库（含 WAL 附属文件）+ `media/` + `keys/`。
///
/// 调用方负责「目标无同名主库」的前置校验（见 [`has_existing_db`]）。
/// 返回 `(各部分的明细, 合计统计)`。
pub fn run(
    app: &AppHandle,
    db: &DbState,
    db_path: &Path,
    target: &Path,
) -> Result<(Vec<MigrationPart>, fsutil::CopyStat), String> {
    let mut created: Vec<PathBuf> = Vec::new();
    let result = run_inner(app, db, db_path, target, &mut created);
    if result.is_err() {
        // 只删本次新建的：目标目录里原本就有的文件一个都不碰。
        fsutil::rollback(&created);
    }
    result
}

fn run_inner(
    app: &AppHandle,
    db: &DbState,
    db_path: &Path,
    target: &Path,
    created: &mut Vec<PathBuf>,
) -> Result<(Vec<MigrationPart>, fsutil::CopyStat), String> {
    let mut all = fsutil::CopyStat::default();
    let mut parts = Vec::new();

    // WAL 先归并进主库，否则搬过去的是缺最近事务的库（AGENTS §6.3）。
    crate::db::checkpoint_wal(db)?;

    // 主库 + WAL 附属文件（`-wal` / `-shm`）
    let mut db_stat = fsutil::CopyStat::default();
    for src in std::iter::once(db_path.to_path_buf()).chain(storage::db_sidecars(db_path)) {
        if !src.exists() {
            continue;
        }
        let name = src.file_name().ok_or("库路径非法")?.to_os_string();
        // overwrite=false：即便前置校验已经排除了同名主库，也不允许覆盖任何既有文件。
        let out = fsutil::copy_file_verified(&src, &target.join(name), false)?;
        db_stat.add(out.stat);
        created.extend(out.created);
    }
    parts.push(MigrationPart {
        label: "主库（含 WAL 附属文件）".into(),
        files: db_stat.files,
        skipped: db_stat.skipped,
        bytes: db_stat.bytes,
    });
    all.add(db_stat);

    // media/ 与 keys/ —— 换目录 / 换机都必须带上，否则媒体与 .wbkey 会留在旧地方。
    for (src, label) in [
        (storage::media_dir(app)?, "media/ 媒体文件"),
        (storage::keys_dir(app)?, "keys/ 密钥文件"),
    ] {
        if !src.is_dir() {
            continue;
        }
        let name = src.file_name().ok_or("目录路径非法")?.to_os_string();
        let out = fsutil::copy_dir_verified(&src, &target.join(name), false)?;
        parts.push(MigrationPart {
            label: label.into(),
            files: out.stat.files,
            skipped: out.stat.skipped,
            bytes: out.stat.bytes,
        });
        all.add(out.stat);
        created.extend(out.created);
    }

    log::info!("migrated {} file(s) to {target:?}, all verified", all.files);
    Ok((parts, all))
}

/// 组装给用户看的一句话结论（`migrated = false` 表示只是改了配置、没搬东西）。
pub fn note_for(migrated: bool, stat: &fsutil::CopyStat) -> String {
    if !migrated {
        return "已保存数据根目录，重启程序后生效".to_string();
    }
    if stat.files == 0 && stat.skipped > 0 {
        return "目标目录已有同名内容，未覆盖任何文件（避免不可逆覆盖）".to_string();
    }
    if stat.files == 0 {
        return "没有需要搬迁的内容".to_string();
    }
    format!(
        "已复制 {} 个文件并通过 SHA-256 校验{}",
        stat.files,
        if stat.skipped > 0 {
            format!("，{} 个因目标已存在而跳过", stat.skipped)
        } else {
            String::new()
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("workbench-migrate-{tag}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("创建临时目录");
        d
    }

    #[test]
    fn empty_target_is_migratable() {
        let dir = tmp_dir("empty");
        assert!(!has_existing_db(&dir), "空目录不该被判为已有主库");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn target_with_only_media_is_still_migratable() {
        // 目录非空但只是 media/，没有主库 —— 此时没有「以谁为准」的歧义，可以搬。
        let dir = tmp_dir("media-only");
        std::fs::create_dir_all(dir.join(storage::DIR_MEDIA)).unwrap();
        std::fs::write(dir.join(storage::DIR_MEDIA).join("a.bin"), b"x").unwrap();
        assert!(!has_existing_db(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn target_with_existing_db_is_refused() {
        let dir = tmp_dir("has-db");
        std::fs::write(dir.join(storage::DB_FILE), b"old").unwrap();
        assert!(has_existing_db(&dir), "有主库时必须是拒绝信号");

        // 拒绝文案必须包含冲突路径与「怎么办」，否则用户只会看到一句无用的报错。
        let msg = conflict_message(&dir);
        assert!(msg.contains("workbench.db"));
        assert!(msg.contains("空目录"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn note_distinguishes_skipped_from_copied() {
        let mut stat = fsutil::CopyStat::default();
        stat.skipped = 2;
        assert!(note_for(true, &stat).contains("未覆盖"));
        stat.files = 3;
        assert!(note_for(true, &stat).contains("已复制 3 个文件"));
        assert!(note_for(false, &stat).contains("重启"));
    }
}
