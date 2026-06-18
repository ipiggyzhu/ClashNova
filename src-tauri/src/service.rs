//! 服务模式:把 mihomo 内核托管为 Windows 服务(LocalSystem),TUN 免管理员。
//!
//! - `install` / `uninstall` 直接使用 windows-service crate 的 Service Manager API;
//! - 服务进程由独立的 `clashnova-service.exe` 承载，避免 GUI 主程序更新时被 SCM 锁定;
//! - GUI 检测到服务在运行时跳过 sidecar 启动,仅经外部控制器对接内核。

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

pub use crate::service_host::SERVICE_NAME;

#[cfg(windows)]
use windows_service::{
    service::{ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType, ServiceState, ServiceType},
    service_manager::{ServiceManager, ServiceManagerAccess},
};

#[cfg(windows)]
fn expected_service_binary_path() -> Result<PathBuf, String> {
    crate::service_host::sibling_service_binary_path()
}

#[cfg(windows)]
pub fn diagnose_installation() -> Result<(), String> {
    let current_exe = std::env::current_exe()
        .map_err(|e| format!("定位当前程序失败: {e}"))?;
    let install_dir = current_exe
        .parent()
        .ok_or("无法获取当前程序所在目录")?;
    let pending_exe = install_dir.join("clashnova.new.exe");
    if pending_exe.exists() {
        log::warn!(
            "检测到未完成的程序替换: {}，当前仍在运行 {}",
            pending_exe.display(),
            current_exe.display()
        );
    }

    let service_exe = expected_service_binary_path()?;
    if !service_exe.exists() {
        return Err(format!(
            "服务宿主缺失: {}。请重新安装最新版本安装包，确保安装目录包含 clashnova-service.exe",
            service_exe.display()
        ));
    }

    Ok(())
}

#[cfg(not(windows))]
pub fn diagnose_installation() -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn service_matches_expected(service: &windows_service::service::Service) -> bool {
    match service.query_config() {
        Ok(config) => {
            let expected_exe = match expected_service_binary_path() {
                Ok(exe) => exe,
                Err(_) => return false,
            }
            .to_string_lossy()
            .to_ascii_lowercase();
            let launch_command = config.executable_path.to_string_lossy().to_ascii_lowercase();
            launch_command.contains(&expected_exe)
                && launch_command.contains("--dir")
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
    Err("旧服务删除超时".into())
}

#[cfg(windows)]
fn wait_until_running(service: &windows_service::service::Service) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut last_state = None;

    while std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(250));
        match service.query_status() {
            Ok(status) if status.current_state == ServiceState::Running => {
                return Ok(());
            }
            Ok(status) => {
                last_state = Some(format!("{:?}", status.current_state));
            }
            Err(err) => {
                last_state = Some(format!("查询服务状态失败: {err}"));
            }
        }
    }

    Err(format!(
        "服务启动超时，最后状态: {}",
        last_state.unwrap_or_else(|| "未知".into())
    ))
}

/// 服务是否已创建。
pub fn status() -> &'static str {
    #[cfg(not(windows))]
    return "not-installed";

    #[cfg(windows)]
    {
        let Ok(manager) = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT) else {
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

/// 服务是否处于 RUNNING 状态。
pub fn is_running() -> bool {
    #[cfg(not(windows))]
    return false;

    #[cfg(windows)]
    {
        let Ok(manager) = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT) else {
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

/// 停止已安装服务并等待进入 STOPPED。
#[cfg(windows)]
pub fn stop() -> Result<(), String> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| format!("连接服务管理器失败: {e}"))?;
    let service_access = ServiceAccess::QUERY_STATUS | ServiceAccess::STOP;
    let service = manager.open_service(SERVICE_NAME, service_access)
        .map_err(|e| format!("打开服务失败: {e}"))?;

    if matches!(
        service.query_status().map(|s| s.current_state),
        Ok(ServiceState::Stopped)
    ) {
        return Ok(());
    }

    service
        .stop()
        .map_err(|e| format!("停止服务失败: {e}"))?;

    for _ in 0..20 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if matches!(
            service.query_status().map(|s| s.current_state),
            Ok(ServiceState::Stopped)
        ) {
            return Ok(());
        }
    }
    Err("服务停止超时".into())
}

#[cfg(not(windows))]
pub fn stop() -> Result<(), String> {
    Ok(())
}

/// 启动已安装服务并等待进入 RUNNING。
#[cfg(windows)]
pub fn start() -> Result<(), String> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| format!("连接服务管理器失败: {e}"))?;
    let service_access = ServiceAccess::QUERY_STATUS | ServiceAccess::START;
    let service = manager.open_service(SERVICE_NAME, service_access)
        .map_err(|e| format!("打开服务失败: {e}"))?;

    if matches!(
        service.query_status().map(|s| s.current_state),
        Ok(ServiceState::Running)
    ) {
        return Ok(());
    }

    service
        .start(&Vec::<&OsStr>::new())
        .map_err(|e| format!("启动服务失败: {e}"))?;

    for _ in 0..20 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if matches!(
            service.query_status().map(|s| s.current_state),
            Ok(ServiceState::Running)
        ) {
            return Ok(());
        }
    }
    Err("服务启动后未进入运行状态".into())
}

#[cfg(windows)]
fn is_access_denied(err: &str) -> bool {
    err.contains("Access is denied")
        || err.contains("拒绝访问")
        || err.contains("os error 5")
        || err.contains("ERROR_ACCESS_DENIED")
        || err.contains("IO error in winapi call") // Windows Service API 权限错误
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
    Err("服务启动后未进入运行状态".into())
}

#[cfg(windows)]
fn start_elevated() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("定位自身失败: {e}"))?;
    let exe_str = exe.to_string_lossy().to_string();
    let status = runas::Command::new(&exe_str)
        .arg("--start-service")
        .show(false)
        .status()
        .map_err(|e| format!("提权启动服务失败: {e}"))?;

    if !status.success() {
        if is_running() {
            return Ok(());
        }
        return Err(format!(
            "提权启动服务失败或用户取消了 UAC 授权，退出码: {:?}",
            status.code()
        ));
    }

    wait_running(15_000)
}

#[cfg(windows)]
pub fn start_or_elevate() -> Result<(), String> {
    match start() {
        Ok(()) => Ok(()),
        Err(err) if is_access_denied(&err) => {
            log::warn!("启动服务被系统拒绝, 尝试通过 UAC 提权启动: {err}");
            start_elevated()
        }
        Err(err) => Err(err),
    }
}

#[cfg(not(windows))]
pub fn start_or_elevate() -> Result<(), String> {
    start()
}

#[cfg(not(windows))]
pub fn start() -> Result<(), String> {
    Err("服务模式仅支持 Windows".into())
}

/// 创建并启动服务(需要管理员权限)。
#[cfg(windows)]
pub fn install(config_dir: &Path) -> Result<(), String> {
    log::info!("开始安装服务: {}", SERVICE_NAME);

    let exe = expected_service_binary_path()?;
    log::info!("服务可执行文件: {}", exe.display());

    if !exe.exists() {
        return Err(format!("服务宿主不存在: {}", exe.display()));
    }

    let launch_args = crate::service_host::expected_launch_args(config_dir);

    let manager_access = ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE;
    let manager = ServiceManager::local_computer(None::<&str>, manager_access)
        .map_err(|e| format!("连接服务管理器失败(需要管理员权限): {e}"))?;

    // 如果服务已存在,先尝试启动
    let service_access = ServiceAccess::QUERY_STATUS | ServiceAccess::QUERY_CONFIG | ServiceAccess::START | ServiceAccess::STOP | ServiceAccess::DELETE | ServiceAccess::CHANGE_CONFIG;
    if let Ok(service) = manager.open_service(SERVICE_NAME, service_access) {
        if !service_matches_expected(&service) {
            log::warn!("服务已存在但注册信息与当前构建不匹配，执行重装");
            let _ = service.stop();
            service.delete().map_err(|e| format!("删除旧服务失败: {e}"))?;
            drop(service);
            wait_until_removed(&manager)?;
        } else if let Ok(status) = service.query_status() {
            match status.current_state {
                ServiceState::Running => {
                    log::info!("服务已在运行");
                    return Ok(());
                }
                ServiceState::Stopped | ServiceState::StopPending | ServiceState::Paused | ServiceState::PausePending => {
                    log::info!("服务已存在但未运行,尝试启动");
                    service.start(&Vec::<&OsStr>::new())
                        .map_err(|e| format!("启动已有服务失败: {e}"))?;
                    wait_until_running(&service)?;
                    return Ok(());
                }
                _ => {}
            }
        }
    }

    // 创建新服务
    let service_info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from("ClashNova Core Service"),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: exe,
        launch_arguments: launch_args,
        dependencies: vec![],
        account_name: None, // LocalSystem
        account_password: None,
    };

    let create_access = ServiceAccess::CHANGE_CONFIG | ServiceAccess::START | ServiceAccess::QUERY_STATUS;
    let service = manager.create_service(&service_info, create_access)
        .map_err(|e| format!("创建服务失败: {e}"))?;

    service.set_description("ClashNova 内核服务 - 用于 TUN 模式免管理员运行")
        .map_err(|e| format!("设置服务描述失败: {e}"))?;

    service.start(&Vec::<&OsStr>::new())
        .map_err(|e| format!("启动服务失败: {e}"))?;
    wait_until_running(&service)?;
    log::info!("服务安装并启动成功");
    Ok(())
}

#[cfg(not(windows))]
pub fn install(_config_dir: &Path) -> Result<(), String> {
    Err("服务模式仅支持 Windows".into())
}

/// 停止并删除服务(需要管理员权限)。
#[cfg(windows)]
pub fn uninstall() -> Result<(), String> {
    log::info!("开始卸载服务: {}", SERVICE_NAME);

    let manager_access = ServiceManagerAccess::CONNECT;
    let manager = ServiceManager::local_computer(None::<&str>, manager_access)
        .map_err(|e| format!("连接服务管理器失败(需要管理员权限): {e}"))?;

    let service_access = ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE;
    let service = manager.open_service(SERVICE_NAME, service_access)
        .map_err(|e| format!("打开服务失败: {e}"))?;

    // 先停止服务
    if let Ok(status) = service.query_status() {
        if status.current_state != ServiceState::Stopped {
            log::info!("停止服务中...");
            let _ = service.stop();
            // 等待停止
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }

    service.delete()
        .map_err(|e| format!("删除服务失败: {e}"))?;

    drop(service);
    wait_until_removed(&manager)?;

    log::info!("服务卸载成功");
    Ok(())
}

#[cfg(not(windows))]
pub fn uninstall() -> Result<(), String> {
    Err("服务模式仅支持 Windows".into())
}

/* ---------------- 服务进程入口(--service) ---------------- */

/// `--service` 启动路径:交给 SCM 调度,阻塞至服务停止。
#[cfg(windows)]
pub fn run_dispatcher() {
    crate::service_host::run_dispatcher();
}

#[cfg(not(windows))]
pub fn run_dispatcher() {}
