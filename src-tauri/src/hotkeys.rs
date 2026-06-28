//! 全局热键:settings.hotkeys(动作 → 加速键)与 tauri-plugin-global-shortcut
//! 的注册状态同步;按键触发对应系统动作。

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::state::AppState;
use crate::{commands, tray};

/// 以 settings.hotkeys 为准重注册全部热键(启动与每次保存设置后调用)。
pub fn sync(app: &AppHandle) {
    let gs = app.global_shortcut();
    if let Err(e) = gs.unregister_all() {
        log::warn!("清空热键失败: {e}");
    }
    let hotkeys = app.state::<AppState>().settings_snapshot().hotkeys;
    for (action, accel) in hotkeys {
        if accel.trim().is_empty() {
            continue;
        }
        let act = action.clone();
        let result = gs.on_shortcut(accel.as_str(), move |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                dispatch(app, &act);
            }
        });
        if let Err(e) = result {
            log::warn!("注册热键 {action}={accel} 失败: {e}");
        }
    }
}

/// 热键动作分发(键名与前端 HOTKEY_ACTIONS 约定一致)。
fn dispatch(app: &AppHandle, action: &str) {
    match action {
        "show-window" => {
            if let Some(win) = app.get_webview_window("main") {
                if win.is_visible().unwrap_or(false) {
                    let _ = win.hide();
                } else {
                    tray::show_main_window(app);
                }
            }
        }
        "toggle-sysproxy" => {
            let enable = !app.state::<AppState>().settings_snapshot().sys_proxy;
            if let Err(e) = commands::apply_sys_proxy(app, enable) {
                log::warn!("热键切换系统代理失败: {e}");
            }
            tray::sync_tray(app);
        }
        "toggle-tun" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let enable = !app.state::<AppState>().settings_snapshot().tun;
                if let Err(e) = commands::apply_tun(&app, enable).await {
                    log::warn!("热键切换 TUN 失败: {e}");
                }
                tray::sync_tray(&app);
            });
        }
        "cycle-mode" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let cur = app.state::<AppState>().settings_snapshot().mode;
                let next = match cur.as_str() {
                    "rule" => "global",
                    "global" => "direct",
                    _ => "rule",
                };
                if let Err(e) = commands::apply_mode(&app, next.into()).await {
                    log::warn!("热键轮换模式失败: {e}");
                }
                tray::sync_tray(&app);
            });
        }
        other => log::warn!("未知热键动作: {other}"),
    }
}
