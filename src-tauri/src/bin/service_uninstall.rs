#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Elevated helper for uninstalling the ClashNova service.

#[path = "../service_paths.rs"]
mod service_paths;

#[cfg(windows)]
use windows_service::{
    service::{ServiceAccess, ServiceState},
    service_manager::{ServiceManager, ServiceManagerAccess},
};

const SERVICE_NAME: &str = "clashnova-core";

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
fn wait_until_stopped(service: &windows_service::service::Service) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut last_state = None;

    while std::time::Instant::now() < deadline {
        match service.query_status() {
            Ok(status) if status.current_state == ServiceState::Stopped => return Ok(()),
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
fn is_service_not_found(err: &str) -> bool {
    err.contains("does not exist")
        || err.contains("not exist")
        || err.contains("1060")
        || err.contains("ERROR_SERVICE_DOES_NOT_EXIST")
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let args: Vec<String> = std::env::args().collect();
    let result_path = arg_value(&args, "--result");

    match uninstall() {
        Ok(()) => {
            let message = "service uninstalled";
            log::info!("{message}");
            println!("{message}");
            write_result(result_path.as_deref(), true, message);
            std::process::exit(0);
        }
        Err(err) => {
            log::error!("service uninstall failed: {err}");
            eprintln!("service uninstall failed: {err}");
            write_result(result_path.as_deref(), false, &err);
            std::process::exit(1);
        }
    }
}

#[cfg(windows)]
fn uninstall() -> Result<(), String> {
    log::info!("uninstalling service {}", SERVICE_NAME);

    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| format!("connect to service manager failed; admin rights required: {e}"))?;

    let service = match manager.open_service(
        SERVICE_NAME,
        ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
    ) {
        Ok(service) => service,
        Err(e) => {
            let message = e.to_string();
            if is_service_not_found(&message) {
                service_paths::remove_managed_service_binary()?;
                return Ok(());
            }
            return Err(format!("open service failed: {message}"));
        }
    };

    if let Ok(status) = service.query_status() {
        if status.current_state != ServiceState::Stopped {
            service
                .stop()
                .map_err(|e| format!("stop service failed: {e}"))?;
            wait_until_stopped(&service)?;
        }
    }

    service
        .delete()
        .map_err(|e| format!("delete service failed: {e}"))?;
    drop(service);
    wait_until_removed(&manager)?;
    service_paths::remove_managed_service_binary()?;
    Ok(())
}

#[cfg(not(windows))]
fn uninstall() -> Result<(), String> {
    Err("service mode is only supported on Windows".into())
}
