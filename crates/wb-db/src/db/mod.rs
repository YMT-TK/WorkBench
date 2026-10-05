// 数据库层（AGENTS §5 / §6 / §9 任务3）。
//
// 已落地：
//   - 数据目录由 `crate::storage` 解析（默认 app_data_dir/WorkBench，可在设置页自定义，§20）
//   - 以 Mutex<Connection> 管理单连接，写操作经 Mutex 串行化（单写者，§5.x 应用层）
//   - WAL（一写多读并发）+ busy_timeout（捕获 SQLITE_BUSY 不静默死重试）
//   - 版本化 migration 执行器：以 PRAGMA user_version 追踪，事务内原子应用（§6.3）
//
// 后续：备份/导出时连带 -wal/-shm（§6.3）、写队列细化。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
// `manage` 来自 Manager trait，必须显式引入。
use tauri::{App, AppHandle, Manager};

/// 数据库状态：全局唯一连接，受 Mutex 保护以实现写串行化。
/// 所有命令通过 `State<DbState>` 获取连接，写操作天然互斥。
pub struct DbState(pub Mutex<Connection>);

/// 本次进程**实际打开**的数据库文件路径。
/// 与 `app_settings` 里的「配置目录」区分：改了数据目录要重启才生效，
/// 重启前两者会不一致，设置页据此提示「需重启」。
pub struct DbPathState(pub PathBuf);

/// 版本化迁移脚本表：(版本号, SQL)。
/// 追加式：新迁移永远追加在末尾，绝不修改已发布脚本（AGENTS §6.3）。
const MIGRATIONS: &[(i32, &str)] = &[(1, include_str!("migrations/0001_init.sql"))];

/// 在 setup 阶段打开数据库、跑迁移并注册到 Tauri 状态。
pub fn init(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    // 数据根目录由 `storage` 解析：默认 app_data_dir/WorkBench，
    // 用户可在设置页改到别的盘（引导配置见 storage.rs，AGENTS §20）。
    // 主库路径经 `storage::db_path` 取，⛔ 不要在这里手拼文件名。
    let root = crate::storage::data_root(app.handle())?;
    std::fs::create_dir_all(&root)?;
    let db_path = crate::storage::db_path(app.handle())?;

    // 「从备份恢复」的收尾：上次请求恢复时只写了待替换文件（原因见
    // `storage::restore_pending_path`）。这里是启动早期**还没有任何连接**的窗口，
    // 删 -wal/-shm、换库都安全；等连接打开后再动就是库损坏。
    apply_pending_restore(app.handle(), &db_path);

    let conn = Connection::open(&db_path)?;
    // WAL 模式会产生 -wal/-shm 附属文件，备份/导出时必须一并复制（AGENTS §6.3）。
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; \
         PRAGMA busy_timeout=5000; \
         PRAGMA foreign_keys=ON;",
    )?;

    // 启动期单线程跑迁移（AGENTS §5.x：迁移期间不并发写）。
    run_migrations(&conn)?;

    app.manage(DbState(Mutex::new(conn)));
    app.manage(DbPathState(db_path.clone()));
    log::info!("database ready at {db_path:?}");
    Ok(())
}

/// 把上一次「从备份恢复」写入的待替换文件换成主库。
///
/// 🔴 顺序很重要：先删 `-wal` / `-shm`（它们属于**旧库**），再换主库文件。
/// 反过来的话 SQLite 会把一个不属于自己的 WAL 回放到换过的库上 —— 那就是库损坏。
/// 也因此这件事只能在**打开连接之前**做。
fn apply_pending_restore(app: &AppHandle, db_path: &Path) {
    let Ok(pending) = crate::storage::restore_pending_path(app) else {
        return;
    };
    if !pending.exists() {
        return;
    }
    for sidecar in crate::storage::db_sidecars(db_path) {
        if sidecar.exists() {
            if let Err(e) = std::fs::remove_file(&sidecar) {
                log::warn!("remove stale {sidecar:?} failed: {e}");
            }
        }
    }
    match std::fs::rename(&pending, db_path) {
        Ok(()) => log::info!("applied pending restore: {pending:?} → {db_path:?}"),
        Err(e) => {
            // 换不过去就让待替换文件留在原地，用户还能手工处理 —— ⛔ 绝不删它。
            log::error!("pending restore failed, keeping {pending:?}: {e}");
        }
    }
}

/// 把 WAL 归并进主库（备份 / 迁移前必做，AGENTS §6.3）。
///
/// ⚠️ **只做这一件事就释放锁**：绝不能持有连接去复制文件 ——
/// 复制媒体文件可能要好几秒，这段时间整个应用都写不了库（AGENTS §5.x 长任务不占连接）。
pub fn checkpoint_wal(db: &DbState) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| format!("数据库锁不可用：{e}"))?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|e| format!("归并 WAL 失败：{e}"))
}

/// 依据 PRAGMA user_version 应用未执行的迁移；每个迁移在事务内原子提交。
fn run_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    let current: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    for (version, sql) in MIGRATIONS {
        if *version <= current {
            continue;
        }
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        // user_version 不能在 execute_batch 中参数化，版本号是编译期常量，无注入风险。
        tx.execute_batch(&format!("PRAGMA user_version = {version};"))?;
        tx.commit()?;
        log::info!("applied migration v{version}");
    }
    Ok(())
}
