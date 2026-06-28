//! 托盘:图标 + 菜单(显示主窗口/系统代理/TUN/出站模式/退出),
//! 菜单勾选态经 `sync_tray` 与设置保持一致;左键单击唤起主窗口。

use tauri::menu::{CheckMenuItem, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::state::AppState;

/// 托盘菜单项句柄(manage 进 Tauri 状态, 供 sync_tray 更新勾选态)。
pub struct TrayHandles {
    sys_proxy: CheckMenuItem<Wry>,
    tun: CheckMenuItem<Wry>,
    mode_direct: CheckMenuItem<Wry>,
    mode_rule: CheckMenuItem<Wry>,
    mode_global: CheckMenuItem<Wry>,
}

/// 创建托盘图标与菜单。
pub fn create(app: &AppHandle) -> Result<(), String> {
    let settings = app.state::<AppState>().settings_snapshot();

    let show = MenuItem::with_id(app, "tray-show", "显示主窗口", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let sys_proxy = CheckMenuItem::with_id(
        app,
        "tray-sysproxy",
        "系统代理",
        true,
        settings.sys_proxy,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let tun = CheckMenuItem::with_id(
        app,
        "tray-tun",
        "TUN 模式",
        true,
        settings.tun,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let mode_direct = CheckMenuItem::with_id(
        app,
        "tray-mode-direct",
        "直连",
        true,
        settings.mode == "direct",
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let mode_rule = CheckMenuItem::with_id(
        app,
        "tray-mode-rule",
        "规则",
        true,
        settings.mode == "rule",
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let mode_global = CheckMenuItem::with_id(
        app,
        "tray-mode-global",
        "全局",
        true,
        settings.mode == "global",
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let mode_menu = SubmenuBuilder::new(app, "出站模式")
        .item(&mode_direct)
        .item(&mode_rule)
        .item(&mode_global)
        .build()
        .map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出 ClashNova", true, None::<&str>)
        .map_err(|e| e.to_string())?;

    let menu = MenuBuilder::new(app)
        .item(&show)
        .item(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .item(&sys_proxy)
        .item(&tun)
        .item(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .item(&mode_menu)
        .item(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .item(&quit)
        .build()
        .map_err(|e| e.to_string())?;

    app.manage(TrayHandles {
        sys_proxy,
        tun,
        mode_direct,
        mode_rule,
        mode_global,
    });

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "缺少应用图标".to_string())?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("ClashNova")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| format!("创建托盘失败: {e}"))?;
    Ok(())
}

/// 让托盘勾选态与设置一致(设置变更后调用)。
pub fn sync_tray(app: &AppHandle) {
    let settings = app.state::<AppState>().settings_snapshot();
    if let Some(handles) = app.try_state::<TrayHandles>() {
        let _ = handles.sys_proxy.set_checked(settings.sys_proxy);
        let _ = handles.tun.set_checked(settings.tun);
        let _ = handles.mode_direct.set_checked(settings.mode == "direct");
        let _ = handles.mode_rule.set_checked(settings.mode == "rule");
        let _ = handles.mode_global.set_checked(settings.mode == "global");
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "tray-show" => show_main_window(app),
        "tray-quit" => {
            let settings = app.state::<AppState>().settings_snapshot();
            crate::sysproxy_win::clear_on_exit(&settings);
            let _ = crate::core::stop(app);
            app.exit(0);
        }
        "tray-sysproxy" => {
            let enable = !app.state::<AppState>().settings_snapshot().sys_proxy;
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::commands::apply_sys_proxy(&app, enable) {
                    log::error!("托盘切换系统代理失败: {e}");
                }
                sync_tray(&app);
            });
        }
        "tray-tun" => {
            let enable = !app.state::<AppState>().settings_snapshot().tun;
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::commands::apply_tun(&app, enable).await {
                    log::error!("托盘切换 TUN 失败: {e}");
                }
                sync_tray(&app);
            });
        }
        "tray-mode-direct" | "tray-mode-rule" | "tray-mode-global" => {
            let mode = id.trim_start_matches("tray-mode-").to_string();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::commands::apply_mode(&app, mode).await {
                    log::error!("托盘切换模式失败: {e}");
                }
                sync_tray(&app);
            });
        }
        _ => {}
    }
}
