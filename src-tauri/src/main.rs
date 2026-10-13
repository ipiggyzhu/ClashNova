//! ClashNova v2 入口:插件注册、全局状态、托盘、启动恢复。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod autostart;
mod backup;
mod commands;
mod core;
mod core_update;
mod diagnostics;
mod hotkeys;
mod media;
mod profiles;
mod protocol;
mod service;
mod service_host;
mod service_installer;
mod service_manager;
mod service_paths;
mod state;
mod stats;
mod sysproxy_win;
mod tray;
mod tray_panel;
mod update_io;
mod updater;

use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_log::{Target, TargetKind};

use crate::state::AppState;

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn write_service_result(args: &[String], ok: bool, message: &str) {
    if let Some(path) = arg_value(args, "--result") {
        let _ = service_paths::write_helper_result(std::path::Path::new(&path), ok, message);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // 服务进程路径: 通过 Windows Service Control Manager 调度
    if args.iter().any(|a| a == "--service") {
        // Windows 服务必须通过 SCM dispatcher 启动
        service_host::run_dispatcher();
        return;
    }

    // 提权启动已安装服务（由 runas/UAC 调用）
    if args.iter().any(|a| a == "--start-service") {
        match service::start() {
            Ok(_) => {
                write_service_result(&args, true, "服务启动成功");
                std::process::exit(0);
            }
            Err(e) => {
                write_service_result(&args, false, &e);
                eprintln!("服务启动失败: {e}");
                std::process::exit(1);
            }
        }
    }

    // 提权安装/卸载服务（由 runas/UAC 调用）
    if args.iter().any(|a| a == "--install-service") {
        let dir = arg_value(&args, "--dir").map(std::path::PathBuf::from);
        if let Some(dir) = dir {
            match service::install(&dir) {
                Ok(_) => {
                    write_service_result(&args, true, "服务安装成功");
                    std::process::exit(0);
                }
                Err(e) => {
                    write_service_result(&args, false, &e);
                    eprintln!("服务安装失败: {e}");
                    std::process::exit(1);
                }
            }
        } else {
            write_service_result(&args, false, "缺少 --dir 参数");
            eprintln!("缺少 --dir 参数");
            std::process::exit(1);
        }
    }
    if args.iter().any(|a| a == "--uninstall-service") {
        match service::uninstall() {
            Ok(_) => {
                write_service_result(&args, true, "服务卸载成功");
                std::process::exit(0);
            }
            Err(e) => {
                write_service_result(&args, false, &e);
                eprintln!("服务卸载失败: {e}");
                std::process::exit(1);
            }
        }
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
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            protocol::enqueue_args(app, &args);
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
            None,
        ))
        .manage(app_state)
        .manage(protocol::PendingImports::default())
        .manage(updater::Updater::default())
        .manage(media::MediaProbes::default())
        .manage(diagnostics::Diagnostics::default())
        .invoke_handler(tauri::generate_handler![
            tray_panel::tray_panel_visible,
            tray_panel::hide_tray_panel,
            tray_panel::tray_open_main,
            tray_panel::tray_quit_app,
            commands::get_settings,
            commands::save_settings,
            commands::patch_settings,
            commands::core_status,
            commands::start_core,
            commands::stop_core,
            commands::restart_core,
            commands::list_profiles,
            commands::import_profile,
            commands::import_profile_file,
            commands::update_profile,
            commands::update_profile_meta,
            commands::select_profile,
            commands::delete_profile,
            commands::read_profile,
            commands::list_profile_rule_targets,
            commands::save_profile_content,
            commands::read_profile_topology,
            commands::save_profile_topology,
            commands::list_global_enhancers,
            protocol::pending_profile_imports,
            protocol::dismiss_profile_import,
            protocol::confirm_profile_import,
            commands::read_enhancer,
            commands::save_enhancer,
            commands::delete_enhancer,
            commands::toggle_enhancer,
            commands::reorder_enhancers,
            commands::set_system_proxy,
            commands::set_tun,
            commands::set_mode,
            commands::open_app_dir,
            commands::open_url,
            commands::service_status,
            commands::check_tun_adapter,
            commands::probe_url,
            media::media_probe,
            media::media_cancel,
            diagnostics::diagnostics_run,
            commands::install_service,
            commands::start_service,
            commands::uninstall_service,
            commands::reinstall_service,
            commands::repair_service,
            commands::exempt_uwp_loopback,
            commands::check_update,
            commands::reset_settings,
            commands::query_traffic_series,
            commands::query_traffic_rank,
            commands::query_traffic_summary,
            commands::get_platform,
            commands::get_runtime_config,
            backup::backup_list,
            backup::backup_create,
            backup::backup_delete,
            backup::backup_export,
            backup::backup_import,
            backup::backup_preview,
            backup::backup_restore,
            backup::backup_webdav_get,
            backup::backup_webdav_save,
            backup::backup_webdav_list,
            backup::backup_webdav_upload,
            backup::backup_webdav_download,
            backup::backup_webdav_delete,
            updater::get_update_state,
            updater::check_app_update,
            updater::check_core_update,
            updater::download_app_update,
            updater::download_core_update,
            updater::cancel_update,
            updater::install_app_update,
            updater::switch_core_version,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            // 已获得单实例后才清理，二次协议唤起不能删除主实例正在下载的安装包。
            updater::cleanup_stale_downloads(&handle.state::<AppState>().dirs.config);
            tray::create(&handle)?;
            protocol::enqueue_args(&handle, &args);

            let settings = handle.state::<AppState>().settings_snapshot();
            autostart::sync_if_enabled(&handle, &settings);

            // 初始化服务管理器
            let service_manager = service_manager::get_service_manager();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = service_manager.init().await {
                    log::warn!("服务管理器初始化失败: {}", e);
                }
            });

            // 静默启动(或带 --silent 参数)时仅驻留托盘; 主窗口 create=false, 不显示就不创建 WebView。
            let silent = settings.silent_start || std::env::args().any(|a| a == "--silent");
            if !silent || !protocol::pending_profile_imports(handle.clone())?.is_empty() {
                tray::show_main_window(&handle);
            }

            // 文件迁移、配置预检和进程启动不占用窗口主线程。
            let startup_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                let result = {
                    let state = startup_handle.state::<AppState>();
                    let _configuration = state.config_lock.lock().await;
                    let worker = startup_handle.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        profiles::initialize(&worker)?;
                        profiles::regenerate_runtime(&worker)?;
                        core::start(&worker)
                    })
                    .await
                    .map_err(|err| err.to_string())
                    .and_then(|result| result)
                };
                if let Err(err) = result {
                    log::error!("启动内核失败: {err}");
                    if service::is_running() && commands::is_service_ipc_failure(&err) {
                        if let Err(repair) = commands::repair_service(startup_handle.clone()).await
                        {
                            log::error!("启动阶段自动修复服务失败: {repair}");
                        }
                    }
                } else if let Err(err) = service_manager::get_service_manager().refresh().await {
                    log::debug!("启动后刷新服务状态失败: {err}");
                }
            });

            // 恢复系统代理与守卫、注册全局热键
            if settings.sys_proxy {
                if let Err(e) = sysproxy_win::apply(&settings) {
                    log::error!("恢复系统代理失败: {e}");
                }
            }
            sysproxy_win::restart_guard(&handle);
            if let Err(err) = hotkeys::sync(&handle) {
                log::warn!("{err}");
            }
            profiles::spawn_updater(handle.clone());
            stats::spawn_collector(handle.clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "tray" {
                match event {
                    WindowEvent::Focused(false) => { let _ = tray_panel::hide(window.app_handle()); }
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = tray_panel::hide(window.app_handle());
                    }
                    _ => {}
                }
                return;
            }
            // 普通驻留保留窗口；轻量驻留销毁 WebView，由托盘/热键/协议重新创建。
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && !window.state::<AppState>().settings_snapshot().lightweight_on_close {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("ClashNova 初始化失败")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = &event {
                api.prevent_exit();
            }
            if matches!(event, tauri::RunEvent::Exit) {
                stats::flush_on_exit(app);
            }
        });
}
