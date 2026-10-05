// 跨机导入：把「另一台电脑上的备份包 + .wbkey」搬进本机（设计文档 §7.6 / ADR-17）。
//
// ## 场景
// 公司电脑 → 家里笔记本。用户手上是两样东西：
//   ① 一个备份快照**目录**（`backup_<戳>/`，含 workbench.db + media/ + manifest.json）
//   ② 一个口令加密的 `.wbkey`
//
// ## 固定顺序：先把只读的判定做完，再动手
//   1. `inspect`  读外部备份包，取出「它要求哪把钥匙」（`manifest.keyFingerprint`）
//   2. `wbkey_inspect`  只读 `.wbkey` 的**明文头**拿指纹 —— 不需要口令就能判断「文件选对没有」
//   3. `precheck` 用口令解开 `.wbkey` 复核一遍，给出最终判定；**磁盘上什么都不改**
//   4. `key_import_wbkey(..., replace)` 把密钥写进本机凭据库（冲突时必须显式确认）
//   5. `adopt`    把备份包**校验复制**进 `<根目录>/backup/<id>`，登记成一份本地快照
//   6. `backup::restore` 复用既有恢复链路（留 prerestore 快照 + 写 restore-pending）
//
// ## 两个「为什么」
// - ⛔ **为什么必须先预检**：若先登记再发现钥匙不对，用户磁盘上会多出一份**永远解不开**的
//   备份包，还得自己去删。只读预检把「失败」的代价压到零。
// - ⛔ **为什么登记是「复制」而不是就地恢复**：源可能是 U 盘，拔了就没了；
//   复制进来之后它才是一份本机资产，也才会出现在备份列表里、被保留策略管到。

use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;

use crate::backup::{self, BackupItem};
use crate::crypto;
use wb_db::db::DbState;
use wb_db::storage;

use crate::fsutil;

/// id 太长会撑爆路径（Windows 单段 255 字符），这里给个保守上限。
const MAX_ID_LEN: usize = 96;

/// 外部备份包的概况（**只读**，不往任何地方写东西）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInfo {
    /// 备份包目录绝对路径
    pub path: String,
    /// 登记时用的 id（= 目录名；非法字符会被规范化）
    pub id: String,
    /// 目录名是否被改动过（前端据此提示「会比原来的名字多一个 backup_ 前缀」）
    pub id_adjusted: bool,
    /// 有没有 manifest.json（没有 = 手工拷来的老包，信息不全，**也无法确知要哪把钥匙**）
    pub has_manifest: bool,
    pub format: String,
    pub utc_stamp: String,
    pub created_at: i64,
    /// 打包时的数据根目录 —— 让用户确认「这确实是我那份」
    pub source_dir: String,
    pub app_version: String,
    /// 这份数据要求哪把钥匙（空 = 没有加密字段 / 没有清单）
    pub key_fingerprint: String,
    pub db_bytes: u64,
    pub media_files: u64,
    pub media_bytes: u64,
    /// 整个备份包目录占用
    pub size: u64,
}

/// 预检结论。前端据此决定「能不能往下走、要不要用户额外确认」。
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ImportVerdict {
    /// 备份包没有加密字段（或没有清单）—— 不需要密钥，直接导入
    NoKeyNeeded,
    /// 指纹对得上，且本机没有冲突密钥 —— 一路畅通
    Ready,
    /// 指纹对得上，但本机已持有**另一把**密钥 —— 导入会替换它，本机现有加密字段将解不开
    ReplacesLocalKey,
    /// 密钥指纹与备份包要求的不符 —— 选错文件了，必须停下
    Mismatch,
}

/// 完整预检结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Precheck {
    pub pack: PackInfo,
    /// 从 `.wbkey` 解出来的指纹（空 = 备份包不需要密钥，没去解）
    pub provided_fingerprint: String,
    /// `.wbkey` 文件里记录的导出时间（unix 秒，0 = 未记录）
    pub provided_created: i64,
    /// 本机凭据库当前的密钥指纹（空 = 本机还没有密钥）
    pub local_fingerprint: String,
    /// 本机数据库记录的指纹（空 = 本机数据没有加密字段）
    pub stored_fingerprint: String,
    pub verdict: ImportVerdict,
    /// 给用户看的一句话结论
    pub summary: String,
    /// 不阻断流程、但用户必须看到的提醒
    pub warnings: Vec<String>,
}

/// 把外部目录名规范成合法的快照 id。
///
/// 🔴 为什么必须做：`backup::resolve_snapshot` 会校验前缀 + 禁 `/\:`。
/// 用户从 U 盘拷过来的目录可能被改过名（甚至叫「新建文件夹」）——
/// 在**登记时**就规范好，而不是等恢复时才甩一句「非法备份标识」。
fn normalize_id(raw: &str, fallback_stamp: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    let cleaned = cleaned.trim_matches('_');

    // 已经带合法前缀的，原样沿用（保留用户看得懂的备份名）。
    if cleaned.starts_with(backup::PRE_RESTORE_PREFIX) || cleaned.starts_with(backup::PREFIX) {
        if cleaned.len() > 4 {
            return truncate_ascii(cleaned, MAX_ID_LEN);
        }
    }
    if cleaned.is_empty() {
        // 「新建文件夹」这类名字全被清洗掉了 → 用 UTC 戳兜底，保证唯一且可读。
        return format!("{}{}", backup::PREFIX, fallback_stamp);
    }
    truncate_ascii(&format!("{}{}", backup::PREFIX, cleaned), MAX_ID_LEN)
}

/// 按**字符数**截断纯 ASCII 串（调用点保证入参已被清洗成 ASCII）。
fn truncate_ascii(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    s[..max].to_string()
}

/// 读一个外部备份包目录（只读）。
pub fn inspect(dir: &Path) -> Result<PackInfo, String> {
    if !dir.is_dir() {
        return Err(format!("不是一个目录：{}", dir.display()));
    }
    if !dir.join(storage::DB_FILE).is_file() {
        return Err(format!(
            "这个目录里没有 {}，不像是备份包。\n\
             请选择**备份包目录本身**（里面应当有 workbench.db 与 manifest.json）。",
            storage::DB_FILE
        ));
    }

    let manifest = backup::read_manifest(dir);
    let raw_name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let fallback_stamp = manifest
        .as_ref()
        .map(|m| m.utc_stamp.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fsutil::stamp(fsutil::now_secs()));
    let id = normalize_id(&raw_name, &fallback_stamp);

    Ok(PackInfo {
        id_adjusted: id != raw_name,
        path: dir.to_string_lossy().to_string(),
        id,
        has_manifest: manifest.is_some(),
        format: manifest.as_ref().map(|m| m.format.clone()).unwrap_or_default(),
        utc_stamp: manifest
            .as_ref()
            .map(|m| m.utc_stamp.clone())
            .unwrap_or_else(|| raw_name.clone()),
        created_at: manifest.as_ref().map(|m| m.created_at).unwrap_or(0),
        source_dir: manifest
            .as_ref()
            .map(|m| m.source_dir.clone())
            .unwrap_or_default(),
        app_version: manifest
            .as_ref()
            .map(|m| m.app_version.clone())
            .unwrap_or_default(),
        key_fingerprint: manifest
            .as_ref()
            .map(|m| m.key_fingerprint.clone())
            .unwrap_or_default(),
        db_bytes: manifest
            .as_ref()
            .and_then(|m| m.db.as_ref())
            .map(|d| d.bytes)
            .unwrap_or(0),
        media_files: manifest.as_ref().map(|m| m.media_files).unwrap_or(0),
        media_bytes: manifest.as_ref().map(|m| m.media_bytes).unwrap_or(0),
        size: fsutil::dir_size(dir),
    })
}

/// 只读读 `.wbkey` 的明文头（**不需要口令**）。
pub fn wbkey_header(path: &Path) -> Result<crypto::WbkeyHeader, String> {
    if !path.is_file() {
        return Err(format!("找不到密钥文件：{}", path.display()));
    }
    let content =
        fs::read_to_string(path).map_err(|e| format!("读取密钥文件失败：{e}"))?;
    crypto::read_wbkey_header(&content)
}

/// 完整预检：解析备份包 → 解密钥 → 比对指纹 → 给判定。**全程只读**。
pub fn precheck(
    db: &DbState,
    pack_dir: &Path,
    wbkey_path: &Path,
    passphrase: &str,
) -> Result<Precheck, String> {
    let pack = inspect(pack_dir)?;
    let local_fingerprint = backup::local_fingerprint();
    let stored_fingerprint = backup::data_fingerprint(db);
    let mut warnings = Vec::new();

    if !pack.has_manifest {
        warnings.push(
            "这份备份包里没有 manifest.json（可能是手工拷贝或很旧的产物）：\
             无法确认它需要哪把钥匙，也无法核对文件完整性。"
                .to_string(),
        );
    }

    // 备份包没声明密钥要求 → 连 .wbkey 都不用解。
    if pack.key_fingerprint.is_empty() {
        return Ok(Precheck {
            pack,
            provided_fingerprint: String::new(),
            provided_created: 0,
            local_fingerprint,
            stored_fingerprint,
            verdict: ImportVerdict::NoKeyNeeded,
            summary: "这份备份没有声明加密字段，无需密钥即可导入。".to_string(),
            warnings,
        });
    }

    if passphrase.chars().count() < 8 {
        return Err("口令至少 8 个字符".into());
    }
    let content = fs::read_to_string(wbkey_path).map_err(|e| format!("读取密钥文件失败：{e}"))?;
    // 口令错 / 文件被改 → 这里直接报错（GCM 认证标签保证不会解出半个密钥）。
    let key = crypto::import_wbkey(&content, passphrase)?;
    let provided = crypto::fingerprint(&key);
    let header = crypto::read_wbkey_header(&content).unwrap_or(crypto::WbkeyHeader {
        fingerprint: provided.clone(),
        created: 0,
    });

    let (verdict, summary) = if provided != pack.key_fingerprint {
        (
            ImportVerdict::Mismatch,
            format!(
                "这个密钥不是这份数据用的：备份包要求指纹 {}，而你选的 .wbkey 是 {}。\
                 请换用导出这份备份时同时导出的那个密钥文件。",
                pack.key_fingerprint, provided
            ),
        )
    } else if !stored_fingerprint.is_empty() && stored_fingerprint != provided {
        // 🔴 硬冲突的判据是**库中指纹**，不是凭据库里的那把钥匙：
        // 有指纹 = 本机已有数据锁在旧密钥下，替换就等于把它们作废。
        (
            ImportVerdict::ReplacesLocalKey,
            format!(
                "密钥对得上，但本机数据库记录的是另一把密钥（指纹 {}）。\
                 导入会把本机凭据库里的密钥换成这把 —— 换完之后，本机现有数据里\
                 用旧密钥加密的字段就再也解不开了。\
                 如果本机那份数据还有用，请先在上面的「导出密钥备份」里把现在这把导出一份。",
                stored_fingerprint
            ),
        )
    } else {
        (
            ImportVerdict::Ready,
            "密钥与备份包匹配，可以导入。".to_string(),
        )
    };

    // 软提醒：凭据库里另有一把**没被任何数据绑定**的密钥（库中无指纹），
    // 导入会把它顶掉。不阻断 —— 没有密文依赖它，顶掉不会造成数据损失。
    if verdict == ImportVerdict::Ready
        && !local_fingerprint.is_empty()
        && local_fingerprint != provided
    {
        warnings.push(format!(
            "本机凭据库里另有一把密钥（指纹 {}），导入会替换它。\
             它没有被任何数据绑定（数据库里没有对应指纹），不会造成数据损失。",
            local_fingerprint
        ));
    }
    if verdict == ImportVerdict::ReplacesLocalKey {
        warnings.push(
            "替换密钥是**不可逆**的：旧密钥只存在于本机凭据库，被覆盖后就再也取不回来。"
                .to_string(),
        );
    }

    Ok(Precheck {
        pack,
        provided_fingerprint: provided,
        provided_created: header.created,
        local_fingerprint,
        stored_fingerprint,
        verdict,
        summary,
        warnings,
    })
}

/// 把外部备份包**校验复制**进本机 `backup/`，登记成一份本地快照。
///
/// 先复制到 `.staging-*` 再转正 —— 与 `backup::create` 同一套路，中途失败不留半个快照。
/// ⛔ 本机已有同名快照时**拒绝**：让用户先去列表里删掉，或把外部目录改个名 ——
/// 静默改名会造出「看起来一样的两份」，反而更容易搞混。
pub fn adopt(app: &AppHandle, pack_dir: &Path) -> Result<BackupItem, String> {
    let pack = inspect(pack_dir)?;
    let root = storage::backup_dir(app)?;
    fs::create_dir_all(&root).map_err(|e| format!("创建备份目录失败：{e}"))?;

    let dest = root.join(&pack.id);
    if dest.exists() {
        return Err(format!(
            "本机备份列表里已经有「{}」了。\n\
             如需重新导入，请先把列表里那一份删掉；或者给外部那个备份包目录改个名字再试。",
            pack.id
        ));
    }

    let staging = root.join(format!(".staging-{}", pack.id));
    let _ = fs::remove_dir_all(&staging);

    let outcome = match fsutil::copy_dir_verified(pack_dir, &staging, true) {
        Ok(o) => o,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("复制备份包失败：{e}"));
        }
    };

    if let Err(e) = fs::rename(&staging, &dest) {
        fsutil::rollback(&outcome.created);
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("备份包落位失败：{e}"));
    }

    log::info!(
        "adopted external backup pack {} ({} files, {} bytes, verified)",
        pack.id,
        outcome.stat.files,
        outcome.stat.bytes
    );
    Ok(backup::item_at(&dest, pack.id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_keeps_proper_names() {
        assert_eq!(
            normalize_id("backup_20261004_160350", "x"),
            "backup_20261004_160350"
        );
        assert_eq!(
            normalize_id("prerestore_20261004_160350", "x"),
            "prerestore_20261004_160350"
        );
    }

    #[test]
    fn normalize_prefixes_and_sanitizes() {
        // 用户重命名过的目录 → 补前缀，保留可读片段
        assert_eq!(normalize_id("公司电脑", "20261004"), "backup_20261004");
        assert_eq!(normalize_id("my-laptop", "x"), "backup_my-laptop");
        // 含非法字符（resolve_snapshot 会拒绝 / \ :）→ 清洗成 _
        assert_eq!(normalize_id("a/b:c", "x"), "backup_a_b_c");
        // 全是非法字符 → 用 UTC 戳兜底
        assert_eq!(normalize_id("新建文件夹", "20261005_101010"), "backup_20261005_101010");
    }

    #[test]
    fn normalize_id_is_always_resolvable() {
        // 规范化后的 id 必须能过 `resolve_snapshot` 的前缀与字符校验。
        for raw in ["backup_x", "prerestore_x", "随便什么", "///", ""] {
            let id = normalize_id(raw, "20261005_101010");
            assert!(
                id.starts_with(backup::PREFIX) || id.starts_with(backup::PRE_RESTORE_PREFIX),
                "{raw} → {id} 缺前缀"
            );
            assert!(!id.contains(['/', '\\', ':']), "{raw} → {id} 含非法字符");
        }
    }

    #[test]
    fn truncate_keeps_within_limit() {
        let long = "a".repeat(500);
        assert_eq!(truncate_ascii(&long, MAX_ID_LEN).len(), MAX_ID_LEN);
        assert_eq!(truncate_ascii("short", MAX_ID_LEN), "short");
    }
}
