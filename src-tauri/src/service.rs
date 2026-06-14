//! 服务模式:把 mihomo 内核托管为 Windows 服务(LocalSystem),TUN 免管理员。
//!
//! - `install` / `uninstall` 直接使用 windows-service crate 的 Service Manager API;
//! - 服务进程即本程序自身带 `--service --dir <配置目录>` 参数,经 SCM 调度后
//!   循环拉起同目录的 mihomo.exe(崩溃 3 秒后重启);
//! - GUI 检测到服务在运行时跳过 sidecar 启动,仅经外部控制器对接内核。

use std::ffi::{OsStr, OsString};
use std::path::Path;

pub const SERVICE_NAME: &str = "clashnova-core";

#[cfg(windows)]
use windows_service::{
    service::{ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType, ServiceState, ServiceType},
    service_manager::{ServiceManager, ServiceManagerAccess},
};

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

/// 创建并启动服务(需要管理员权限)。
#[cfg(windows)]
pub fn install(config_dir: &Path) -> Result<(), String> {
    log::info!("开始安装服务: {}", SERVICE_NAME);

    let exe = std::env::current_exe().map_err(|e| format!("定位自身失败: {e}"))?;
    log::info!("服务可执行文件: {}", exe.display());

    let launch_args = vec![
        OsString::from("--service"),
        OsString::from("--dir"),
        OsString::from(config_dir),
    ];

    let manager_access = ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE;
    let manager = ServiceManager::local_computer(None::<&str>, manager_access)
        .map_err(|e| format!("连接服务管理器失败(需要管理员权限): {e}"))?;

    // 如果服务已存在,先尝试启动
    let service_access = ServiceAccess::QUERY_STATUS | ServiceAccess::START;
    if let Ok(service) = manager.open_service(SERVICE_NAME, service_access) {
        if let Ok(status) = service.query_status() {
            match status.current_state {
                ServiceState::Running => {
                    log::info!("服务已在运行");
                    return Ok(());
                }
                ServiceState::Stopped | ServiceState::StopPending | ServiceState::Paused | ServiceState::PausePending => {
                    log::info!("服务已存在但未运行,尝试启动");
                    service.start(&Vec::<&OsStr>::new())
                        .map_err(|e| format!("启动已有服务失败: {e}"))?;
                    log::info!("服务启动成功");
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

    let create_access = ServiceAccess::CHANGE_CONFIG | ServiceAccess::START;
    let service = manager.create_service(&service_info, create_access)
        .map_err(|e| format!("创建服务失败: {e}"))?;

    service.set_description("ClashNova 内核服务 - 用于 TUN 模式免管理员运行")
        .map_err(|e| format!("设置服务描述失败: {e}"))?;

    service.start(&Vec::<&OsStr>::new())
        .map_err(|e| format!("启动服务失败: {e}"))?;

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
    if let Err(e) = service_impl::dispatch() {
        eprintln!("服务调度失败: {e:?}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
pub fn run_dispatcher() {}

#[cfg(windows)]
mod service_impl {
    use std::ffi::OsString;
    use std::sync::mpsc;
    use std::time::Duration;

    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::{define_windows_service, service_dispatcher};

    define_windows_service!(ffi_service_main, service_main);

    pub fn dispatch() -> windows_service::Result<()> {
        service_dispatcher::start(super::SERVICE_NAME, ffi_service_main)
    }

    /// 从进程参数提取 `--dir <配置目录>`。
    fn config_dir_from_args() -> Option<std::path::PathBuf> {
        let args: Vec<String> = std::env::args().collect();
        args.iter()
            .position(|a| a == "--dir")
            .and_then(|i| args.get(i + 1))
            .map(std::path::PathBuf::from)
    }

    fn service_main(_args: Vec<OsString>) {
        let _ = run();
    }

    fn run() -> windows_service::Result<()> {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let handler = move |control: ServiceControl| match control {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                let _ = stop_tx.send(());
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        };
        let status_handle = service_control_handler::register(super::SERVICE_NAME, handler)?;
        let set_state = |state: ServiceState, accept: ServiceControlAccept| {
            status_handle.set_service_status(ServiceStatus {
                service_type: ServiceType::OWN_PROCESS,
                current_state: state,
                controls_accepted: accept,
                exit_code: ServiceExitCode::Win32(0),
                checkpoint: 0,
                wait_hint: Duration::from_secs(5),
                process_id: None,
            })
        };
        set_state(ServiceState::Running, ServiceControlAccept::STOP)?;

        // mihomo.exe 与本程序同目录(Tauri sidecar 安装布局)
        let core = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("mihomo.exe")));
        let dir = config_dir_from_args();

        if let (Some(core), Some(dir)) = (core, dir) {
            // 拉起-看护循环:正常停止信号到来前,内核退出 3 秒后重启
            loop {
                let mut child = match std::process::Command::new(&core)
                    .args(["-d"])
                    .arg(&dir)
                    .args(["-f"])
                    .arg(dir.join("runtime.yaml"))
                    .spawn()
                {
                    Ok(c) => c,
                    Err(_) => break,
                };
                // 每 500ms 轮询: 停止信号 → 杀内核退出; 内核退出 → 重启
                let mut stopped = false;
                loop {
                    if stop_rx.recv_timeout(Duration::from_millis(500)).is_ok() {
                        let _ = child.kill();
                        stopped = true;
                        break;
                    }
                    if let Ok(Some(_)) = child.try_wait() {
                        break;
                    }
                }
                if stopped {
                    break;
                }
                if stop_rx.recv_timeout(Duration::from_secs(3)).is_ok() {
                    break;
                }
            }
        }

        set_state(ServiceState::Stopped, ServiceControlAccept::empty())?;
        Ok(())
    }
}
