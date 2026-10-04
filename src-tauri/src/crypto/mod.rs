// 安全与加密（AGENTS §7 方案 A：字段级加密）。
//
// 设计：
//   - 敏感字段（会员密码 / Git Token / API Key）落库前用 AES-256-GCM 加密；
//   - 主密钥（32 字节）仅存 OS 凭据库（Windows Credential Manager），
//     ⛔ 绝不明文入库、绝不写配置文件（AGENTS §7 红线）；
//   - 密文格式 base64(nonce(12) ‖ ciphertext)，可直接作为文本字段存进 SQLite；
//   - 媒体文件不加密（AGENTS §7）。
//
// 说明：keyring 在无凭据库的 CI/沙箱环境可能不可用，届时命令返回 Err（前端 notify('error')），
// 不影响其余功能；不做「明文降级」以免破坏安全红线。

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine as _};

const KEYRING_SERVICE: &str = "WorkBench";
const KEYRING_ACCOUNT: &str = "master-key";
const NONCE_LEN: usize = 12;

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string())
}

/// 读取主密钥；不存在则生成随机密钥并写入 OS 凭据库（AGENTS §7）。
pub fn get_or_create_key() -> Result<Key<Aes256Gcm>, String> {
    let entry = keyring_entry()?;
    match entry.get_password() {
        Ok(b64) => {
            let bytes = STANDARD.decode(b64.trim()).map_err(|e| e.to_string())?;
            if bytes.len() != 32 {
                return Err("master key length invalid (expect 32 bytes)".into());
            }
            Ok(*Key::<Aes256Gcm>::from_slice(&bytes))
        }
        Err(keyring::Error::NoEntry) => {
            let key = Aes256Gcm::generate_key(&mut OsRng);
            entry
                .set_password(&STANDARD.encode(key.as_slice()))
                .map_err(|e| e.to_string())?;
            log::info!("generated new master key into OS keychain");
            Ok(key)
        }
        Err(err) => Err(err.to_string()),
    }
}

/// 加密明文，返回可直接入库的 base64 密文。
pub fn encrypt(plain: &str) -> Result<String, String> {
    let key = get_or_create_key()?;
    let cipher = Aes256Gcm::new(&key);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let cipher_text = cipher
        .encrypt(&nonce, plain.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&cipher_text);
    Ok(STANDARD.encode(out))
}

/// 解密 base64 密文（格式：nonce ‖ ciphertext）。
pub fn decrypt(encoded: &str) -> Result<String, String> {
    let key = get_or_create_key()?;
    let raw = STANDARD.decode(encoded.trim()).map_err(|e| e.to_string())?;
    if raw.len() <= NONCE_LEN {
        return Err("ciphertext too short".into());
    }
    let (nonce_bytes, cipher_text) = raw.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(&key);
    let nonce = Nonce::from_slice(nonce_bytes);
    let plain = cipher
        .decrypt(nonce, cipher_text)
        .map_err(|_| "decrypt failed (wrong key or corrupted data)".to_string())?;
    String::from_utf8(plain).map_err(|e| e.to_string())
}

/// 导出主密钥（base64）供用户离线备份，避免忘密导致数据死锁（AGENTS §7）。
pub fn export_key() -> Result<String, String> {
    let key = get_or_create_key()?;
    Ok(STANDARD.encode(key.as_slice()))
}
