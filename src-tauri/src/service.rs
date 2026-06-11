//! 服务模式:把 mihomo 内核托管为 Windows 服务(LocalSystem),TUN 免管理员。
//!
//! - `install` / `uninstall` 经 PowerShell `Start-Process -Verb RunAs` 提权调 sc.exe;
//! - 服务进程即本程序自身带 `--service --dir <配置目录>` 参数,经 SCM 调度后
//!   循环拉起同目录的 mihomo.exe(崩溃 3 秒后重启);
//! - GUI 检测到服务在运行时跳过 sidecar 启动,仅经外部控制器对接内核。

use std::process::Command;

pub const SERVICE_NAME: &str = "clashnova-core";

/// 隐藏控制台窗口地运行命令并取 (exit_code, stdout+stderr)。
fn run_quiet(program: &str, args: &[&str]) -> Result<(i32, String), String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("执行 {program} 失败: {e}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Ok((out.status.code().unwrap_or(-1), text))
}

/// 服务是否已创建(sc query 退出码 1060 = 不存在)。
pub fn status() -> &'static str {
    match run_quiet("sc.exe", &["query", SERVICE_NAME]) {
        Ok((1060, _)) | Err(_) => "not-installed",
        Ok(_) => "installed",
    }
}

/// 服务是否处于 RUNNING 状态。
pub fn is_running() -> bool {
    matches!(run_quiet("sc.exe", &["query", SERVICE_NAME]),
        Ok((0, text)) if text.contains("RUNNING"))
}

/// 经 PowerShell 提权执行一串 sc.exe 子命令(任一失败不中断后续)。
fn elevated_sc(batch: &[String]) -> Result<(), String> {
    let script = batch
        .iter()
        .map(|args| format!("sc.exe {args} | Out-Null"))
        .collect::<Vec<_>>()
        .join("; ");
    let (code, text) = run_quiet(
        "powershell.exe",
        &[
            "-NoProfile",
            "-Command",
            &format!(
                "Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden \
                 -ArgumentList '-NoProfile','-Command','{}'",
                script.replace('\'', "''")
            ),
        ],
    )?;
    if code != 0 {
        return Err(format!("提权执行失败({code}): {text}"));
    }
    Ok(())
}

/// 创建并启动服务(需要用户在 UAC 弹窗确认)。
pub fn install(config_dir: &std::path::Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("定位自身失败: {e}"))?;
    let bin_path = format!(
        "\\\"{}\\\" --service --dir \\\"{}\\\"",
        exe.display(),
        config_dir.display()
    );
    elevated_sc(&[
        format!("create {SERVICE_NAME} binPath= \"{bin_path}\" start= auto DisplayName= \"ClashNova Core Service\""),
        format!("start {SERVICE_NAME}"),
    ])?;
    if status() != "installed" {
        return Err("服务创建未生效(可能取消了 UAC 授权)".into());
    }
    Ok(())
}

/// 停止并删除服务。
pub fn uninstall() -> Result<(), String> {
    elevated_sc(&[
        format!("stop {SERVICE_NAME}"),
        format!("delete {SERVICE_NAME}"),
    ])?;
    if status() == "installed" {
        return Err("服务删除未生效(可能取消了 UAC 授权)".into());
    }
    Ok(())
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
