// 预编译入口：仅负责启动，所有应用逻辑在 lib.rs 的 run()。
// 桌面端隐藏控制台窗口；移动端无效（当前未启用）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    workbench_lib::run();
}
