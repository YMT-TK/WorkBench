// 窗体尺寸与位置持久化（AGENTS §14 窗体适配）。
// 启动时恢复上次 bounds；resized/moved 时落盘到 app_data_dir/WorkBench/window.json。
// 不依赖数据库，使用独立 JSON，便于在 migration 体系之外稳定运行。
//
// ⛔ 三条必须守住的防线（真实踩过的坑，见 AGENTS §14.2）：
//   1) **最小化时禁止落盘**。Windows 会把最小化窗口挪到 (-32000, -32000)、尺寸也变成图标大小，
//      直接存下去，下次启动就会把窗口「还原」到屏幕外 —— 表现为「程序在跑、日志正常，
//      但点托盘图标/任务栏怎么都调不出窗口」。
//   2) **落盘与还原都要校验矩形是否真的落在某块显示器上**。显示器拔掉、分辨率变化后，
//      旧坐标同样会把窗口丢到看不见的地方。
//   3) **最大化状态单独记标志位**。最大化时 `outer_position/outer_size` 返回的是「最大化后的
//      矩形」（如 (-9,-9) 1938x1038），直接当正常尺寸存，会让下次启动出现
//      「看起来占满屏幕、但其实没最大化」的怪窗口。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

/// 至少要有这么多像素落在某块显示器内，才认为窗口「看得见」。
const MIN_VISIBLE_PX: i64 = 80;

/// 找不到可用记录时的兜底尺寸（与 `tauri.conf.json` 的默认窗口一致）。
const FALLBACK_W: u32 = 1100;
const FALLBACK_H: u32 = 720;

/// 窗口位置与尺寸（物理像素）+ 是否最大化。
///
/// `maximized` 用 `#[serde(default)]`，保证旧版本写下的 JSON（没有该字段）仍可解析。
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
}

fn bounds_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("WorkBench").join("window.json"))
}

fn read_bounds(app: &AppHandle) -> Option<WindowBounds> {
    let path = bounds_path(app)?;
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str::<WindowBounds>(&data).ok()
}

fn write_bounds(app: &AppHandle, bounds: &WindowBounds) {
    let Some(path) = bounds_path(app) else {
        return;
    };
    if let Ok(json) = serde_json::to_string(bounds) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(path, json);
    }
}

/// 矩形是否至少有一部分落在某块显示器上（多屏逐块求交集）。
///
/// 返回 `true` 表示「看得见」。查询显示器失败时保守放行（不误伤正常窗口）。
fn rect_visible_on_monitors(window: &WebviewWindow, x: i32, y: i32, w: u32, h: u32) -> bool {
    let (x, y, w, h) = (x as i64, y as i64, w as i64, h as i64);
    // 最小化哨兵坐标 + 明显不合理的尺寸，直接判为不可用。
    if x <= -30000 || y <= -30000 || w < 100 || h < 60 {
        return false;
    }
    let Ok(monitors) = window.available_monitors() else {
        return true;
    };
    monitors.iter().any(|m| {
        let mp = m.position();
        let ms = m.size();
        let (mx, my) = (mp.x as i64, mp.y as i64);
        let (mw, mh) = (ms.width as i64, ms.height as i64);
        let overlap_x = (x + w).min(mx + mw) - x.max(mx);
        let overlap_y = (y + h).min(my + mh) - y.max(my);
        overlap_x >= MIN_VISIBLE_PX && overlap_y >= MIN_VISIBLE_PX
    })
}

/// 读取当前窗口 rect 并判断是否可见；读不到时保守返回 `true`。
///
/// 位置用 `outer_position()`（含边框左上角）、尺寸用 `inner_size()`：
/// 必须与还原时调用的 `set_position()` / `set_size()` 一一对应，否则会漂移（见 §14.2 注）。
fn current_rect_visible(window: &WebviewWindow) -> bool {
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return true;
    };
    rect_visible_on_monitors(window, pos.x, pos.y, size.width, size.height)
}

/// 启动时恢复上次窗口位置/尺寸。
///
/// 只有通过「落在某块显示器上」校验的 bounds 才会被采用；否则丢弃并抹掉坏文件，
/// 回退到 tauri.conf 的默认尺寸 + 屏幕居中（见文件头 §14.2 防线 2）。
pub fn restore(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(b) = read_bounds(app) else {
        return;
    };

    if !rect_visible_on_monitors(&window, b.x, b.y, b.width, b.height) {
        log::warn!(
            "窗口 bounds 不可用 ({}, {}) {}x{}（屏幕外或最小化哨兵值），已丢弃并居中",
            b.x,
            b.y,
            b.width,
            b.height
        );
        if let Some(path) = bounds_path(app) {
            let _ = fs::remove_file(path);
        }
        let _ = window.center();
        return;
    }

    let _ = window.set_position(PhysicalPosition::new(b.x, b.y));
    let _ = window.set_size(PhysicalSize::new(b.width, b.height));
    // 先摆好「正常尺寸」，再最大化 —— 这样用户下次还原（取消最大化）能落回原尺寸，而不是最大化矩形。
    if b.maximized {
        let _ = window.maximize();
    }
    log::info!(
        "窗口 bounds 已还原: ({}, {}) {}x{} maximized={}",
        b.x,
        b.y,
        b.width,
        b.height,
        b.maximized
    );
}

/// 保存当前窗口位置/尺寸（由 resized/moved 事件触发）。
pub fn save(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    // 防线 1：最小化 / 隐藏（收进托盘）期间，Windows 报出的几何信息不是用户期望的位置，
    // 一律不落盘。`unwrap_or` 的默认值取「不拦」——查询失败时宁可正常保存。
    if window.is_minimized().unwrap_or(false) || !window.is_visible().unwrap_or(true) {
        return;
    }

    let maximized = window.is_maximized().unwrap_or(false);
    // ⚠️ 尺寸必须取 `inner_size()`：还原用的 `set_size()` 底层是 `set_inner_size()`，
    // 而 `outer_size()` 含标题栏与边框（实测差 18x47px）。存外在、设内在 → 每重启一次涨一圈。
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };

    let bounds = if maximized {
        // 防线 3：最大化时 `outer_*` 是最大化矩形，只更新标志位，保留上一次的正常尺寸。
        let mut prev = read_bounds(app).unwrap_or(WindowBounds {
            x: pos.x,
            y: pos.y,
            width: FALLBACK_W,
            height: FALLBACK_H,
            maximized: true,
        });
        prev.maximized = true;
        prev
    } else {
        // 防线 2：屏幕外的坐标不写盘，避免把坏值传给下一次启动。
        if !rect_visible_on_monitors(&window, pos.x, pos.y, size.width, size.height) {
            log::warn!(
                "跳过屏幕外的窗口 bounds ({}, {}) {}x{}",
                pos.x,
                pos.y,
                size.width,
                size.height
            );
            return;
        }
        WindowBounds {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            maximized: false,
        }
    };

    write_bounds(app, &bounds);
}

/// 兜底：把窗口从屏幕外拉回可见区域（历史坏 bounds / 显示器被拔掉后再次显示）。
///
/// 由 `tray::show_main` 在 `show()` + `unminimize()` 之后调用，保证「点了托盘一定看得见」。
pub fn ensure_on_screen(window: &WebviewWindow) {
    if !current_rect_visible(window) {
        if let Ok(pos) = window.outer_position() {
            log::warn!("主窗口不在可见区域 ({}, {})，重新居中", pos.x, pos.y);
        }
        let _ = window.center();
    }
}

/// 诊断：把窗口最终几何信息写进日志（`dev:app` 排障时肉眼可确认窗口没落在屏幕外）。
pub fn log_bounds(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) {
            log::info!(
                "main window at ({}, {}) inner {}x{} · maximized={} · visible_on_screen={}",
                pos.x,
                pos.y,
                size.width,
                size.height,
                window.is_maximized().unwrap_or(false),
                current_rect_visible(&window)
            );
        }
    }
}
