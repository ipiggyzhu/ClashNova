#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Elevated helper for installing, repairing, or starting the ClashNova service.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

#[path = "../service_host.rs"]
mod service_host;
#[path = "../service_paths.rs"]
mod service_paths;

#[cfg(windows)]
use windows_service::{
    service::{
        ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType, ServiceState,
        ServiceType,
    },
    service_manager::{ServiceManager, ServiceManagerAccess},
};

const SERVICE_NAME: &str = "clashnova-core";
const SERVICE_START_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn write_result(path: Option<&str>, ok: bool, message: &str) {
    if let Some(path) = path {
        let prefix = if ok { "ok" } else { "error" };
        let _ = std::fs::write(path, format!("{prefix}\n{message}\n"));
    }
}

#[cfg(windows)]
fn split_launch_command(command: &Path) -> (String, String) {
    let raw = command.to_string_lossy().trim().to_string();
    let mut chars = raw.chars().peekable();
    let mut exe = String::new();

    if chars.peek() == Some(&'"') {
        chars.next();
        for ch in chars.by_ref() {
            if ch == '"' {
                break;
            }
            exe.push(ch);
        }
    } else {
        while let Some(ch) = chars.peek().copied() {
            if ch.is_whitespace() {
                break;
            }
            exe.push(ch);
            chars.next();
        }
    }

    let args = chars.collect::<String>();
    (
        service_paths::normalized_path(Path::new(&exe)),
        args.to_ascii_lowercase(),
    )
}

#[cfg(windows)]
fn service_matches_expected(service: &windows_service::service::Service) -> bool {
    match service.query_config() {
        Ok(config) => {
            let Ok(expected_path) = find_bundled_service_binary() else {
                return false;
            };
            let expected = service_paths::normalized_path(&expected_path);
            let (registered_exe, registered_args) = split_launch_command(&config.executable_path);
            registered_exe == expected && registered_args.contains("--dir")
        }
        Err(_) => false,
    }
}

#[cfg(windows)]
fn wait_until_removed(manager: &ServiceManager) -> Result<(), String> {
    for _ in 0..40 {
        if manager
            .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS)
            .is_err()
        {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    Err("timed out waiting for old service removal".into())
}

#[cfg(windows)]
fn wait_until_running(service: &windows_service::service::Service) -> Result<(), String> {
    let deadline = std::time::Instant::now() + SERVICE_START_WAIT;
    let mut last_state = None;

    while std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(250));
        match service.query_status() {
            Ok(status) if status.current_state == ServiceState::Running => {
                log::info!("service is running");
                return Ok(());
            }
            Ok(status) => last_state = Some(format!("{:?}", status.current_state)),
            Err(err) => last_state = Some(format!("query service status failed: {err}")),
        }
    }

    Err(format!(
        "service start timed out; last state: {}",
        last_state.unwrap_or_else(|| "unknown".into())
    ))
}

#[cfg(windows)]
fn wait_until_stopped(service: &windows_service::service::Service) -> Result<(), String> {
    let deadline = std::time::Instant::now() + SERVICE_START_WAIT;
    let mut last_state = None;

    while std::time::Instant::now() < deadline {
        match service.query_status() {
            Ok(status) if status.current_state == ServiceState::Stopped => {
                log::info!("service is stopped");
                return Ok(());
            }
            Ok(status) => last_state = Some(format!("{:?}", status.current_state)),
            Err(err) => last_state = Some(format!("query service status failed: {err}")),
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }

    Err(format!(
        "service stop timed out; last state: {}",
        last_state.unwrap_or_else(|| "unknown".into())
    ))
}

#[cfg(windows)]
fn app_control_hint(err: &str) -> Option<&'static str> {
    if err.contains("4551")
        || err.contains("应用程序控制策略已阻止此文件")
        || err.contains("blocked by application control policy")
    {
        Some("Windows 应用控制策略阻止了服务程序启动。请先点击“修复”重建服务；如果仍失败，需要在 Windows 安全中心或组织策略中允许 ClashNova 服务程序，或使用已签名版本。")
    } else {
        None
    }
}

#[cfg(windows)]
fn format_service_start_error(prefix: &str, err: impl std::fmt::Display) -> String {
    let message = format!("{prefix}: {err}");
    match app_control_hint(&message) {
        Some(hint) => format!("{message}\n{hint}"),
        None => message,
    }
}

#[cfg(windows)]
fn start_existing_service(service: &windows_service::service::Service) -> Result<(), String> {
    match service.query_status() {
        Ok(status) if status.current_state == ServiceState::Running => return Ok(()),
        Ok(status) if status.current_state == ServiceState::StartPending => {
            return wait_until_running(service);
        }
        Ok(status) if status.current_state == ServiceState::Stopped => {}
        Ok(status) if status.current_state == ServiceState::StopPending => {
            wait_until_stopped(service)?
        }
        Ok(_) => {
            service
                .stop()
                .map_err(|e| format!("failed to stop existing service: {e}"))?;
            wait_until_stopped(service)?;
        }
        Err(err) => return Err(format!("query existing service status failed: {err}")),
    }

    service.start(&Vec::<&OsStr>::new()).map_err(|e| {
        format_service_start_error("failed to start existing service", format!("{e} ({e:?})"))
    })?;
    wait_until_running(service)
}

#[cfg(windows)]
fn find_bundled_service_binary() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("locate helper failed: {e}"))?;
    let helper_dir = exe
        .parent()
        .ok_or_else(|| "helper executable has no parent directory".to_string())?;
    service_paths::find_bundled_service_binary(helper_dir)
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let args: Vec<String> = std::env::args().collect();
    let result_path = arg_value(&args, "--result");
    let action = arg_value(&args, "--action").unwrap_or_else(|| "install".to_string());

    let config_dir = match arg_value(&args, "--dir") {
        Some(dir) => PathBuf::from(dir),
        None => {
            let message = "missing --dir argument";
            write_result(result_path.as_deref(), false, message);
            eprintln!("{message}");
            std::process::exit(1);
        }
    };

    let result = match action.as_str() {
        "install" | "repair" | "start" => install_or_repair(&config_dir),
        other => Err(format!("unknown service action: {other}")),
    };
    let success_message = if action == "start" {
        "service started"
    } else {
        "service installed"
    };

    match result {
        Ok(()) => {
            log::info!("{success_message}");
            println!("{success_message}");
            write_result(result_path.as_deref(), true, success_message);
            std::process::exit(0);
        }
        Err(err) => {
            log::error!("service action failed: {err}");
            eprintln!("service action failed: {err}");
            write_result(result_path.as_deref(), false, &err);
            std::process::exit(1);
        }
    }
}

#[cfg(windows)]
fn install_or_repair(config_dir: &Path) -> Result<(), String> {
    log::info!("installing or repairing service {}", SERVICE_NAME);

    let bundled_exe = find_bundled_service_binary()?;
    let launch_args = service_host::expected_launch_args(config_dir);
    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )
    .map_err(|e| format!("connect to service manager failed; admin rights required: {e}"))?;

    let service_access = ServiceAccess::QUERY_STATUS
        | ServiceAccess::QUERY_CONFIG
        | ServiceAccess::START
        | ServiceAccess::STOP
        | ServiceAccess::DELETE
        | ServiceAccess::CHANGE_CONFIG;

    if let Ok(service) = manager.open_service(SERVICE_NAME, service_access) {
        if !service_matches_expected(&service) {
            log::warn!("existing service points to a stale path; recreating it");
            let _ = service.stop();
            let _ = wait_until_stopped(&service);
            service
                .delete()
                .map_err(|e| format!("delete stale service failed: {e}"))?;
            drop(service);
            wait_until_removed(&manager)?;
        } else {
            if matches!(
                service.query_status().map(|s| s.current_state),
                Ok(ServiceState::Running) | Ok(ServiceState::StartPending)
            ) {
                start_existing_service(&service)?;
                return Ok(());
            }
            start_existing_service(&service)?;
            return Ok(());
        }
    }

    let service_info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from("ClashNova Core Service"),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: bundled_exe,
        launch_arguments: launch_args,
        dependencies: vec![],
        account_name: None,
        account_password: None,
    };

    let service = manager
        .create_service(
            &service_info,
            ServiceAccess::CHANGE_CONFIG | ServiceAccess::START | ServiceAccess::QUERY_STATUS,
        )
        .map_err(|e| format!("create service failed: {e}"))?;

    service
        .set_description("ClashNova core service for TUN mode without an elevated GUI")
        .map_err(|e| format!("set service description failed: {e}"))?;
    service
        .start(&Vec::<&OsStr>::new())
        .map_err(|e| format_service_start_error("start service failed", format!("{e} ({e:?})")))?;
    wait_until_running(&service)
}

#[cfg(not(windows))]
fn install_or_repair(_config_dir: &Path) -> Result<(), String> {
    Err("service mode is only supported on Windows".into())
}
