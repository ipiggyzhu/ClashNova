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
fn program_files_dir() -> PathBuf {
    std::env::var_os("ProgramFiles")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"))
}

#[cfg(windows)]
pub fn managed_service_dir() -> PathBuf {
    program_files_dir().join("ClashNova").join("service")
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
pub fn prepare_managed_service_binary(source: &Path) -> Result<PathBuf, String> {
    let target = managed_service_binary_path();
    if same_path(source, &target) {
        return Ok(target);
    }

    let target_dir = target
        .parent()
        .ok_or_else(|| format!("invalid managed service path: {}", target.display()))?;
    std::fs::create_dir_all(target_dir).map_err(|e| {
        format!(
            "create managed service directory failed: {}: {e}",
            target_dir.display()
        )
    })?;

    let temp = target.with_file_name(format!("{SERVICE_EXE_NAME}.tmp"));
    let _ = std::fs::remove_file(&temp);
    std::fs::copy(source, &temp).map_err(|e| {
        format!(
            "copy service host to managed path failed: {} -> {}: {e}",
            source.display(),
            temp.display()
        )
    })?;
    if target.exists() {
        std::fs::remove_file(&target).map_err(|e| {
            format!(
                "replace managed service host failed; stop the service and retry: {}: {e}",
                target.display()
            )
        })?;
    }
    std::fs::rename(&temp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!(
            "move managed service host into place failed: {}: {e}",
            target.display()
        )
    })?;

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
