// 文件复制与校验工具（备份 §7.4 / 迁移 §7.3 共用）。
//
// 为什么单独抽一层：**备份和迁移的本质都是「把数据库搬到别处」**，
// 而搬数据库最怕的是「复制了一半、静默损坏、很久以后才发现」。
// 所以这里统一约定：**复制后必须回读比对 SHA-256**，不一致即视为失败并清理目标。
//
// 另一个约定：所有复制都返回「本次新建了哪些文件」（`CopyOutcome.created`）。
// 迁移场景要求「任一文件校验失败 → 整体回滚」，没有这份清单就撤不干净。
//
// ⛔ 本文件只处理「给定路径 → 给定路径」的搬运，**不拼任何子目录名** ——
// 目录名一律来自 `storage.rs`（AGENTS §5 / 设计文档 §7.1）。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// 一次搬运的统计（用于向用户报告「搬了多少、跳过多少」）。
#[derive(Debug, Default, Clone, Copy)]
pub struct CopyStat {
    /// 实际写入的文件数
    pub files: u64,
    /// 因目标已存在而跳过的文件数（迁移场景下「绝不覆盖」是硬性要求）
    pub skipped: u64,
    /// 写入的总字节数
    pub bytes: u64,
}

impl CopyStat {
    pub fn add(&mut self, other: CopyStat) {
        self.files += other.files;
        self.skipped += other.skipped;
        self.bytes += other.bytes;
    }
}

/// 搬运结果：统计 + 本次新建的文件清单（用于失败回滚）。
#[derive(Debug, Default)]
pub struct CopyOutcome {
    pub stat: CopyStat,
    /// 本次**新建**的文件（跳过的、原本就有的不在其中）。
    /// 校验失败时调用方据这份清单 `rollback`，只删自己建的东西。
    pub created: Vec<PathBuf>,
}

/// 流式计算文件 SHA-256（十六进制小写）。
/// ⚠️ 不整体读进内存：媒体文件可能有几百 MB。
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("读取 {path:?} 失败：{e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("读取 {path:?} 失败：{e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 复制单个文件，并**回读目标比对哈希**。
///
/// - `overwrite = false` 且目标已存在 → 跳过（迁移场景：绝不覆盖用户已有数据）；
/// - 校验不一致 → 删除刚写入的目标文件，返回错误（不留半个坏文件）。
pub fn copy_file_verified(src: &Path, dst: &Path, overwrite: bool) -> Result<CopyOutcome, String> {
    let mut out = CopyOutcome::default();
    copy_file_rec(src, dst, overwrite, &mut out)?;
    Ok(out)
}

/// 递归复制目录，逐文件校验。目录不存在视为空操作。
pub fn copy_dir_verified(src: &Path, dst: &Path, overwrite: bool) -> Result<CopyOutcome, String> {
    let mut out = CopyOutcome::default();
    copy_dir_rec(src, dst, overwrite, &mut out)?;
    Ok(out)
}

fn copy_file_rec(
    src: &Path,
    dst: &Path,
    overwrite: bool,
    out: &mut CopyOutcome,
) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    if dst.exists() && !overwrite {
        out.stat.skipped += 1;
        return Ok(());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 {parent:?} 失败：{e}"))?;
    }

    let expected = sha256_file(src)?;
    fs::copy(src, dst).map_err(|e| format!("复制 {src:?} → {dst:?} 失败：{e}"))?;

    let actual = sha256_file(dst)?;
    if actual != expected {
        // 复制成功但内容对不上（磁盘满 / 被别的程序改写 / 传输中断）——
        // 宁可删掉重来，也不能把一个「看起来在、其实是坏的」备份留给用户。
        let _ = fs::remove_file(dst);
        return Err(format!(
            "校验失败：{dst:?} 与源文件不一致（{expected} ≠ {actual}）"
        ));
    }

    out.stat.files += 1;
    out.stat.bytes += fs::metadata(dst).map(|m| m.len()).unwrap_or(0);
    out.created.push(dst.to_path_buf());
    Ok(())
}

fn copy_dir_rec(
    src: &Path,
    dst: &Path,
    overwrite: bool,
    out: &mut CopyOutcome,
) -> Result<(), String> {
    if !src.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(src)
        .map_err(|e| format!("读取目录 {src:?} 失败：{e}"))?
        .flatten()
    {
        let path = entry.path();
        let child = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir_rec(&path, &child, overwrite, out)?;
        } else {
            copy_file_rec(&path, &child, overwrite, out)?;
        }
    }
    Ok(())
}

/// 回滚：删掉本次新建的文件，并尽量清掉因此变空的目录。
///
/// 只删 `created` 里的路径 —— 迁移目标目录里原本就有的文件**一个都不碰**。
pub fn rollback(created: &[PathBuf]) {
    for path in created {
        let _ = fs::remove_file(path);
    }
    // 清掉因此变空的目录（从最深的一层往上试；删不掉说明还有别的内容，留着）。
    let mut dirs: Vec<PathBuf> = created
        .iter()
        .filter_map(|p| p.parent().map(|d| d.to_path_buf()))
        .collect();
    dirs.sort_by(|a, b| b.as_os_str().len().cmp(&a.as_os_str().len()));
    let mut seen: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        if seen.iter().any(|d| *d == dir) {
            continue;
        }
        seen.push(dir.clone());
        // remove_dir 只在目录为空时成功，非空则安静失败 —— 正是我们要的语义。
        let _ = fs::remove_dir(&dir);
    }
}

/// unix 秒 → `YYYYMMDD_HHMMSS`（**UTC**）。
///
/// 备份目录名与迁移报告都要一个可读的时间戳。这里手写 civil-from-days
/// 而不是引 chrono —— 只为格式化一个时间戳引入一个日期库不划算。
/// ⚠️ 统一用 UTC，与 `tauri-plugin-log` 的滚动日志文件名保持一致
/// （插件默认 `TimezoneStrategy::UseUtc`），免得备份与日志对不上时间。
pub fn stamp(secs: i64) -> String {
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!(
        "{:04}{:02}{:02}_{:02}{:02}{:02}",
        y,
        m,
        d,
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Howard Hinnant 的 days → (year, month, day) 算法（1970-01-01 为 epoch）。
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as i64; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 当前 unix 秒。
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 递归统计目录占用（目录不存在记 0）。
pub fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例一个独立临时目录（先清后建，避免上一次的残留影响断言）。
    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("workbench-test-{tag}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).expect("创建临时目录");
        d
    }

    #[test]
    fn copy_file_verified_roundtrip_and_skip() {
        let root = tmp_dir("copy-file");
        let src = root.join("a.txt");
        fs::write(&src, b"hello").unwrap();
        let dst = root.join("out").join("a.txt");

        let out = copy_file_verified(&src, &dst, true).unwrap();
        assert_eq!(out.stat.files, 1);
        assert_eq!(out.stat.bytes, 5);
        assert_eq!(out.created.len(), 1);
        assert_eq!(fs::read(&dst).unwrap(), b"hello");

        // overwrite=false 且目标已存在 → 跳过，且**不计入 created** ——
        // 否则迁移回滚会把用户原本就有的文件删掉。
        let again = copy_file_verified(&src, &dst, false).unwrap();
        assert_eq!(again.stat.files, 0);
        assert_eq!(again.stat.skipped, 1);
        assert!(again.created.is_empty());

        // 回滚只删自己建的：源文件必须还在。
        rollback(&out.created);
        assert!(!dst.exists(), "回滚应删掉本次新建的目标文件");
        assert!(src.exists(), "回滚绝不能动源文件");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_dir_verified_recurses_and_counts() {
        let root = tmp_dir("copy-dir");
        let src = root.join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a.txt"), b"1").unwrap();
        fs::write(src.join("sub").join("b.txt"), b"22").unwrap();

        let dst = root.join("dst");
        let out = copy_dir_verified(&src, &dst, true).unwrap();
        assert_eq!(out.stat.files, 2, "应递归复制两个文件");
        assert_eq!(out.stat.bytes, 3);
        assert_eq!(fs::read(dst.join("sub").join("b.txt")).unwrap(), b"22");

        // 源目录不存在 = 空操作，不算错误（media/ 没用过时就是这个情况）
        let none = copy_dir_verified(&root.join("nope"), &root.join("nope2"), true).unwrap();
        assert_eq!(none.stat.files, 0);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn sha256_file_matches_known_digest() {
        let root = tmp_dir("sha256");
        let f = root.join("x.bin");
        fs::write(&f, b"abc").unwrap();
        // SHA-256("abc") 的官方测试向量
        assert_eq!(
            sha256_file(&f).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stamp_matches_known_instant() {
        // 2026-10-04 16:03:50 UTC（本机当时是 +8 区的 10-05 00:03）
        assert_eq!(stamp(1_791_129_830), "20261004_160350");
        assert_eq!(stamp(0), "19700101_000000");
    }

    #[test]
    fn civil_from_days_roundtrip_epoch() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(365), (1971, 1, 1));
    }
}
