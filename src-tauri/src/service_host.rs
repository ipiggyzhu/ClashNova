//! Windows 服务宿主：独立承载命名管道 IPC 与 mihomo 子进程。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub const SERVICE_NAME: &str = "clashnova-core";

#[allow(dead_code)]
pub fn expected_launch_args(config_dir: &Path) -> Vec<OsString> {
    vec![OsString::from("--dir"), OsString::from(config_dir)]
}

#[cfg(windows)]
pub fn sibling_service_binary_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("定位当前可执行文件失败: {e}"))?;
    let parent = exe.parent().ok_or("无法获取当前可执行文件所在目录")?;
    Ok(parent.join("clashnova-service.exe"))
}

#[cfg(not(windows))]
pub fn sibling_service_binary_path() -> Result<PathBuf, String> {
    Err("服务模式仅支持 Windows".into())
}

/// `clashnova-service.exe --dir <配置目录>`：由 SCM 调度，阻塞至服务停止。
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
    use std::ffi::OsStr;
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

    fn config_dir_from_args(args: &[std::ffi::OsString]) -> Option<std::path::PathBuf> {
        args.iter()
            .position(|a| a == OsStr::new("--dir"))
            .and_then(|i| args.get(i + 1))
            .map(std::path::PathBuf::from)
    }

    fn fallback_service_log_dir() -> std::path::PathBuf {
        std::env::var_os("ProgramData")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from(r"C:\ProgramData"))
            .join("ClashNova")
            .join("logs")
    }

    fn service_log_dirs(config_dir: Option<&std::path::Path>) -> Vec<std::path::PathBuf> {
        let primary_log_dir = config_dir
            .map(|dir| dir.join("logs"))
            .unwrap_or_else(fallback_service_log_dir);
        if config_dir.is_some() {
            vec![primary_log_dir, fallback_service_log_dir()]
        } else {
            vec![primary_log_dir]
        }
    }

    fn append_bootstrap_log(config_dir: Option<&std::path::Path>, line: &str) {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or_default();
        for log_dir in service_log_dirs(config_dir) {
            if std::fs::create_dir_all(&log_dir).is_err() {
                continue;
            }
            let log_path = log_dir.join("clashnova-service.log");
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_path)
            {
                let _ = writeln!(file, "[bootstrap][{timestamp}] {line}");
                break;
            }
        }
    }

    fn init_service_logger(config_dir: Option<&std::path::Path>) {
        append_bootstrap_log(config_dir, "initializing service logger");
        let mut builder =
            env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));

        for log_dir in service_log_dirs(config_dir) {
            if std::fs::create_dir_all(&log_dir).is_err() {
                continue;
            }
            let log_path = log_dir.join("clashnova-service.log");
            if let Ok(file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_path)
            {
                builder.target(Target::Pipe(Box::new(file)));
                break;
            }
        }

        let _ = builder.try_init();
    }

    fn service_main(args: Vec<std::ffi::OsString>) {
        let config_dir = config_dir_from_args(&args);
        append_bootstrap_log(config_dir.as_deref(), "service_main invoked");
        let _ = run(args);
    }

    fn run(args: Vec<std::ffi::OsString>) -> windows_service::Result<()> {
        let config_dir = config_dir_from_args(&args);
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
        set_state(ServiceState::StartPending, ServiceControlAccept::empty())?;

        log::info!("启动 IPC 服务器");

        let (ipc_ready_tx, ipc_ready_rx) = mpsc::channel();
        let _ipc_handle = std::thread::spawn(move || {
            let server = nova_service_ipc::IpcServer::new();
            if let Err(e) = server.run_with_ready_signal(Some(ipc_ready_tx)) {
                log::error!("IPC 服务器启动失败: {}", e);
            }
            log::info!("IPC 服务器已退出");
        });

        match ipc_ready_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => {
                set_state(ServiceState::Running, ServiceControlAccept::STOP)?;
                log::info!("服务已进入 Running 状态，IPC 已就绪");
            }
            Ok(Err(err)) => {
                log::error!("IPC 初始化失败: {}", err);
                set_state(ServiceState::Stopped, ServiceControlAccept::empty())?;
                return Ok(());
            }
            Err(err) => {
                log::error!("等待 IPC 初始化超时: {}", err);
                set_state(ServiceState::Stopped, ServiceControlAccept::empty())?;
                return Ok(());
            }
        }

        log::info!("等待停止信号...");

        let _ = stop_rx.recv();

        log::info!("收到停止信号，关闭服务");

        match nova_service_ipc::stop_core() {
            Ok(resp) if resp.code == 0 => log::info!("已停止服务托管内核"),
            Ok(resp) => log::warn!("停止服务托管内核失败: {}", resp.message),
            Err(err) => log::warn!("停止服务托管内核 IPC 调用失败: {err}"),
        }

        std::thread::sleep(Duration::from_millis(500));

        set_state(ServiceState::Stopped, ServiceControlAccept::empty())?;
        log::info!("服务已停止");
        Ok(())
    }
}
