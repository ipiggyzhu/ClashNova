//! ClashNova v2 入口:插件注册、全局状态、托盘、启动恢复。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod core;
mod hotkeys;
mod profiles;
mod service;
mod state;
mod stats;
mod sysproxy_win;
mod tray;

use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_log::{Target, TargetKind};

use crate::state::AppState;

fn main() {
    // 服务进程路径: SCM 调度, 不进入 GUI
    if std::env::args().any(|a| a == "--service") {
        service::run_dispatcher();
        return;
    }

    let app_state = match AppState::init() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("ClashNova 初始化失败: {e}");
            std::process::exit(1);
        }
    };
    let log_dir = app_state.dirs.logs.clone();

    tauri::Builder::default()
        // single-instance 必须最先注册:二次启动时聚焦已有窗口
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main_window(app);
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::Folder {
                        path: log_dir,
                        file_name: Some("clashnova".into()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--silent"]),
        ))
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::core_status,
            commands::start_core,
            commands::stop_core,
            commands::restart_core,
            commands::list_profiles,
            commands::import_profile,
            commands::update_profile,
            commands::select_profile,
            commands::delete_profile,
            commands::read_profile,
            commands::save_profile_content,
            commands::read_enhancer,
            commands::save_enhancer,
            commands::delete_enhancer,
            commands::toggle_enhancer,
            commands::set_system_proxy,
            commands::set_tun,
            commands::set_mode,
            commands::open_app_dir,
            commands::open_url,
            commands::service_status,
            commands::install_service,
            commands::uninstall_service,
            commands::exempt_uwp_loopback,
            commands::check_update,
            commands::reset_settings,
            commands::query_traffic_series,
            commands::query_traffic_rank,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tray::create(&handle)?;

            let settings = handle.state::<AppState>().settings_snapshot();

            // 静默启动(或带 --silent 参数)时仅驻留托盘
            let silent = settings.silent_start
                || std::env::args().any(|a| a == "--silent");
            if !silent {
                tray::show_main_window(&handle);
            }

            // 启动内核
            if let Err(e) = core::start(&handle) {
                log::error!("启动内核失败: {e}");
            }

            // 恢复系统代理与守卫、注册全局热键
            if settings.sys_proxy {
                if let Err(e) = sysproxy_win::apply(&settings) {
                    log::error!("恢复系统代理失败: {e}");
                }
            }
            sysproxy_win::restart_guard(&handle);
            hotkeys::sync(&handle);
            stats::spawn_collector(handle.clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭主窗口 → 隐藏到托盘而非退出
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("ClashNova 运行失败");
}
