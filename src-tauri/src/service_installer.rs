use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

pub async fn install_with_installer(config_dir: &Path) -> Result<(), String> {
    let config_dir = config_dir.to_path_buf();
    tokio::task::spawn_blocking(move || install_with_installer_sync(&config_dir))
        .await
        .map_err(|e| format!("service install task failed: {e}"))?
}

pub fn install_with_installer_sync(config_dir: &Path) -> Result<(), String> {
    run_install_helper(config_dir, "install service", "install")
}

pub fn start_with_installer_sync(config_dir: &Path) -> Result<(), String> {
    run_install_helper(config_dir, "start service", "start")
}

fn run_install_helper(
    config_dir: &Path,
    action_label: &'static str,
    result_action: &'static str,
) -> Result<(), String> {
    log::info!("running elevated service helper to {action_label}");

    let installer_path = get_installer_path()?;
    if !installer_path.exists() {
        return Err(format!(
            "service install helper does not exist: {}",
            installer_path.display()
        ));
    }

    #[cfg(windows)]
    {
        if !is_elevated() {
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
        .arg("--action")
        .arg(result_action)
        .arg("--result")
        .arg(&result_path)
        .output()
        .map_err(|e| format!("run service install helper failed: {e}"))?;

    if !output.status.success() {
        return Err(command_failure_message(
            action_label,
            &output,
            Some(&result_path),
        ));
    }

    log::info!("{action_label} succeeded");
    Ok(())
}

pub async fn uninstall_with_installer() -> Result<(), String> {
    log::info!("running elevated service uninstall helper");

    let uninstaller_path = get_uninstaller_path()?;
    if !uninstaller_path.exists() {
        return Err(format!(
            "service uninstall helper does not exist: {}",
            uninstaller_path.display()
        ));
    }

    #[cfg(windows)]
    {
        if !is_elevated() {
            return elevate_and_uninstall(&uninstaller_path).await;
        }
    }

    let result_path = service_result_path("uninstall");
    let result_arg = result_path.clone();
    let output = tokio::task::spawn_blocking(move || {
        Command::new(&uninstaller_path)
            .arg("--result")
            .arg(&result_arg)
            .output()
    })
    .await
    .map_err(|e| format!("service uninstall task failed: {e}"))?
    .map_err(|e| format!("run service uninstall helper failed: {e}"))?;

    if !output.status.success() {
        return Err(command_failure_message(
            "uninstall service",
            &output,
            Some(&result_path),
        ));
    }

    log::info!("uninstall service succeeded");
    Ok(())
}

fn get_installer_path() -> Result<PathBuf, String> {
    find_helper("clashnova-service-install.exe")
}

fn get_uninstaller_path() -> Result<PathBuf, String> {
    find_helper("clashnova-service-uninstall.exe")
}

fn find_helper(name: &str) -> Result<PathBuf, String> {
    let exe =
        std::env::current_exe().map_err(|e| format!("locate current executable failed: {e}"))?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "current executable has no parent directory".to_string())?;
    let mut candidates = Vec::new();
    add_helper_candidates(&mut candidates, exe_dir, name);

    if let Some(parent) = exe_dir.parent() {
        add_helper_candidates(&mut candidates, parent, name);
        if let Some(grandparent) = parent.parent() {
            add_helper_candidates(&mut candidates, grandparent, name);
        }
    }

    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| format!("service helper not found: {name}"))
}

fn add_helper_candidates(candidates: &mut Vec<PathBuf>, dir: &Path, name: &str) {
    push_candidate(candidates, dir.join("helpers").join(name));
    push_candidate(candidates, dir.join("Resources").join("helpers").join(name));
    push_candidate(candidates, dir.join("resources").join("helpers").join(name));
    push_candidate(
        candidates,
        dir.join("resources")
            .join("resources")
            .join("helpers")
            .join(name),
    );
    push_candidate(candidates, dir.join(name));
    push_candidate(candidates, dir.join("Resources").join(name));
    push_candidate(candidates, dir.join("resources").join(name));
    push_candidate(
        candidates,
        dir.join("resources").join("resources").join(name),
    );
}

fn push_candidate(candidates: &mut Vec<PathBuf>, path: PathBuf) {
    if !candidates.iter().any(|candidate| candidate == &path) {
        candidates.push(path);
    }
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
    if let Some(detail) = result_path.and_then(read_result_file) {
        parts.push(detail);
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
        "no detail returned".to_string()
    } else {
        parts.join("\n")
    };

    format!(
        "{action} failed, exit code: {:?}\n{detail}",
        output.status.code()
    )
}

#[cfg(windows)]
fn is_elevated() -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }

        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut size = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        )
        .is_ok();
        let _ = CloseHandle(token);

        ok && elevation.TokenIsElevated != 0
    }
}

#[cfg(windows)]
fn elevate_and_install_blocking(
    installer_path: &Path,
    config_dir: &Path,
    action_label: &'static str,
    result_action: &'static str,
) -> Result<(), String> {
    log::info!("requesting UAC to {action_label}");

    let installer_str = installer_path.to_string_lossy().to_string();
    let config_dir_str = config_dir.to_string_lossy().to_string();
    let result_path = service_result_path(&format!("{result_action}-elevated"));
    let result_path_str = result_path.to_string_lossy().to_string();

    let status = runas::Command::new(&installer_str)
        .arg("--dir")
        .arg(&config_dir_str)
        .arg("--action")
        .arg(result_action)
        .arg("--result")
        .arg(&result_path_str)
        .show(false)
        .status()
        .map_err(|e| format!("run elevated service install helper failed: {e}"))?;

    if !status.success() {
        let detail = read_result_file(&result_path).unwrap_or_else(|| "no detail returned".into());
        return Err(format!(
            "elevated {action_label} failed, exit code: {:?}\n{}",
            status.code(),
            detail
        ));
    }

    Ok(())
}

#[cfg(windows)]
async fn elevate_and_uninstall(uninstaller_path: &Path) -> Result<(), String> {
    log::info!("requesting UAC to uninstall service");

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
    .map_err(|e| format!("service uninstall elevation task failed: {e}"))?
    .map_err(|e| format!("run elevated service uninstall helper failed: {e}"))?;

    if !status.success() {
        let detail = read_result_file(&result_path).unwrap_or_else(|| "no detail returned".into());
        return Err(format!(
            "elevated uninstall service failed, exit code: {:?}\n{}",
            status.code(),
            detail
        ));
    }

    Ok(())
}
