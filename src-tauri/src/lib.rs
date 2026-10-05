// WorkBench 桌面应用入口（Tauri 2）。
//
// 🔴 本文件是**应用壳**：只做「编排」—— 初始化顺序 + 命令清单，不实现任何平台能力。
//    平台能力来自两个 crate（AGENTS §3 规约 7 / §21）：
//      · `wb-db`      数据「在哪 / 怎么存」—— 目录布局 + 连接 + 迁移执行器
//      · `wb-runtime` 平台「能做什么」—— 密钥 / 备份 / 换目录迁移 / 跨机导入 / 托盘 / 窗口 bounds
//    新项目从 `templates/app` 生成时，改的就是本文件的编排、`tauri.conf.json` 与图标。
//
// ⚠️ 命令一律写**完整 crate 路径**（`wb_runtime::get_setting`），不要先 `use` 进来再写短名：
//    `generate_handler!` 会把路径末段换成 `__cmd__` 前缀去找包装宏，而那条宏只落在
//    `wb-runtime` 的 crate 根 —— 短名会让它去应用壳里找，找不到。详见 `wb-runtime/src/lib.rs` 的说明。

use std::path::PathBuf;

use serde::Serialize;
use tauri::{Emitter, Manager};
use wb_db::{db, storage};
use wb_runtime::{backup, tray, window_state};

/// 第二实例启动时的转发载荷（经 Tauri 事件发给前端，AGENTS §9 任务4）。
/// 前端用 `listen("secondary-instance", ...)` 接收。
#[derive(Clone, Serialize)]
struct SecondaryInstancePayload {
    args: Vec<String>,
    cwd: String,
}

/// 解析日志目录：`<数据根目录>/logs`（设计文档 §7.5）。
/// 🔴 跟随用户自定义的数据根目录 —— 此前固定在 `app_data_dir`，与其余内容不一致。
fn log_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    storage::logs_dir(app).ok()
}

/// 安装崩溃兜底：panic 时写独立 `crash-*.log`，便于下次启动提示上报（AGENTS §11）。
fn install_panic_hook(dir: PathBuf) {
    std::panic::set_hook(Box::new(move |info| {
        let detail = format!("{info}");
        log::error!("panic: {detail}");
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = std::fs::create_dir_all(&dir);
        // 崩溃日志与常规调试日志分离存放，便于用户上报。
        let _ = std::fs::write(
            dir.join(format!("crash-{secs}.log")),
            format!("[{secs}] {detail}\n"),
        );
    }));
}

/// dev-only 运行期自检（AGENTS §11 排障能力）。
///
/// 真机排障时常常「看不到窗口、也看不到 webview 控制台」，
/// 这里让 webview 主动把关键状态以 HTTP 请求回报给 Vite dev server，
/// 于是「前端是否真正加载 / Tauri IPC 桥是否存在 / React 是否渲染」都可在 dev server 日志里看到。
#[cfg(debug_assertions)]
fn spawn_dev_self_check(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(8));
        let js = r#"(function () {
  try {
    var diag = {
      internals: typeof window.__TAURI_INTERNALS__,
      invoke: (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke) || 'none',
      rootChildren: (document.getElementById('root') || { children: [] }).children.length,
      bodyLen: document.body ? document.body.innerHTML.length : -1,
      text: (document.body ? document.body.innerText : '').slice(0, 200).replace(/\s+/g, ' ')
    };
    fetch('/__diag?' + encodeURIComponent(JSON.stringify(diag)));
  } catch (e) {
    fetch('/__diag?error=' + encodeURIComponent(String(e)));
  }
})();"#;
        let _ = window.eval(js);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例：第二个进程把参数转发给已运行实例并退出，
        // 确保同一 workbench.db 只有一个写者（AGENTS §5.x 单边锁 · 进程层）。
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // 复用托盘那条唤窗路径：show → unminimize → 位置兜底 → focus，
            // 保证「再次双击 exe」也能把被收进托盘 / 跑到屏幕外的窗口调出来。
            tray::show_main(app);
            // 经 Tauri 事件把第二实例的参数转发给前端（前端 listen 接收）。
            let _ = app.emit(
                "secondary-instance",
                SecondaryInstancePayload { args: argv, cwd },
            );
        }))
        // 系统文件对话框（设计文档 §7.6）：跨机导入要选「备份包目录 + .wbkey」，
        // 从 U 盘 / 下载目录里挑文件时手输路径太容易错。
        .plugin(tauri_plugin_dialog::init())
        // 系统级初始化。
        .setup(|app| {
            let handle = app.app_handle().clone();
            let logs = log_dir(&handle);

            // 调试日志：写入 <数据根目录>/logs/，按大小滚动、保留最近 10 份（AGENTS §11）。
            if let Some(dir) = logs.clone() {
                let _ = std::fs::create_dir_all(&dir);
                handle.plugin(
                    tauri_plugin_log::Builder::new()
                        .target(tauri_plugin_log::Target::new(
                            tauri_plugin_log::TargetKind::Folder {
                                path: dir.clone(),
                                file_name: Some("workbench".into()),
                            },
                        ))
                        .max_file_size(5_000_000)
                        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(10))
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
                // panic 兜底（AGENTS §11：崩溃日志独立存放）
                install_panic_hook(dir);
            }

            db::init(app).expect("failed to initialize database");

            // 自动备份（设置项 `backup.auto = on_start`）：后台线程跑，不拖慢启动。
            // 放在 db 初始化之后 —— 此时库文件已就位，快照才有内容。
            backup::run_auto_if_enabled(&handle);

            // 系统托盘 +「关闭到托盘」（AGENTS §19）：
            // 顶栏 X 默认只把窗口收进托盘，真正退出只留在托盘右键菜单里，避免误点丢工作现场。
            // 托盘创建失败（受限环境）不应拖垮整个程序，记日志后继续跑。
            if let Err(err) = tray::build(app) {
                log::error!("failed to create system tray: {err}");
            } else {
                log::info!(
                    "system tray ready (close_to_tray = {})",
                    tray::close_to_tray_enabled(&handle)
                );
            }

            // 窗体尺寸持久化（AGENTS §14）：恢复上次 bounds，并监听变化保存。
            window_state::restore(&handle);
            // 诊断：把最终几何信息落日志，肉眼可确认窗口没被丢到屏幕外（AGENTS §14.2）。
            window_state::log_bounds(&handle);
            if let Some(window) = app.get_webview_window("main") {
                let h = handle.clone();
                // 监听窗口 resized/moved，落盘 bounds（AGENTS §14）；
                // 并拦截关闭请求，按设置改为「收进托盘」（AGENTS §19）。
                let _ = window.on_window_event(move |event| match event {
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                        window_state::save(&h);
                    }
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        // 主动退出（托盘菜单/前端命令）时放行，否则会把自己也拦下、永远关不掉。
                        if !tray::is_quitting() && tray::close_to_tray_enabled(&h) {
                            api.prevent_close();
                            tray::hide_main(&h);
                        }
                    }
                    _ => {}
                });
            }
            // dev-only：启动后回报 webview 内部状态（排障用，release 不编译）。
            #[cfg(debug_assertions)]
            spawn_dev_self_check(&handle);
            Ok(())
        })
        // 业务命令注册点（AGENTS §3 规约 5：前端一切系统操作经此）。
        // ⚠️ 与前端 `src/core/shared/api/index.ts` 一一对应；命令名 = 路径末段。
        .invoke_handler(tauri::generate_handler![
            // 设置 / 插件 / 进程
            wb_runtime::get_setting,
            wb_runtime::set_setting,
            wb_runtime::list_plugins,
            wb_runtime::update_plugin,
            // 敏感字段与密钥（设计文档 §8）
            wb_runtime::secure_set_setting,
            wb_runtime::secure_get_setting,
            wb_runtime::key_status,
            wb_runtime::key_export_wbkey,
            wb_runtime::key_import_wbkey,
            wb_runtime::app_quit,
            wb_runtime::app_hide_to_tray,
            // 数据目录（设计文档 §7.3）
            wb_runtime::storage_info,
            wb_runtime::storage_set_dir,
            wb_runtime::storage_open_dir,
            // 备份与恢复（§7.4）
            wb_runtime::backup_create,
            wb_runtime::backup_list,
            wb_runtime::backup_delete,
            wb_runtime::backup_restore,
            wb_runtime::backup_open_dir,
            // 跨机导入（§7.6）
            wb_runtime::wbkey_inspect,
            wb_runtime::import_inspect,
            wb_runtime::import_precheck,
            wb_runtime::import_adopt,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
