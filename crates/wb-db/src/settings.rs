//! `app_settings` 表的读写原语（连接级，调用方自行持有锁）。
//!
//! 🔴 **为什么这条原语在数据层，而不是在命令层**：
//! `backup.rs` 要读 `backup.auto` / `backup.keep`，而备份属于**平台运行时**能力。
//! 若它去调命令层的函数，就形成「`wb-runtime` → 应用壳」的反向依赖 ——
//! 平台从此再也抽不出来，而且**编译器不会报错**（AGENTS §21.2）。
//! 把最底层的读写下沉到这里，双方都向下看，依赖方向才是单向的。

use rusqlite::{params, Connection, OptionalExtension};

/// 读取一个设置项；不存在返回 `None`。
///
/// ⚠️ 已持锁时**只能**调本函数，⛔ 不能再调命令层的 `get_setting`
/// （那会对自己重复加锁而死锁）。
pub fn get_setting_conn(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// 写入 / 更新一个设置项（连接级），**变更即落库**（AGENTS §6.4）。
pub fn set_setting_conn(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at)
         VALUES (?1, ?2, strftime('%s', 'now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
