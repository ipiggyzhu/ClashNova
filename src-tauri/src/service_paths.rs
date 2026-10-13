use std::path::{Path, PathBuf};

pub const SERVICE_EXE_NAME: &str = "clashnova-service.exe";

pub fn write_helper_result(path: &Path, ok: bool, message: &str) -> Result<(), String> {
    use std::io::Write;
    if !path.is_absolute() {
        return Err("service result path must be absolute".into());
    }
    crate::update_io::checked_path(path.parent().ok_or("invalid service result path")?)?;
    // 调用者提供的路径不能覆盖现存文件或 hard link；父目录也不能经过重解析点。
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "create service result failed")?;
    let prefix = if ok { "ok" } else { "error" };
    writeln!(file, "{prefix}\n{message}").map_err(|_| "write service result failed")?;
    file.sync_all()
        .map_err(|_| "sync service result failed".into())
}

#[cfg(windows)]
pub fn verify_bundled_core(path: &Path) -> Result<(), String> {
    let lock: serde_json::Value =
        serde_json::from_str(include_str!("../../scripts/mihomo.lock.json"))
            .map_err(|_| "invalid bundled core lock")?;
    let windows = &lock["targets"]["windows"];
    let size = windows["binarySize"]
        .as_u64()
        .ok_or("missing bundled core size")?;
    let hash = windows["binarySha256"]
        .as_str()
        .ok_or("missing bundled core digest")?;
    crate::update_io::verify_file(path, size, hash).map_err(|_| {
        "bundled core does not match the locked official size/SHA256; reinstall the application"
            .into()
    })
}

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
fn install_binary(source: &Path, target: &Path, bundled_core: bool) -> Result<(), String> {
    use nova_service_ipc::policy::windows_security::protect_installation_path;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    if same_path(source, target) {
        if bundled_core {
            verify_bundled_core(target)?;
        }
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
        if bundled_core {
            // 受保护副本提交前再验证，源路径在复制前后变化也不能替换已安装的内核。
            verify_bundled_core(&temp)?;
        }
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
    let core_source = find_bundled_core_binary(source)?;
    install_binary(&core_source, &core_target, true)?;
    install_binary(source, &target, false)?;
    Ok(target)
}

#[cfg(windows)]
pub fn find_bundled_core_binary(source: &Path) -> Result<PathBuf, String> {
    let candidate = source
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
    verify_bundled_core(&candidate)?;
    Ok(candidate)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update_io::Staging;

    #[test]
    fn helper_result_never_overwrites_existing_files_or_hard_links() {
        let root = Staging::create(&std::env::temp_dir()).unwrap();
        let result = root.0.join("result.txt");
        write_helper_result(&result, true, "done").unwrap();
        assert_eq!(std::fs::read_to_string(&result).unwrap(), "ok\ndone\n");
        assert!(write_helper_result(&result, false, "changed").is_err());
        let link = root.0.join("linked.txt");
        std::fs::hard_link(&result, &link).unwrap();
        assert!(write_helper_result(&link, false, "changed").is_err());
        assert_eq!(std::fs::read_to_string(&result).unwrap(), "ok\ndone\n");
        assert!(write_helper_result(Path::new("relative-result.txt"), true, "done").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn helper_result_rejects_junction_ancestors() {
        use std::os::windows::process::CommandExt;
        let root = Staging::create(&std::env::temp_dir()).unwrap();
        let real = root.0.join("real");
        let junction = root.0.join("junction");
        std::fs::create_dir(&real).unwrap();
        let quote = |path: &Path| path.to_string_lossy().replace('\'', "''");
        let status = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile", "-NonInteractive", "-Command",
                &format!("$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path '{}' -Target '{}' | Out-Null", quote(&junction), quote(&real)),
            ])
            .creation_flags(0x08000000)
            .status()
            .unwrap();
        assert!(status.success());
        let rejected = write_helper_result(&junction.join("result.txt"), true, "done").is_err();
        let untouched = !real.join("result.txt").exists();
        std::fs::remove_dir(&junction).unwrap();
        std::fs::remove_dir(&real).unwrap();
        assert!(rejected && untouched);
    }

    #[cfg(windows)]
    #[test]
    fn bundled_core_requires_locked_size_and_digest_not_just_pe_header() {
        use std::io::Write;
        let original = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/mihomo-x86_64-pc-windows-msvc.exe");
        verify_bundled_core(&original).unwrap();
        let root = Staging::create(&std::env::temp_dir()).unwrap();
        let fake = root.0.join("mihomo.exe");
        let mut bytes = vec![0u8; 1024];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[60..64].copy_from_slice(&64u32.to_le_bytes());
        bytes[64..70].copy_from_slice(b"PE\0\0\x64\x86");
        let mut file = std::fs::File::create(&fake).unwrap();
        file.write_all(&bytes).unwrap();
        drop(file);
        assert!(verify_bundled_core(&fake).is_err());
        assert!(find_bundled_core_binary(&root.0.join(SERVICE_EXE_NAME)).is_err());
        // 长度伪装正确也必须计算完整 SHA256，不能把 PE 格式检查当成来源验证。
        std::fs::OpenOptions::new()
            .write(true)
            .open(&fake)
            .unwrap()
            .set_len(std::fs::metadata(&original).unwrap().len())
            .unwrap();
        assert!(verify_bundled_core(&fake).is_err());
    }
}
