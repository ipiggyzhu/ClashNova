use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

/// 调用独立的服务安装程序
pub async fn install_with_installer(config_dir: &std::path::Path) -> Result<(), String> {
    let config_dir = config_dir.to_path_buf();
    tokio::task::spawn_blocking(move || install_with_installer_sync(&config_dir))
        .await
        .map_err(|e| format!("安装任务失败: {}", e))?
}

/// 同步调用独立服务安装程序。服务已存在时，安装程序会启动/重启已有服务。
pub fn install_with_installer_sync(config_dir: &std::path::Path) -> Result<(), String> {
    run_install_helper(config_dir, "安装服务", "install")
}

/// 同步通过安装程序启动服务，用于普通权限下的 SCM START 权限兜底。
pub fn start_with_installer_sync(config_dir: &std::path::Path) -> Result<(), String> {
    run_install_helper(config_dir, "启动服务", "start")
}

fn run_install_helper(
    config_dir: &std::path::Path,
    action_label: &'static str,
    result_action: &'static str,
) -> Result<(), String> {
    log::info!("使用独立安装程序{action_label}");

    let installer_path = get_installer_path()?;
    if !installer_path.exists() {
        return Err(format!("服务安装程序不存在: {}", installer_path.display()));
    }

    #[cfg(windows)]
    {
        if !is_elevated() {
            log::info!("需要提权，使用 runas 库执行 UAC");
            return elevate_and_install_blocking(
                &installer_path,
                config_dir,
                action_label,
                result_action,
            );
        }
    }

    let result_path = service_result_path(result_action);
    let output = Command::new(&installer_path)
        .arg("--dir")
        .arg(config_dir)
        .arg("--result")
        .arg(&result_path)
        .output()
        .map_err(|e| format!("执行安装程序失败: {}", e))?;

    if !output.status.success() {
        return Err(command_failure_message(
            action_label,
            &output,
            Some(&result_path),
        ));
    }

    log::info!("{action_label}成功");
    Ok(())
}

/// 调用独立的服务卸载程序
pub async fn uninstall_with_installer() -> Result<(), String> {
    log::info!("使用独立卸载程序卸载服务");

    // 获取卸载程序路径
    let uninstaller_path = get_uninstaller_path()?;

    if !uninstaller_path.exists() {
        return Err(format!(
            "服务卸载程序不存在: {}",
            uninstaller_path.display()
        ));
    }

    // 检查是否需要提权
    #[cfg(windows)]
    {
        if !is_elevated() {
            // 需要提权，使用 runas 库
            log::info!("需要提权，使用 runas 库执行 UAC");
            return elevate_and_uninstall(&uninstaller_path).await;
        }
    }

    // 已有管理员权限，直接执行
    let result_path = service_result_path("uninstall");
    let result_arg = result_path.clone();
    let output = tokio::task::spawn_blocking(move || {
        Command::new(&uninstaller_path)
            .arg("--result")
            .arg(&result_arg)
            .output()
    })
    .await
    .map_err(|e| format!("卸载任务失败: {}", e))?
    .map_err(|e| format!("执行卸载程序失败: {}", e))?;

    if !output.status.success() {
        return Err(command_failure_message(
            "卸载服务",
            &output,
            Some(&result_path),
        ));
    }

    log::info!("服务卸载成功");
    Ok(())
}

/// 获取服务安装程序路径
fn get_installer_path() -> Result<PathBuf, String> {
    find_helper("clashnova-service-install.exe")
}

/// 获取服务卸载程序路径
fn get_uninstaller_path() -> Result<PathBuf, String> {
    find_helper("clashnova-service-uninstall.exe")
}

fn find_helper(name: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("获取当前可执行文件路径失败: {}", e))?;
    let exe_dir = exe.parent().ok_or("无法获取可执行文件所在目录")?;
    let mut candidates = vec![
        exe_dir.join(name),
        exe_dir.join("helpers").join(name),
        exe_dir.join("resources").join(name),
        exe_dir.join("resources").join("helpers").join(name),
        exe_dir.join("resources").join("resources").join(name),
        exe_dir
            .join("resources")
            .join("resources")
            .join("helpers")
            .join(name),
    ];

    if let Some(parent) = exe_dir.parent() {
        candidates.push(parent.join(name));
        candidates.push(parent.join("helpers").join(name));
        candidates.push(parent.join("Resources").join(name));
        candidates.push(parent.join("Resources").join("helpers").join(name));
        candidates.push(parent.join("resources").join(name));
        candidates.push(parent.join("resources").join("helpers").join(name));
        candidates.push(parent.join("resources").join("resources").join(name));
        candidates.push(
            parent
                .join("resources")
                .join("resources")
                .join("helpers")
                .join(name),
        );
        if let Some(grandparent) = parent.parent() {
            candidates.push(grandparent.join(name));
            candidates.push(grandparent.join("helpers").join(name));
            candidates.push(grandparent.join("resources").join(name));
            candidates.push(grandparent.join("resources").join("helpers").join(name));
        }
    }

    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| format!("服务辅助程序不存在: {name}，已检查程序目录和 resources 目录"))
}

fn service_result_path(action: &str) -> PathBuf {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    std::env::temp_dir().join(format!(
        "clashnova-service-{action}-{}-{millis}.txt",
        std::process::id()
    ))
}

fn read_result_file(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let detail = text
        .strip_prefix("ok\n")
        .or_else(|| text.strip_prefix("error\n"))
        .unwrap_or(&text)
        .trim();
    if detail.is_empty() {
        None
    } else {
        Some(detail.to_string())
    }
}

fn command_failure_message(action: &str, output: &Output, result_path: Option<&Path>) -> String {
    let mut parts = Vec::new();
    if let Some(path) = result_path.and_then(read_result_file) {
        parts.push(path);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        parts.push(stderr);
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        parts.push(stdout);
    }

    let detail = if parts.is_empty() {
        "未返回详细错误".to_string()
    } else {
        parts.join("\n")
    };

    format!("{action}失败，退出码: {:?}\n{detail}", output.status.code())
}

/// 检查当前进程是否有管理员权限
#[cfg(windows)]
fn is_elevated() -> bool {
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = windows::Win32::Foundation::HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }

        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut size = 0u32;
        if GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        )
        .is_err()
        {
            return false;
        }

        elevation.TokenIsElevated != 0
    }
}

/// 提权并运行服务安装程序（使用 runas 库）
#[cfg(windows)]
fn elevate_and_install_blocking(
    installer_path: &std::path::Path,
    config_dir: &std::path::Path,
    action_label: &'static str,
    result_action: &'static str,
) -> Result<(), String> {
    log::info!("使用 runas 库执行 UAC 提权");

    let installer_str = installer_path.to_string_lossy().to_string();
    let config_dir_str = config_dir.to_string_lossy().to_string();
    let result_path = service_result_path(&format!("{result_action}-elevated"));
    let result_path_str = result_path.to_string_lossy().to_string();

    let status = runas::Command::new(&installer_str)
        .arg("--dir")
        .arg(&config_dir_str)
        .arg("--result")
        .arg(&result_path_str)
        .show(false)
        .status()
        .map_err(|e| format!("执行 runas 失败: {}", e))?;

    if !status.success() {
        let detail = read_result_file(&result_path).unwrap_or_else(|| "未返回详细错误".into());
        return Err(format!(
            "提权{action_label}失败，退出码: {:?}\n{}",
            status.code(),
            detail
        ));
    }

    log::info!("提权{action_label}成功");
    Ok(())
}

/// 提权并卸载服务（使用 runas 库）
#[cfg(windows)]
async fn elevate_and_uninstall(uninstaller_path: &std::path::Path) -> Result<(), String> {
    log::info!("使用 runas 库执行 UAC 提权");

    let uninstaller_str = uninstaller_path.to_string_lossy().to_string();
    let result_path = service_result_path("uninstall-elevated");
    let result_path_str = result_path.to_string_lossy().to_string();

    let status = tokio::task::spawn_blocking(move || {
        runas::Command::new(&uninstaller_str)
            .arg("--result")
            .arg(&result_path_str)
            .show(false)
            .status()
    })
    .await
    .map_err(|e| format!("提权任务失败: {}", e))?
    .map_err(|e| format!("执行 runas 失败: {}", e))?;

    if !status.success() {
        let detail = read_result_file(&result_path).unwrap_or_else(|| "未返回详细错误".into());
        return Err(format!(
            "提权卸载失败，退出码: {:?}\n{}",
            status.code(),
            detail
        ));
    }

    log::info!("提权卸载成功");
    Ok(())
}
