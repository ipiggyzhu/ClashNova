//! Windows service mode for running the core without requiring the GUI process
//! to start elevated. Only install, repair, uninstall, or privileged service
//! start fallback paths should trigger UAC.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

pub use crate::service_host::SERVICE_NAME;

#[cfg(windows)]
use windows_service::{
    service::{
        ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType, ServiceState,
        ServiceType,
    },
    service_manager::{ServiceManager, ServiceManagerAccess},
};

#[cfg(windows)]
fn expected_service_binary_path() -> Result<PathBuf, String> {
    Ok(crate::service_paths::managed_service_binary_path())
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
        crate::service_paths::normalized_path(Path::new(&exe)),
        args.to_ascii_lowercase(),
    )
}

#[cfg(windows)]
fn service_command_matches_expected(launch_command: &Path) -> bool {
    let Ok(expected_exe) = expected_service_binary_path() else {
        return false;
    };
    let (registered_exe, registered_args) = split_launch_command(launch_command);
    registered_exe == crate::service_paths::normalized_path(&expected_exe)
        && registered_args.contains("--dir")
}

#[cfg(windows)]
fn service_matches_expected(service: &windows_service::service::Service) -> bool {
    match service.query_config() {
        Ok(config) => service_command_matches_expected(&config.executable_path),
        Err(_) => false,
    }
}

#[cfg(windows)]
fn diagnose_registered_service() -> Option<String> {
    let manager =
        ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT).ok()?;
    let service = manager
        .open_service(SERVICE_NAME, ServiceAccess::QUERY_CONFIG)
        .ok()?;
    let config = service.query_config().ok()?;

    if service_command_matches_expected(&config.executable_path) {
        return None;
    }

    let registered = config.executable_path.display().to_string();
    let expected = match expected_service_binary_path() {
        Ok(path) => path,
        Err(err) => {
            return Some(format!(
                "service host cannot be located: {err}; please repair the service"
            ));
        }
    };
    Some(format!(
        "service registration is stale: SCM points to `{registered}`, expected `{}` --dir <config_dir>; please repair the service",
        expected.display()
    ))
}

#[cfg(windows)]
pub fn diagnose_installation() -> Result<(), String> {
    cleanup_stale_replacement_marker();

    if status() != "installed" {
        return Ok(());
    }

    if let Some(message) = diagnose_registered_service() {
        return Err(message);
    }

    let expected_exe = expected_service_binary_path()?;
    if !expected_exe.exists() {
        return Err(format!(
            "service registration is stale: bundled service host is missing at {}; please repair the service",
            expected_exe.display()
        ));
    }

    Ok(())
}

#[cfg(windows)]
fn cleanup_stale_replacement_marker() {
    let Ok(current_exe) = std::env::current_exe() else {
        return;
    };
    let Some(install_dir) = current_exe.parent() else {
        return;
    };
    let pending_exe = install_dir.join("clashnova.new.exe");
    if !pending_exe.exists() {
        return;
    }

    let pending_is_stale = std::fs::metadata(&pending_exe)
        .and_then(|pending| {
            let pending_modified = pending.modified()?;
            let current_modified = std::fs::metadata(&current_exe)?.modified()?;
            Ok(pending_modified <= current_modified)
        })
        .unwrap_or(false);

    if pending_is_stale {
        match std::fs::remove_file(&pending_exe) {
            Ok(()) => log::info!(
                "removed stale unfinished replacement file: {}",
                pending_exe.display()
            ),
            Err(err) => log::warn!(
                "failed to remove stale unfinished replacement file {}: {err}",
                pending_exe.display()
            ),
        }
    } else {
        log::warn!(
            "detected unfinished app replacement: {}, current executable is {}",
            pending_exe.display(),
            current_exe.display()
        );
    }
}

#[cfg(not(windows))]
pub fn diagnose_installation() -> Result<(), String> {
    Ok(())
}

pub fn is_repairable_installation_error(err: &str) -> bool {
    err.contains("service registration is stale")
        || err.contains("managed service host is missing")
        || err.contains("SCM points to")
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
fn is_service_not_found(err: &str) -> bool {
    err.contains("does not exist")
        || err.contains("not exist")
        || err.contains("1060")
        || err.contains("ERROR_SERVICE_DOES_NOT_EXIST")
        || err.contains("service does not exist")
}

#[cfg(windows)]
fn wait_until_running(service: &windows_service::service::Service) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut last_state = None;

    while std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(250));
        match service.query_status() {
            Ok(status) if status.current_state == ServiceState::Running => return Ok(()),
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

/// Returns whether the service exists in SCM.
pub fn status() -> &'static str {
    #[cfg(not(windows))]
    return "not-installed";

    #[cfg(windows)]
    {
        let Ok(manager) =
            ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        else {
            return "not-installed";
        };
        let Ok(service) = manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS) else {
            return "not-installed";
        };
        if service.query_status().is_ok() {
            "installed"
        } else {
            "not-installed"
        }
    }
}

/// Returns whether the service is currently RUNNING.
pub fn is_running() -> bool {
    #[cfg(not(windows))]
    return false;

    #[cfg(windows)]
    {
        let Ok(manager) =
            ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        else {
            return false;
        };
        let Ok(service) = manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS) else {
            return false;
        };
        matches!(
            service.query_status().map(|s| s.current_state),
            Ok(ServiceState::Running)
        )
    }
}

#[cfg(windows)]
pub fn stop() -> Result<(), String> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| format!("connect to service manager failed: {e}"))?;
    let service = manager
        .open_service(
            SERVICE_NAME,
            ServiceAccess::QUERY_STATUS | ServiceAccess::STOP,
        )
        .map_err(|e| format!("open service failed: {e}"))?;

    if matches!(
        service.query_status().map(|s| s.current_state),
        Ok(ServiceState::Stopped)
    ) {
        return Ok(());
    }

    service
        .stop()
        .map_err(|e| format!("stop service failed: {e}"))?;
    wait_until_stopped(&service)
}

#[cfg(not(windows))]
pub fn stop() -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
pub fn start() -> Result<(), String> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| format!("connect to service manager failed: {e}"))?;
    let service = manager
        .open_service(
            SERVICE_NAME,
            ServiceAccess::QUERY_STATUS | ServiceAccess::START,
        )
        .map_err(|e| format!("open service failed: {e}"))?;

    if !service_matches_expected(&service) {
        return Err("service registration is stale; repair is required".into());
    }

    let expected_exe = expected_service_binary_path()?;
    if !expected_exe.exists() {
        return Err(format!(
            "service registration is stale: bundled service host is missing at {}; repair is required",
            expected_exe.display()
        ));
    }

    start_existing_service(&service)
}

#[cfg(not(windows))]
pub fn start() -> Result<(), String> {
    Err("service mode is only supported on Windows".into())
}

#[cfg(windows)]
pub(crate) fn is_access_denied(err: &str) -> bool {
    err.contains("Access is denied")
        || err.contains("access denied")
        || err.contains("os error 5")
        || err.contains("ERROR_ACCESS_DENIED")
        || err.contains("IO error in winapi call")
}

#[cfg(windows)]
fn wait_running(timeout_ms: u64) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if is_running() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    Err("service did not enter RUNNING after elevated helper finished".into())
}

#[cfg(windows)]
pub fn start_or_elevate() -> Result<(), String> {
    match start() {
        Ok(()) => Ok(()),
        Err(err) => {
            log::warn!("service start failed; trying elevated service helper repair: {err}");
            let config_dir = crate::state::Dirs::resolve()
                .map_err(|e| format!("resolve config directory failed: {e}"))?
                .config;
            crate::service_installer::start_with_installer_sync(&config_dir)?;
            wait_running(15_000)
        }
    }
}

#[cfg(not(windows))]
pub fn start_or_elevate() -> Result<(), String> {
    start()
}

#[cfg(windows)]
fn bundled_service_binary_from_current_exe() -> Result<PathBuf, String> {
    let exe =
        std::env::current_exe().map_err(|e| format!("locate current executable failed: {e}"))?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "current executable has no parent directory".to_string())?;
    crate::service_paths::find_bundled_service_binary(exe_dir)
}

/// Create or repair the service. This requires admin rights and is normally
/// called by the elevated helper.
#[cfg(windows)]
pub fn install(config_dir: &Path) -> Result<(), String> {
    log::info!("installing service {}", SERVICE_NAME);

    let bundled_exe = bundled_service_binary_from_current_exe()?;
    let launch_args = crate::service_host::expected_launch_args(config_dir);

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
            log::warn!("existing service points to a stale binary; recreating it");
            let _ = service.stop();
            let _ = wait_until_stopped(&service);
            service
                .delete()
                .map_err(|e| format!("delete stale service failed: {e}"))?;
            drop(service);
            wait_until_removed(&manager)?;
        } else {
            if !matches!(
                service.query_status().map(|s| s.current_state),
                Ok(ServiceState::Stopped)
            ) {
                let _ = service.stop();
                let _ = wait_until_stopped(&service);
            }
            crate::service_paths::prepare_managed_service_binary(&bundled_exe)?;
            start_existing_service(&service)?;
            return Ok(());
        }
    }

    let service_exe = crate::service_paths::prepare_managed_service_binary(&bundled_exe)?;

    let service_info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from("ClashNova Core Service"),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: service_exe,
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
    wait_until_running(&service)?;
    Ok(())
}

#[cfg(not(windows))]
pub fn install(_config_dir: &Path) -> Result<(), String> {
    Err("service mode is only supported on Windows".into())
}

#[cfg(windows)]
pub fn uninstall() -> Result<(), String> {
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
                crate::service_paths::remove_managed_service_binary()?;
                return Ok(());
            }
            return Err(format!("open service failed: {message}"));
        }
    };

    if let Ok(status) = service.query_status() {
        if status.current_state != ServiceState::Stopped {
            let _ = service.stop();
            let _ = wait_until_stopped(&service);
        }
    }

    service
        .delete()
        .map_err(|e| format!("delete service failed: {e}"))?;
    drop(service);
    wait_until_removed(&manager)?;
    crate::service_paths::remove_managed_service_binary()?;
    Ok(())
}

#[cfg(not(windows))]
pub fn uninstall() -> Result<(), String> {
    Err("service mode is only supported on Windows".into())
}

#[cfg(windows)]
pub fn run_dispatcher() {
    crate::service_host::run_dispatcher();
}

#[cfg(not(windows))]
pub fn run_dispatcher() {}
