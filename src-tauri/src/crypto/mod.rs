// 安全与加密（AGENTS §7 方案 A：字段级加密 + 设计文档 §8 密钥模型）。
//
// 设计要点：
//   - 敏感字段（会员密码 / Git Token / API Key）落库前用 AES-256-GCM 加密；
//   - 主密钥（32 字节）**首要**存 OS 凭据库（Windows Credential Manager），
//     ⛔ 绝不明文入库、绝不写配置文件（AGENTS §7 红线）；
//   - 密文格式 base64(nonce(12) ‖ ciphertext)，可直接作为文本字段存进 SQLite；
//   - 媒体文件不加密（AGENTS §7）。
//
// 🔴 两条密钥路径（设计文档 ADR-7）—— 不再提供「看一眼就顺手创建」的接口：
//   - `load_key()`            只读，缺失返回 None（状态查询 / 解密用）
//   - `create_and_store_key()` 显式创建（仅首次写入敏感字段时由命令层调用）
//   起因：跨机场景下若状态查询顺手建密钥，会凭空生成一把新钥，
//   把公司电脑加密过的数据变成「全解不开」的乱局（设计文档 §8.5）。
//
// 🔴 `.wbkey` 口令加密副本（设计文档 ADR-6 / §8.4）—— 一个文件同时解决两件事：
//   ① 凭据库因密码重置 / 换机 / 清理而失效时的**冗余副本**；
//   ② 公司电脑 → 个人笔记本的**跨机迁移载体**。
//   口令经 Argon2id 派生出 wrapping key，再 AES-256-GCM 封装主密钥；
//   ⛔ 文件被拷走没有口令也解不开 —— 这才与「明文密钥文件」有本质区别。
//
// 说明：keyring 在无凭据库的 CI/沙箱环境可能不可用，届时命令返回 Err（前端 notify('error')），
// 不影响其余功能；不做「明文降级」以免破坏安全红线。

use std::collections::HashMap;

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use sha2::{Digest, Sha256};

const KEYRING_SERVICE: &str = "WorkBench";
const KEYRING_ACCOUNT: &str = "master-key";
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
/// 指纹取 SHA-256 前 8 字节。
const FP_LEN: usize = 8;

/// `app_settings` 中记录密钥指纹的键（设计文档 §8.5）。
/// 明文存 `SHA256(K)[0..8]`，用于检测「库里的密文」与「本机密钥」是否配套。
pub const FINGERPRINT_SETTING_KEY: &str = "crypto.key_fingerprint";

/// `.wbkey` 文件魔数与版本头。
const WBKEY_MAGIC: &str = "WBKEY/1";

/// Argon2id 参数：m=64MiB, t=3, p=1。
/// ⚠️ 这些值会**写进 `.wbkey` 文件**，因此日后提高强度不会导致旧文件失效。
#[cfg(not(test))]
const KDF_MEM_KIB: u32 = 65_536;
#[cfg(not(test))]
const KDF_TIME: u32 = 3;
#[cfg(not(test))]
const KDF_PARALLEL: u32 = 1;

// 单元测试用轻量参数：Argon2 在 debug 构建下 64MiB×3 一次要数秒，
// 测试要跑多次导入/解密，用满参数只会把测试拖成分钟级。
// 正确性（格式 / 派生 / 认证 / 指纹）与参数大小无关。
#[cfg(test)]
const KDF_MEM_KIB: u32 = 8_192;
#[cfg(test)]
const KDF_TIME: u32 = 1;
#[cfg(test)]
const KDF_PARALLEL: u32 = 1;

/// 主密钥类型别名（32 字节 AES-256-GCM 密钥）。
pub type MasterKey = Key<Aes256Gcm>;

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string())
}

// ---------- 密钥读写（两条路径，职责分明） ----------

/// 读取主密钥。**只读**：凭据库中没有则返回 `None`，绝不创建。
pub fn load_key() -> Result<Option<MasterKey>, String> {
    match keyring_entry()?.get_password() {
        Ok(b64) => {
            let bytes = STANDARD.decode(b64.trim()).map_err(|e| e.to_string())?;
            if bytes.len() != KEY_LEN {
                return Err("master key length invalid (expect 32 bytes)".into());
            }
            Ok(Some(*MasterKey::from_slice(&bytes)))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

/// 把一把已解出的密钥写入本机 OS 凭据库（导入 `.wbkey` 时用）。
pub fn store_key(key: &MasterKey) -> Result<(), String> {
    keyring_entry()?
        .set_password(&STANDARD.encode(key.as_slice()))
        .map_err(|e| e.to_string())
}

/// **显式**生成随机主密钥并写入凭据库。
/// ⛔ 只有「首次写入敏感字段」这一条路径可以调它（设计文档 §8.5）。
pub fn create_and_store_key() -> Result<MasterKey, String> {
    let key = Aes256Gcm::generate_key(&mut OsRng);
    store_key(&key)?;
    log::info!("generated new master key into OS keychain");
    Ok(key)
}

/// 主密钥在 OS 凭据库中的存放位置（供设置页如实展示，AGENTS §7）。
pub fn keyring_location() -> (&'static str, &'static str) {
    (KEYRING_SERVICE, KEYRING_ACCOUNT)
}

/// 密钥指纹 = `SHA256(K)` 前 8 字节（小写 hex）。
/// 明文存进 `app_settings`，从 8 字节里反推不出密钥本身。
pub fn fingerprint(key: &MasterKey) -> String {
    let digest = Sha256::digest(key.as_slice());
    hex_encode(&digest[..FP_LEN])
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

// ---------- 字段级加解密 ----------

/// 加密明文，返回可直接入库的 base64 密文（`nonce ‖ ciphertext`）。
pub fn encrypt_with(key: &MasterKey, plain: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new(key);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let cipher_text = cipher
        .encrypt(&nonce, plain.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&cipher_text);
    Ok(STANDARD.encode(out))
}

/// 解密 base64 密文（格式：`nonce ‖ ciphertext`）。
pub fn decrypt_with(key: &MasterKey, encoded: &str) -> Result<String, String> {
    let raw = STANDARD.decode(encoded.trim()).map_err(|e| e.to_string())?;
    if raw.len() <= NONCE_LEN {
        return Err("ciphertext too short".into());
    }
    let (nonce_bytes, cipher_text) = raw.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(nonce_bytes);
    let plain = cipher
        .decrypt(nonce, cipher_text)
        .map_err(|_| "decrypt failed (wrong key or corrupted data)".to_string())?;
    String::from_utf8(plain).map_err(|e| e.to_string())
}

// ---------- `.wbkey`：口令加密的可移植密钥文件（设计文档 §8.4） ----------

/// `wrapping_key = Argon2id(passphrase, salt)` → 32 字节。
fn derive_wrapping_key(
    passphrase: &str,
    salt: &[u8],
    mem_kib: u32,
    time: u32,
    parallel: u32,
) -> Result<[u8; KEY_LEN], String> {
    let params = argon2::Params::new(mem_kib, time, parallel, Some(KEY_LEN))
        .map_err(|e| format!("KDF 参数非法：{e}"))?;
    let kdf = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut out = [0u8; KEY_LEN];
    kdf.hash_password_into(passphrase.as_bytes(), salt, &mut out)
        .map_err(|e| format!("口令派生失败：{e}"))?;
    Ok(out)
}

/// 生成 `.wbkey` 文件内容。
///
/// 格式（纯文本，便于人工辨认与 U 盘/邮件传递）：
/// ```text
/// WBKEY/1
/// salt:    <base64 · 16 字节>
/// nonce:   <base64 · 12 字节>
/// mem:     65536            # Argon2id m(KiB)
/// time:    3                # Argon2id t
/// para:    1                # Argon2id p
/// data:    <base64 · AES-256-GCM 密文>
/// fp:      <hex · 8 字节，主密钥指纹>
/// created: <unix 秒>
/// ```
pub fn export_wbkey(key: &MasterKey, passphrase: &str) -> Result<String, String> {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);

    let wrapping = derive_wrapping_key(passphrase, &salt, KDF_MEM_KIB, KDF_TIME, KDF_PARALLEL)?;
    let wrapping_key = *MasterKey::from_slice(&wrapping);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let cipher_text = Aes256Gcm::new(&wrapping_key)
        .encrypt(&nonce, key.as_slice())
        .map_err(|e| e.to_string())?;

    let created = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let lines = [
        WBKEY_MAGIC.to_string(),
        format!("salt:    {}", STANDARD.encode(salt)),
        format!("nonce:   {}", STANDARD.encode(nonce.as_slice())),
        format!("mem:     {KDF_MEM_KIB}"),
        format!("time:    {KDF_TIME}"),
        format!("para:    {KDF_PARALLEL}"),
        format!("data:    {}", STANDARD.encode(&cipher_text)),
        format!("fp:      {}", fingerprint(key)),
        format!("created: {created}"),
    ];
    Ok(lines.join("\n") + "\n")
}

/// 解析并解开 `.wbkey`，返回主密钥。
/// 口令错误 / 文件被改都会失败（AES-256-GCM 认证标签保证），不会「解出半个密钥」。
pub fn import_wbkey(content: &str, passphrase: &str) -> Result<MasterKey, String> {
    let mut lines = content.lines();
    let magic = lines.next().unwrap_or("").trim();
    if magic != WBKEY_MAGIC {
        return Err(format!("不是有效的密钥文件（缺少 {WBKEY_MAGIC} 头）"));
    }

    let mut fields: HashMap<&str, &str> = HashMap::new();
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            fields.insert(k.trim(), v.trim());
        }
    }
    let get = |k: &str| -> Result<&str, String> {
        fields
            .get(k)
            .copied()
            .ok_or_else(|| format!("密钥文件缺少字段：{k}"))
    };
    let parse_u32 = |k: &str| -> Result<u32, String> {
        get(k)?
            .parse::<u32>()
            .map_err(|_| format!("密钥文件字段非法：{k}"))
    };

    let salt = STANDARD.decode(get("salt")?).map_err(|e| e.to_string())?;
    let nonce = STANDARD.decode(get("nonce")?).map_err(|e| e.to_string())?;
    let data = STANDARD.decode(get("data")?).map_err(|e| e.to_string())?;
    if nonce.len() != NONCE_LEN {
        return Err("密钥文件 nonce 长度非法".into());
    }
    if salt.len() < 8 {
        return Err("密钥文件 salt 长度非法".into());
    }

    let wrapping = derive_wrapping_key(
        passphrase,
        &salt,
        parse_u32("mem")?,
        parse_u32("time")?,
        parse_u32("para")?,
    )?;
    let wrapping_key = *MasterKey::from_slice(&wrapping);
    let plain = Aes256Gcm::new(&wrapping_key)
        .decrypt(Nonce::from_slice(&nonce), data.as_slice())
        .map_err(|_| "口令错误或文件已损坏".to_string())?;
    if plain.len() != KEY_LEN {
        return Err("解出的主密钥长度非法".into());
    }
    let key = *MasterKey::from_slice(&plain);

    // 指纹自校验：能解出来说明口令对，这里再挡一次「文件被改过」的情况。
    if let Ok(expected) = get("fp") {
        let actual = fingerprint(&key);
        if !expected.eq_ignore_ascii_case(&actual) {
            return Err("密钥指纹不匹配：文件可能已被篡改".into());
        }
    }
    Ok(key)
}

/// `.wbkey` 的**明文头**（不含任何密钥材料）。
///
/// `fp` 与 `created` 在文件里本来就是明文（它们要被人工看懂、被 diff），
/// 所以**不需要口令**就能读出来 —— 这正是导入向导的第一道关卡：
/// 先按指纹判断「你选的这个文件对不对」，对上了再要口令。
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WbkeyHeader {
    /// 文件自带的密钥指纹（`SHA256(K)[0..8]`）
    pub fingerprint: String,
    /// unix 秒（0 = 文件没写这一项）
    pub created: i64,
}

/// 只读解析 `.wbkey` 的明文头。⛔ 不派生口令、不解密、不碰密钥材料。
pub fn read_wbkey_header(content: &str) -> Result<WbkeyHeader, String> {
    let mut lines = content.lines();
    let magic = lines.next().unwrap_or("").trim();
    if magic != WBKEY_MAGIC {
        return Err(format!("不是有效的密钥文件（缺少 {WBKEY_MAGIC} 头）"));
    }
    let mut fingerprint = String::new();
    let mut created = 0i64;
    for line in lines {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        match k.trim() {
            "fp" => fingerprint = v.trim().to_string(),
            "created" => created = v.trim().parse().unwrap_or(0),
            _ => {}
        }
    }
    if fingerprint.is_empty() {
        return Err("密钥文件缺少指纹字段，可能已损坏".into());
    }
    Ok(WbkeyHeader {
        fingerprint,
        created,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn random_key() -> MasterKey {
        Aes256Gcm::generate_key(&mut OsRng)
    }

    #[test]
    fn field_encrypt_decrypt_roundtrip() {
        let key = random_key();
        let enc = encrypt_with(&key, "s3cret-token").expect("encrypt");
        assert_ne!(enc, "s3cret-token");
        assert_eq!(decrypt_with(&key, &enc).expect("decrypt"), "s3cret-token");

        // 换一把密钥必须解不开（而不是解出乱码）
        assert!(decrypt_with(&random_key(), &enc).is_err());
    }

    #[test]
    fn wbkey_roundtrip() {
        let key = random_key();
        let text = export_wbkey(&key, "correct horse battery staple").expect("export");
        assert!(text.starts_with(WBKEY_MAGIC));
        for field in ["salt:", "nonce:", "mem:", "time:", "para:", "data:", "fp:"] {
            assert!(text.contains(field), "缺少字段 {field}");
        }

        let back = import_wbkey(&text, "correct horse battery staple").expect("import");
        assert_eq!(back.as_slice(), key.as_slice());
        assert_eq!(fingerprint(&back), fingerprint(&key));
    }

    #[test]
    fn wbkey_header_is_readable_without_passphrase() {
        // 明文头是导入向导的第一道关卡：先判断「文件选对没有」，再要口令。
        let key = random_key();
        let text = export_wbkey(&key, "correct horse battery staple").expect("export");

        let head = read_wbkey_header(&text).expect("header");
        assert_eq!(head.fingerprint, fingerprint(&key));
        assert!(head.created > 0, "created 应被写入并读回");

        assert!(read_wbkey_header("NOT-A-WBKEY\nfp: 1234").is_err());
    }

    #[test]
    fn wbkey_rejects_wrong_passphrase_and_tampering() {
        let key = random_key();
        let text = export_wbkey(&key, "right-passphrase").expect("export");

        assert!(import_wbkey(&text, "wrong-passphrase").is_err());

        // 指纹被改 → 拒绝（即便口令正确）
        let tampered = text.replace(&fingerprint(&key), "0000000000000000");
        assert!(import_wbkey(&tampered, "right-passphrase").is_err());

        // 密文被改 → AES-GCM 认证失败
        let broken = text.replace("data:", "data:AAAA");
        assert!(import_wbkey(&broken, "right-passphrase").is_err());

        // 头部不对 → 直接拒绝
        assert!(import_wbkey("NOT-A-KEYFILE\n", "right-passphrase").is_err());
    }

    #[test]
    fn fingerprint_is_stable_and_short() {
        let key = random_key();
        let fp = fingerprint(&key);
        assert_eq!(fp.len(), FP_LEN * 2);
        assert_eq!(fp, fingerprint(&key));
        assert_ne!(fp, fingerprint(&random_key()));
    }
}
