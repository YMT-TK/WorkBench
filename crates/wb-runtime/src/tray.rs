// 系统托盘 + 「关闭到托盘」（AGENTS §19）。
//
// 桌面应用最容易踩的体验坑：用户想「收起来」却点了右上角 X，进程直接退出、
// 未保存的编辑状态与正在跑的任务全没了。这里把 X 的语义改成「收进托盘」，
// 真正的退出只保留在托盘右键菜单里 —— 显式、不易误触。
//
// 关键点：`CloseRequested` 拦截依赖一个「主动退出」标志位，
// 否则程序自己在退出流程里也会被拦下，导致永远关不掉。

use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::OptionalExtension;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager};

use wb_db::db::DbState;

/// 设置键：关闭窗口时是否最小化到托盘。
/// 存 `app_settings`，值是 JSON（`true` / `false`），与前端 `useAppSetting` 一致。
pub const CLOSE_TO_TRAY_KEY: &str = "close_to_tray";

/// 托盘与菜单项 id（右键菜单事件按此分发）。
const TRAY_ID: &str = "main-tray";
const MENU_SHOW: &str = "tray-show";
const MENU_HIDE: &str = "tray-hide";
const MENU_QUIT: &str = "tray-quit";

/// 进程是否处于「主动退出」流程。托盘菜单「退出」与前端 `app_quit` 会置位。
static QUITTING: AtomicBool = AtomicBool::new(false);

pub fn mark_quitting() {
    QUITTING.store(true, Ordering::SeqCst);
}

pub fn is_quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

/// 读取「关闭到托盘」设置。
/// 读不到（首次启动 / 库未就绪）一律按 `true` 处理 —— 安全默认：
/// 宁可让用户多点一次托盘退出，也别让他误点 X 丢掉整个工作现场。
pub fn close_to_tray_enabled(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<DbState>() else {
        return true;
    };
    let Ok(conn) = state.0.lock() else {
        return true;
    };
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        [CLOSE_TO_TRAY_KEY],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .and_then(|raw| serde_json::from_str::<bool>(&raw).ok())
    .unwrap_or(true)
}

/// 唤出并聚焦主窗口（托盘点击 / 第二个实例启动都走这里）。
///
/// 🔴 顺序很重要：必须**先 unminimize 再校验位置**。
/// 最小化状态下 `outer_position()` 读到的是 Windows 的哨兵坐标 (-32000, -32000)，
/// 直接判断会把「正常最小化的窗口」误判成「跑到屏幕外」，于是一唤出就被强行居中。
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        // 兜底：历史坏 bounds / 显示器被拔掉时，把窗口从屏幕外拉回可见区域。
        crate::window_state::ensure_on_screen(&window);
        let _ = window.set_focus();
        log::info!("托盘唤出主窗口");
    } else {
        log::warn!("托盘唤出失败：找不到 main 窗口");
    }
}

/// 隐藏主窗口到托盘（进程继续驻留）。
pub fn hide_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/// 构建托盘图标与右键菜单（`setup` 阶段调用一次）。
pub fn build(app: &App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, MENU_SHOW, "显示主窗口", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, MENU_HIDE, "隐藏到托盘", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出 WorkBench", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("WorkBench · 桌面工作台（单击还原，右键菜单）")
        .menu(&menu)
        // 左键单击直接唤回窗口；右键才弹菜单。否则「点一下打开」会退化成「点一下出菜单再点一下」。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => show_main(app),
            MENU_HIDE => hide_main(app),
            MENU_QUIT => {
                mark_quitting();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            // 左键单击 / 双击都唤回窗口。
            // Windows 上若图标被折叠进「隐藏的图标」溢出区，底层可能取不到图标矩形而吞掉事件，
            // 双击也算一条并行通路，降低「点了没反应」的概率。
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => {
                log::info!("托盘左键点击（{:?}），唤出主窗口", event);
                show_main(tray.app_handle());
            }
            _ => {}
        });

    // 复用应用图标：tauri-build 已在编译期内嵌并解码，无需再引 image-png 特性。
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}
