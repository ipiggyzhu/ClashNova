use std::path::{Path, PathBuf};

pub const SERVICE_EXE_NAME: &str = "clashnova-service.exe";

#[cfg(windows)]
pub fn normalized_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_matches('"')
        .to_ascii_lowercase()
}

#[cfg(windows)]
fn push_candidate(candidates: &mut Vec<PathBuf>, path: PathBuf) {
    if !candidates.iter().any(|candidate| candidate == &path) {
        candidates.push(path);
    }
}

#[cfg(windows)]
pub fn managed_service_dir() -> PathBuf {
    nova_service_ipc::policy::managed_service_directory()
}

#[cfg(windows)]
pub fn managed_service_binary_path() -> PathBuf {
    managed_service_dir().join(SERVICE_EXE_NAME)
}

#[cfg(windows)]
fn same_path(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => normalized_path(left) == normalized_path(right),
    }
}

#[cfg(windows)]
pub fn service_binary_candidates(base_dir: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    add_service_binary_candidates(&mut candidates, base_dir);

    if let Some(parent) = base_dir.parent() {
        add_service_binary_candidates(&mut candidates, parent);
        if let Some(grandparent) = parent.parent() {
            add_service_binary_candidates(&mut candidates, grandparent);
        }
    }

    candidates
}

#[cfg(windows)]
fn add_service_binary_candidates(candidates: &mut Vec<PathBuf>, dir: &Path) {
    push_candidate(candidates, dir.join("helpers").join(SERVICE_EXE_NAME));
    push_candidate(
        candidates,
        dir.join("Resources").join("helpers").join(SERVICE_EXE_NAME),
    );
    push_candidate(
        candidates,
        dir.join("resources").join("helpers").join(SERVICE_EXE_NAME),
    );
    push_candidate(
        candidates,
        dir.join("resources")
            .join("resources")
            .join("helpers")
            .join(SERVICE_EXE_NAME),
    );
    push_candidate(candidates, dir.join(SERVICE_EXE_NAME));
    push_candidate(candidates, dir.join("Resources").join(SERVICE_EXE_NAME));
    push_candidate(candidates, dir.join("resources").join(SERVICE_EXE_NAME));
    push_candidate(
        candidates,
        dir.join("resources")
            .join("resources")
            .join(SERVICE_EXE_NAME),
    );
}

#[cfg(windows)]
pub fn find_bundled_service_binary(base_dir: &Path) -> Result<PathBuf, String> {
    let candidates = service_binary_candidates(base_dir);
    if let Some(path) = candidates.iter().find(|path| path.exists()) {
        return Ok(path.clone());
    }

    let checked = candidates
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!("service host not found; checked: {checked}"))
}

#[cfg(windows)]
pub fn managed_core_binary_path() -> PathBuf {
    managed_service_dir().join(nova_service_ipc::policy::MANAGED_CORE_NAME)
}

#[cfg(windows)]
pub fn service_config_matches(command: &Path, config_dir: &Path) -> bool {
    let command = command.to_string_lossy();
    command.split_once("--dir").is_some_and(|(_, args)| {
        normalized_path(Path::new(args.trim().trim_matches('"'))) == normalized_path(config_dir)
    })
}

#[cfg(windows)]
fn install_binary(source: &Path, target: &Path) -> Result<(), String> {
    use nova_service_ipc::policy::windows_security::protect_installation_path;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    if same_path(source, target) {
        return protect_installation_path(target).map_err(|e| e.to_string());
    }
    static INSTALL_ID: AtomicU64 = AtomicU64::new(0);
    let temp = target.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        INSTALL_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let mut input = std::fs::File::open(source).map_err(|e| format!("open bundled binary: {e}"))?;
    // create_new 失败时本次没有获得临时文件所有权, 不得进入清理分支。
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| format!("create managed binary: {e}"))?;
    let result = (|| {
        std::io::copy(&mut input, &mut output).map_err(|e| format!("copy managed binary: {e}"))?;
        output.flush().map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        protect_installation_path(&temp).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, target)
            .map_err(|e| format!("replace managed binary; stop service and retry: {e}"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(windows)]
pub fn prepare_managed_service_binary(source: &Path) -> Result<PathBuf, String> {
    use nova_service_ipc::policy::windows_security::protect_installation_path;
    let target = managed_service_binary_path();
    let service_dir = managed_service_dir();
    let product_dir = service_dir.parent().ok_or("invalid service directory")?;
    std::fs::create_dir_all(product_dir).map_err(|e| e.to_string())?;
    protect_installation_path(product_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&service_dir).map_err(|e| e.to_string())?;
    protect_installation_path(&service_dir).map_err(|e| e.to_string())?;
    let logs = service_dir.join("logs");
    std::fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    protect_installation_path(&logs).map_err(|e| e.to_string())?;

    let core_target = managed_core_binary_path();
    let core_source = source
        .parent()
        .into_iter()
        .flat_map(|parent| parent.ancestors().take(4))
        .flat_map(|dir| {
            [
                dir.join("mihomo.exe"),
                dir.join("mihomo-x86_64-pc-windows-msvc.exe"),
                dir.join("binaries/mihomo-x86_64-pc-windows-msvc.exe"),
                dir.join("src-tauri/binaries/mihomo-x86_64-pc-windows-msvc.exe"),
                dir.join("resources/mihomo.exe"),
            ]
        })
        .find(|candidate| candidate.is_file())
        .ok_or(
            "bundled mihomo not found; reinstall the application before repairing its service",
        )?;
    install_binary(&core_source, &core_target)?;
    install_binary(source, &target)?;
    Ok(target)
}

#[cfg(windows)]
pub fn remove_managed_service_binary() -> Result<(), String> {
    let target = managed_service_binary_path();
    match std::fs::remove_file(&target) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            return Err(format!(
                "remove managed service host failed: {}: {err}",
                target.display()
            ));
        }
    }

    let _ = std::fs::remove_file(managed_core_binary_path());
    match std::fs::remove_dir(managed_service_dir()) {
        Ok(()) => {}
        Err(err)
            if matches!(
                err.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) => {}
        Err(err) => return Err(format!("remove managed service directory failed: {err}")),
    }

    Ok(())
}
