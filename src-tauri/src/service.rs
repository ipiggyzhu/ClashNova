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
                    for _ in 0..20 {
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        if matches!(
                            service.query_status().map(|s| s.current_state),
                            Ok(ServiceState::Running)
                        ) {
                            log::info!("服务启动成功");
                            return Ok(());
                        }
                    }
                    return Err("服务启动后未进入运行状态".into());
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
    for _ in 0..20 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if matches!(
            service.query_status().map(|s| s.current_state),
            Ok(ServiceState::Running)
        ) {
            log::info!("服务安装并启动成功");
            return Ok(());
        }
    }

    Err("服务启动后未进入运行状态".into())
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
    use env_logger::Target;
    use std::ffi::OsString;
    use std::io::Write;
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

    fn init_service_logger(config_dir: Option<&std::path::Path>) {
        let mut builder = env_logger::Builder::from_env(
            env_logger::Env::default().default_filter_or("info")
        );

        if let Some(config_dir) = config_dir {
            let log_dir = config_dir.join("logs");
            let _ = std::fs::create_dir_all(&log_dir);
            let log_path = log_dir.join("clashnova-service.log");
            if let Ok(file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_path)
            {
                builder.target(Target::Pipe(Box::new(file)));
            }
        }

        let _ = builder.try_init();
    }

    fn service_main(_args: Vec<OsString>) {
        let _ = run();
    }

    fn run() -> windows_service::Result<()> {
        let config_dir = config_dir_from_args();
        init_service_logger(config_dir.as_deref());

        log::info!("ClashNova 服务模式启动");

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

        log::info!("服务已进入 Running 状态，启动 IPC 服务器");

        // 启动 IPC 服务器（在新线程中）
        let ipc_handle = std::thread::spawn(|| {
            if let Err(e) = nova_service_ipc::start_server() {
                log::error!("IPC 服务器启动失败: {}", e);
            }
            log::info!("IPC 服务器已退出");
        });

        log::info!("等待停止信号...");

        // 等待停止信号
        let _ = stop_rx.recv();

        log::info!("收到停止信号，关闭服务");

        match nova_service_ipc::stop_core() {
            Ok(resp) if resp.code == 0 => log::info!("已停止服务托管内核"),
            Ok(resp) => log::warn!("停止服务托管内核失败: {}", resp.message),
            Err(err) => log::warn!("停止服务托管内核 IPC 调用失败: {err}"),
        }

        // 给 IPC 线程一点时间完成收尾
        std::thread::sleep(Duration::from_millis(500));

        set_state(ServiceState::Stopped, ServiceControlAccept::empty())?;
        log::info!("服务已停止");
        Ok(())
    }
}
