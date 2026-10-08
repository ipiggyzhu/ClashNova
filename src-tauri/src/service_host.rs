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

    fn append_bootstrap_log(line: &str) {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or_default();
        if let Ok(mut file) = nova_service_ipc::policy::windows_security::open_service_log() {
            let _ = writeln!(file, "[bootstrap][{timestamp}] {line}");
        }
    }

    fn init_service_logger() {
        append_bootstrap_log("initializing service logger");
        let mut builder =
            env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));
        match nova_service_ipc::policy::windows_security::open_service_log() {
            Ok(file) => {
                builder.target(Target::Pipe(Box::new(file)));
            }
            Err(err) => eprintln!("服务文件日志不可用: {err}"),
        }
        let _ = builder.try_init();
    }

    fn service_main(_args: Vec<std::ffi::OsString>) {
        // ServiceMain 参数不包含 SCM ImagePath 中的启动参数。
        let args: Vec<_> = std::env::args_os().collect();
        append_bootstrap_log("service_main invoked");
        let _ = run(args);
    }

    fn run(args: Vec<std::ffi::OsString>) -> windows_service::Result<()> {
        let config_dir = config_dir_from_args(&args);
        init_service_logger();

        log::info!("ClashNova 服务模式启动");

        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let handler_stop_tx = stop_tx.clone();
        let handler = move |control: ServiceControl| match control {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                let _ = handler_stop_tx.send(());
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
            let policy = config_dir
                .as_deref()
                .ok_or_else(|| "服务没有绑定配置目录，请重新安装服务".to_string())
                .and_then(|dir| {
                    nova_service_ipc::ServicePolicy::from_installation(dir)
                        .map_err(|e| e.to_string())
                });
            let policy = match policy {
                Ok(policy) => policy,
                Err(err) => {
                    log::error!("服务安全检查失败: {err}");
                    let _ = ipc_ready_tx.send(Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        err,
                    )
                    .into()));
                    return;
                }
            };
            let server = nova_service_ipc::IpcServer::new(policy);
            if let Err(e) = server.run_with_ready_signal(Some(ipc_ready_tx)) {
                log::error!("IPC 服务器启动失败: {}", e);
            }
            log::info!("IPC 服务器已退出");
            let _ = stop_tx.send(());
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
        set_state(ServiceState::StopPending, ServiceControlAccept::empty())?;

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
