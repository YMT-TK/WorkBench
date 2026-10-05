// 前端唯一可调用的后端命令层（AGENTS §3 规约 5：前端不直接碰数据库/文件系统）。
//
// 命令与前端 `src/core/shared/api/index.ts` 一一对应：
//   get_setting / set_setting / list_plugins / update_plugin
//   敏感字段：secure_set_setting / secure_get_setting
//   密钥：key_status / key_export_wbkey / key_import_wbkey（设计文档 §8）
//   进程与托盘：app_quit / app_hide_to_tray
//   数据目录：见子模块 `storage`（概况/打开）与 `migrate`（搬迁）
//   跨机导入：见子模块 `transfer`（设计文档 §7.6）
//
// 错误统一以 String 返回（Result<T, String>），前端 try/catch 后 notify('error') + 写日志。

pub mod backup;
pub mod storage;
pub mod transfer;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use wb_db::db::DbState;
// 设置读写原语来自**数据层**：运行时的 `backup.rs` 也要用它，若留在命令层
// 就形成「wb-runtime → 应用壳」的反向依赖（AGENTS §21.2）。
use wb_db::settings::{get_setting_conn, set_setting_conn};

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
    get_setting_conn(&conn, &key)
}

/// 写入/更新一个设置项（变更即落库，AGENTS §6.4）。
#[tauri::command]
pub fn set_setting(state: State<'_, DbState>, key: String, value: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    set_setting_conn(&conn, &key, &value)
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

/// 密钥三态（设计文档 §8.5）。枚举值直接序列化成前端可判定的字符串。
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum KeyState {
    /// 库中无指纹 + 凭据库无密钥 → **首次运行**（正常，首次写入敏感字段时建钥）
    FirstRun,
    /// 库中无指纹 + 凭据库有密钥 → **新库 + 旧密钥**（采用已有密钥并补记指纹）
    AdoptExisting,
    /// 库中指纹与本机密钥一致 → **正常**
    Ok,
    /// 库中有指纹，本机密钥却对不上 → **密钥不匹配**（解不开，需导入正确密钥）
    Mismatch,
    /// 库中有指纹，本机凭据库却没有密钥 → **密钥缺失**（典型：从另一台机器拷来的数据）
    Missing,
}

/// 🔴 跨机场景的防呆文案（设计文档 §8.5）：宁可拒绝，也不能静默生成新密钥。
const ERR_KEY_MISMATCH: &str =
    "密钥与数据不匹配：本机凭据库里的密钥解不开这个数据库。请导入与这份数据配套的密钥文件（.wbkey）。";
const ERR_KEY_MISSING: &str =
    "此数据来自另一台机器：数据库里记录了密钥指纹，但本机凭据库里没有对应密钥。\
     请在「设置 → 存储」的「密钥与安全」里导入密钥（.wbkey），已加密字段才能解开。";

struct ResolvedKey {
    key: crate::crypto::MasterKey,
}

/// 解析「库中指纹 ↔ 本机密钥」的关系，必要时补记指纹，返回可用于加解密的密钥。
///
/// - `create_if_first_run = true`（**写路径**）：首次运行时显式创建密钥；
/// - `create_if_first_run = false`（**读路径**）：绝不创建，缺失即报错。
///
/// ⛔ 只有本函数能决定「要不要建密钥」——把这条策略收在一处，
/// 才能保证「从别的机器拷来的库不会被动地换上一把新钥匙」（ADR-7）。
fn resolve_key(
    conn: &Connection,
    create_if_first_run: bool,
) -> Result<ResolvedKey, String> {
    use crate::crypto;

    let stored = get_setting_conn(conn, crypto::FINGERPRINT_SETTING_KEY)?;
    let existing = crypto::load_key()?;

    let (key, state) = match (stored.as_deref(), existing) {
        (Some(fp), Some(key)) => {
            if crypto::fingerprint(&key) != fp {
                return Err(ERR_KEY_MISMATCH.into());
            }
            (key, KeyState::Ok)
        }
        (Some(_), None) => return Err(ERR_KEY_MISSING.into()),
        (None, Some(key)) => (key, KeyState::AdoptExisting),
        (None, None) => {
            if !create_if_first_run {
                return Err("本机尚未生成主密钥，没有可解密的凭据".into());
            }
            (crypto::create_and_store_key()?, KeyState::FirstRun)
        }
    };

    // 首次创建 / 采用已有密钥时补记指纹：此后它就是「这份数据属于哪把钥匙」的锚点。
    if state != KeyState::Ok {
        let fingerprint = crypto::fingerprint(&key);
        set_setting_conn(conn, crypto::FINGERPRINT_SETTING_KEY, &fingerprint)?;
        log::info!("master key pinned, fingerprint={fingerprint} state={state:?}");
    }
    Ok(ResolvedKey { key })
}

/// 加密写入：明文先经 AES-256-GCM 加密再落库，主密钥不出 Rust 侧。
#[tauri::command]
pub fn secure_set_setting(
    state: State<'_, DbState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let resolved = resolve_key(&conn, true)?;
    let encrypted = crate::crypto::encrypt_with(&resolved.key, &value)?;
    set_setting_conn(&conn, &key, &encrypted)
}

/// 加密读取：取出密文解密后返回明文；不存在返回 None。
#[tauri::command]
pub fn secure_get_setting(
    state: State<'_, DbState>,
    key: String,
) -> Result<Option<String>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    match get_setting_conn(&conn, &key)? {
        Some(encrypted) => {
            let resolved = resolve_key(&conn, false)?;
            Ok(Some(crate::crypto::decrypt_with(&resolved.key, &encrypted)?))
        }
        None => Ok(None),
    }
}

// ---------- 密钥状态与可移植密钥文件（设计文档 §8） ----------

/// 密钥状态快照（供「设置 → 存储 → 密钥与安全」如实展示）。
/// **只读**：查询本身绝不会生成密钥。
#[derive(Serialize)]
pub struct KeyStatus {
    /// 本机凭据库中是否已有密钥
    pub exists: bool,
    /// 三态判定（前端据此显示不同横幅与入口）
    pub state: KeyState,
    /// 本机密钥的指纹
    pub fingerprint: Option<String>,
    /// 数据库里记录的指纹（「这份数据属于哪把钥匙」的锚点）
    pub stored_fingerprint: Option<String>,
    pub service: String,
    pub account: String,
    pub algorithm: String,
}

#[tauri::command]
pub fn key_status(state: State<'_, DbState>) -> Result<KeyStatus, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let stored = get_setting_conn(&conn, crate::crypto::FINGERPRINT_SETTING_KEY)?;
    drop(conn);
    let key = crate::crypto::load_key()?;
    let local = key.as_ref().map(crate::crypto::fingerprint);

    let state_code = match (stored.as_deref(), local.as_deref()) {
        (Some(s), Some(l)) if s == l => KeyState::Ok,
        (Some(_), Some(_)) => KeyState::Mismatch,
        (Some(_), None) => KeyState::Missing,
        (None, Some(_)) => KeyState::AdoptExisting,
        (None, None) => KeyState::FirstRun,
    };
    let (service, account) = crate::crypto::keyring_location();

    Ok(KeyStatus {
        exists: local.is_some(),
        state: state_code,
        fingerprint: local,
        stored_fingerprint: stored,
        service: service.to_string(),
        account: account.to_string(),
        algorithm: "AES-256-GCM".to_string(),
    })
}

/// 导出**口令加密**的可移植密钥文件 `.wbkey`（设计文档 §8.4）。
///
/// ⛔ 不提供明文导出：密钥明文落地等于把锁和钥匙放进同一个抽屉，
/// 直接违背「设备被拷走也解不开」的威胁模型（ADR-5 / ADR-6）。
#[tauri::command]
pub fn key_export_wbkey(path: String, passphrase: String) -> Result<String, String> {
    if passphrase.chars().count() < 8 {
        return Err("口令至少 8 个字符 —— 它是这个文件唯一的防线".into());
    }
    let key = crate::crypto::load_key()?.ok_or_else(|| {
        "本机还没有主密钥，无需导出（首次写入敏感字段时才会生成）".to_string()
    })?;
    let content = crate::crypto::export_wbkey(&key, &passphrase)?;

    let target = std::path::PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("导出路径为空".into());
    }
    if let Some(dir) = target.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
        }
    }
    std::fs::write(&target, content).map_err(|e| format!("写入失败：{e}"))?;
    log::info!("wbkey exported to {}", target.display());
    Ok(target.to_string_lossy().to_string())
}

/// 导入结果：解出并写入本机凭据库后的指纹与状态。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportKeyResult {
    pub fingerprint: String,
    pub state: KeyState,
    /// 是否顶掉了本机原有的另一把密钥
    pub replaced: bool,
    /// 被顶掉的那把的指纹（`replaced = false` 时为 None）
    pub previous_fingerprint: Option<String>,
}

/// 导入 `.wbkey`：口令解开主密钥 → 校验是否与库中指纹一致 → 写入本机凭据库。
/// 这是「公司电脑 → 个人笔记本」那条链路的落点（设计文档 §8.6）。
///
/// 🔴 `replace` 是**替换本机密钥**的显式开关（默认 false，命令参数缺省即拒绝）：
/// 本机数据库已有指纹且与导入的不一致时，说明本机数据锁在旧密钥下 ——
/// 换掉密钥等于把那些字段永久作废。所以必须由用户在跨机导入向导里明确确认，
/// 普通「导入密钥」入口永远传 false，也就永远不会静默顶掉一把在用的钥匙。
#[tauri::command]
pub fn key_import_wbkey(
    state: State<'_, DbState>,
    path: String,
    passphrase: String,
    replace: Option<bool>,
) -> Result<ImportKeyResult, String> {
    let replace = replace.unwrap_or(false);
    let target = std::path::PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("请先选择要导入的密钥文件（.wbkey）".into());
    }
    // 读文件放在取锁之前：KDF 与 IO 都不该占着数据库连接。
    let content =
        std::fs::read_to_string(&target).map_err(|e| format!("读取密钥文件失败：{e}"))?;
    let key = crate::crypto::import_wbkey(&content, &passphrase)?;

    let fingerprint = crate::crypto::fingerprint(&key);
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let stored = get_setting_conn(&conn, crate::crypto::FINGERPRINT_SETTING_KEY)?;

    let previous = stored
        .as_deref()
        .filter(|fp| *fp != fingerprint)
        .map(str::to_string);
    if let Some(old) = previous.as_deref() {
        if !replace {
            return Err(format!(
                "本机已有一把不同的密钥（指纹 {old}），它正在保护本机现有的加密数据。\n\
                 替换之后那些字段就再也解不开了，所以这里不会替你决定 —— \
                 请在「从别的电脑导入」向导里明确确认替换，或者先导出现有密钥再继续。"
            ));
        }
        log::warn!("replacing local master key {old} with imported {fingerprint}");
    }

    crate::crypto::store_key(&key)?;
    // 指纹总是对齐到刚导入的这把：冲突时是「改指向」，无指纹时是「补记」。
    if stored.as_deref() != Some(fingerprint.as_str()) {
        set_setting_conn(&conn, crate::crypto::FINGERPRINT_SETTING_KEY, &fingerprint)?;
    }
    log::info!("wbkey imported, fingerprint={fingerprint} replaced={}", previous.is_some());
    Ok(ImportKeyResult {
        fingerprint,
        state: KeyState::Ok,
        replaced: previous.is_some(),
        previous_fingerprint: previous,
    })
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
