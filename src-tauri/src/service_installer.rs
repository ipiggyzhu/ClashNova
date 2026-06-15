use std::path::PathBuf;
use std::process::Command;

/// 调用独立的服务安装程序
pub async fn install_with_installer(config_dir: &std::path::Path) -> Result<(), String> {
    log::info!("使用独立安装程序安装服务");

    // 获取安装程序路径
    let installer_path = get_installer_path()?;

    if !installer_path.exists() {
        return Err(format!(
            "服务安装程序不存在: {}",
            installer_path.display()
        ));
    }

    // 检查是否需要提权
    #[cfg(windows)]
    {
        use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

        let manager_access = ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE;
        if ServiceManager::local_computer(None::<&str>, manager_access).is_err() {
            // 需要提权，使用 PowerShell RunAs
            return elevate_and_install(&installer_path, config_dir).await;
        }
    }

    // 已有管理员权限，直接执行
    let output = tokio::task::spawn_blocking(move || {
        Command::new(&installer_path)
            .args(["--dir", &config_dir.to_string_lossy()])
            .output()
    })
    .await
    .map_err(|e| format!("安装任务失败: {}", e))?
    .map_err(|e| format!("执行安装程序失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("安装失败: {}", stderr));
    }

    log::info!("服务安装成功");
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
        use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

        let manager_access = ServiceManagerAccess::CONNECT;
        if ServiceManager::local_computer(None::<&str>, manager_access).is_err() {
            // 需要提权，使用 PowerShell RunAs
            return elevate_and_uninstall(&uninstaller_path).await;
        }
    }

    // 已有管理员权限，直接执行
    let output = tokio::task::spawn_blocking(move || {
        Command::new(&uninstaller_path).output()
    })
    .await
    .map_err(|e| format!("卸载任务失败: {}", e))?
    .map_err(|e| format!("执行卸载程序失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("卸载失败: {}", stderr));
    }

    log::info!("服务卸载成功");
    Ok(())
}

/// 获取服务安装程序路径
fn get_installer_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("获取当前可执行文件路径失败: {}", e))?;

    let installer = exe
        .parent()
        .ok_or("无法获取可执行文件所在目录")?
        .join("clashnova-service-install.exe");

    Ok(installer)
}

/// 获取服务卸载程序路径
fn get_uninstaller_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("获取当前可执行文件路径失败: {}", e))?;

    let uninstaller = exe
        .parent()
        .ok_or("无法获取可执行文件所在目录")?
        .join("clashnova-service-uninstall.exe");

    Ok(uninstaller)
}

/// 提权并安装服务
#[cfg(windows)]
async fn elevate_and_install(
    installer_path: &std::path::Path,
    config_dir: &std::path::Path,
) -> Result<(), String> {
    log::info!("需要提权，通过 PowerShell RunAs 执行");

    let installer_str = installer_path.to_string_lossy().to_string();
    let config_dir_str = config_dir.to_string_lossy().to_string();

    let ps_cmd = format!(
        "Start-Process '{}' -ArgumentList '--dir','{}' -Verb RunAs -Wait",
        installer_str, config_dir_str
    );

    let output = tokio::task::spawn_blocking(move || {
        Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", &ps_cmd])
            .output()
    })
    .await
    .map_err(|e| format!("提权任务失败: {}", e))?
    .map_err(|e| format!("执行 PowerShell 失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("提权安装失败: {}", stderr));
    }

    log::info!("提权安装成功");
    Ok(())
}

/// 提权并卸载服务
#[cfg(windows)]
async fn elevate_and_uninstall(uninstaller_path: &std::path::Path) -> Result<(), String> {
    log::info!("需要提权，通过 PowerShell RunAs 执行");

    let uninstaller_str = uninstaller_path.to_string_lossy().to_string();

    let ps_cmd = format!("Start-Process '{}' -Verb RunAs -Wait", uninstaller_str);

    let output = tokio::task::spawn_blocking(move || {
        Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", &ps_cmd])
            .output()
    })
    .await
    .map_err(|e| format!("提权任务失败: {}", e))?
    .map_err(|e| format!("执行 PowerShell 失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("提权卸载失败: {}", stderr));
    }

    log::info!("提权卸载成功");
    Ok(())
}
