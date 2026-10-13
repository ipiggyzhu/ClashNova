//! 内核缓存与固定服务路径的升级。提权 helper 独立验证官方摘要，不相信用户可写的收据。
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::update_io::{self, Asset, Release, Staging, CORE_REPO};

const ARCHIVE_ENTRY: &str = "mihomo-windows-amd64.exe";
const MAX_CORE: u64 = 128 * 1024 * 1024;
const LOCK: &str = include_str!("../../scripts/mihomo.lock.json");

#[derive(Clone)]
pub struct CoreRelease {
    pub version: String,
    pub asset: Asset,
}

impl CoreRelease {
    pub fn id(&self) -> Result<String, String> {
        Ok(format!(
            "{}-{}",
            self.version,
            update_io::asset_hash(&self.asset)?
        ))
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreReceipt {
    pub id: String,
    pub version: String,
    pub binary_size: u64,
    pub binary_sha256: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstalledCore {
    pub id: String,
    pub version: String,
    pub bundled: bool,
    pub active: bool,
}

#[derive(Serialize, Deserialize)]
struct Selection {
    id: String,
}

pub fn bundled_version() -> Result<String, String> {
    let lock: serde_json::Value = serde_json::from_str(LOCK).map_err(|_| "内置内核锁文件错误")?;
    lock["version"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| "内置内核锁文件缺少版本".into())
}

pub fn parse_id(id: &str) -> Result<(&str, &str), String> {
    let (version, hash) = id.rsplit_once('-').ok_or("内核标识不合法")?;
    if !version.starts_with('v')
        || !update_io::valid_hash(hash, 64)
        || hash.bytes().any(|byte| byte.is_ascii_uppercase())
    {
        return Err("内核标识不合法".into());
    }
    update_io::version_tuple(version)?;
    Ok((version, hash))
}

pub fn cache_dir(config_dir: &Path, id: &str) -> Result<PathBuf, String> {
    parse_id(id)?;
    Ok(config_dir.join("updates/cores").join(id))
}

pub fn selection_file(config_dir: &Path) -> PathBuf {
    config_dir.join("updates/core-selection.json")
}

pub fn selected_id(config_dir: &Path) -> Result<String, String> {
    let path = selection_file(config_dir);
    if !path.exists() {
        return Ok("bundled".into());
    }
    let selection: Selection = read_json(&path)?;
    if selection.id != "bundled" {
        parse_id(&selection.id)?;
    }
    Ok(selection.id)
}

pub fn select(config_dir: &Path, id: &str) -> Result<(), String> {
    if id != "bundled" {
        parse_id(id)?;
    }
    let dir = config_dir.join("updates");
    std::fs::create_dir_all(&dir).map_err(|_| "创建内核选择目录失败")?;
    update_io::checked_path(&dir)?;
    write_json(&selection_file(config_dir), &Selection { id: id.into() })
}

pub fn read_receipt(config_dir: &Path, id: &str) -> Result<CoreReceipt, String> {
    let receipt: CoreReceipt = read_json(&cache_dir(config_dir, id)?.join("receipt.json"))?;
    let (version, _) = parse_id(id)?;
    if receipt.id != id
        || receipt.version != version
        || receipt.binary_size == 0
        || receipt.binary_size > MAX_CORE
        || !update_io::valid_hash(&receipt.binary_sha256, 64)
    {
        return Err("内核缓存收据无效，请重新下载".into());
    }
    Ok(receipt)
}

pub fn verified_cached_binary(config_dir: &Path, id: &str) -> Result<PathBuf, String> {
    let receipt = read_receipt(config_dir, id)?;
    let path = cache_dir(config_dir, id)?.join("mihomo.exe");
    update_io::verify_file(&path, receipt.binary_size, &receipt.binary_sha256)?;
    Ok(path)
}

pub fn selected_binary(config_dir: &Path) -> Result<Option<PathBuf>, String> {
    let id = selected_id(config_dir)?;
    if id == "bundled" {
        Ok(None)
    } else {
        verified_cached_binary(config_dir, &id).map(Some)
    }
}

pub fn installed(config_dir: &Path) -> Result<Vec<InstalledCore>, String> {
    let active = selected_id(config_dir)?;
    let mut result = vec![InstalledCore {
        id: "bundled".into(),
        version: bundled_version()?,
        bundled: true,
        active: active == "bundled",
    }];
    if let Ok(entries) = std::fs::read_dir(config_dir.join("updates/cores")) {
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if let Ok(receipt) = read_receipt(config_dir, &id) {
                result.push(InstalledCore {
                    active: id == active,
                    id,
                    version: receipt.version,
                    bundled: false,
                });
            }
        }
    }
    result[1..].sort_by(|left, right| {
        right
            .version
            .cmp(&left.version)
            .then(left.id.cmp(&right.id))
    });
    Ok(result)
}

pub async fn release(
    client: &reqwest::Client,
    version: Option<&str>,
) -> Result<CoreRelease, String> {
    let suffix = if let Some(version) = version {
        update_io::version_tuple(version)?;
        format!("releases/tags/{version}")
    } else {
        "releases/latest".into()
    };
    let release: Release = update_io::api(client, CORE_REPO, &suffix).await?;
    parse_release(release, version)
}

fn parse_release(release: Release, requested: Option<&str>) -> Result<CoreRelease, String> {
    update_io::version_tuple(&release.tag_name)?;
    if release.draft
        || release.prerelease
        || !release.tag_name.starts_with('v')
        || requested.is_some_and(|version| version != release.tag_name)
    {
        return Err("官方内核发布不是请求的稳定版本".into());
    }
    let name = format!("mihomo-windows-amd64-{}.zip", release.tag_name);
    let matching: Vec<_> = release
        .assets
        .into_iter()
        .filter(|asset| asset.name == name)
        .collect();
    if matching.len() != 1 {
        return Err("官方发布缺少唯一的 Windows amd64 ZIP".into());
    }
    let asset = matching.into_iter().next().ok_or("内核发布资产不存在")?;
    update_io::validate_asset(&asset, CORE_REPO, &release.tag_name, &name, MAX_CORE)?;
    Ok(CoreRelease {
        version: release.tag_name,
        asset,
    })
}

pub fn cache_download(
    config_dir: &Path,
    release: &CoreRelease,
    stage: &Staging,
) -> Result<CoreReceipt, String> {
    let id = release.id()?;
    let destination = cache_dir(config_dir, &id)?;
    let archive = stage.0.join("archive.zip");
    update_io::verify_file(
        &archive,
        release.asset.size,
        &update_io::asset_hash(&release.asset)?,
    )?;
    let binary = stage.0.join("mihomo.exe");
    extract_binary(&archive, &binary)?;
    let receipt = CoreReceipt {
        id: id.clone(),
        version: release.version.clone(),
        binary_size: std::fs::metadata(&binary)
            .map_err(|_| "内核解压结果不存在")?
            .len(),
        binary_sha256: update_io::hash_file(&binary, MAX_CORE)?,
    };
    if destination.exists() {
        if let Ok(existing) = read_receipt(config_dir, &id) {
            if existing.binary_size == receipt.binary_size
                && existing.binary_sha256 == receipt.binary_sha256
                && update_io::verify_file(
                    &destination.join("archive.zip"),
                    release.asset.size,
                    &update_io::asset_hash(&release.asset)?,
                )
                .is_ok()
                && update_io::verify_file(
                    &destination.join("mihomo.exe"),
                    receipt.binary_size,
                    &receipt.binary_sha256,
                )
                .is_ok()
            {
                return Ok(existing);
            }
        }
    }
    // 新下载已通过发布摘要和 ZIP 校验。损坏缓存也只在完整新副本就绪后提交。
    write_json(&stage.0.join("receipt.json"), &receipt)?;
    commit_cache(&stage.0, &destination)?;
    Ok(receipt)
}

fn commit_cache(stage: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination.parent().ok_or("无效的内核缓存目录")?;
    std::fs::create_dir_all(parent).map_err(|_| "创建内核缓存目录失败")?;
    update_io::checked_path(parent)?;
    if !destination.exists() {
        return std::fs::rename(stage, destination)
            .map_err(|_| "提交内核缓存失败，现有内核未改动".into());
    }
    update_io::checked_path(destination)?;
    if !destination.is_dir() {
        return Err("内核缓存路径不是目录，现有文件未改动".into());
    }
    let rollback = Staging::create(parent)?;
    let previous = rollback.0.join("previous");
    // 不预删除旧缓存。提交失败时原目录可立即改名恢复，成功后才清理旧文件。
    std::fs::rename(destination, &previous).map_err(|_| "暂存原内核缓存失败，现有内核未改动")?;
    match std::fs::rename(stage, destination) {
        Ok(()) => {
            drop(Staging(previous));
            Ok(())
        }
        Err(_) => match std::fs::rename(&previous, destination) {
            Ok(()) => Err("提交内核缓存失败，已恢复原缓存".into()),
            Err(_) => Err("提交与恢复内核缓存失败，原缓存仍保留在修复暂存目录".into()),
        },
    }
}

#[cfg(windows)]
pub fn extract_binary(archive: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    update_io::checked_path(archive)?;
    update_io::checked_path(destination.parent().ok_or("无效的内核暂存目录")?)?;
    if destination.exists() {
        return Err("内核解压目标已存在".into());
    }
    let quote = |path: &Path| path.to_string_lossy().replace('\'', "''");
    // 只读取一个严格匹配的条目并写固定文件名，不调用 ExtractToDirectory。
    let script = format!(
        r#"$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression;
$input=[IO.File]::OpenRead('{}'); $zip=$null; $source=$null; $output=$null;
try {{
  $zip=[IO.Compression.ZipArchive]::new($input,[IO.Compression.ZipArchiveMode]::Read);
  if($zip.Entries.Count -ne 1){{throw 'Unexpected ZIP entries'}};
  $entry=$zip.Entries[0];
  if($entry.FullName -cne '{ARCHIVE_ENTRY}' -or $entry.Length -lt 1024 -or $entry.Length -gt {MAX_CORE}){{throw 'Invalid core ZIP entry'}};
  $source=$entry.Open(); $output=[IO.File]::Open('{}',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);
  $buffer=New-Object byte[] 65536; $total=0L;
  while(($count=$source.Read($buffer,0,$buffer.Length)) -gt 0){{ $total+=$count; if($total -gt $entry.Length){{throw 'ZIP size exceeded'}}; $output.Write($buffer,0,$count) }};
  if($total -ne $entry.Length){{throw 'ZIP size mismatch'}}; $output.Flush($true)
}} finally {{ if($output){{$output.Dispose()}}; if($source){{$source.Dispose()}}; if($zip){{$zip.Dispose()}}; $input.Dispose() }}"#,
        quote(archive),
        quote(destination)
    );
    let powershell = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut child = Command::new(powershell)
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(0x08000000)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "启动 Windows ZIP 解压失败")?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break validate_pe(destination),
            Ok(Some(_)) => break Err("内核 ZIP 条目、长度或解压校验失败".into()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("内核 ZIP 解压超时或进程异常".into());
            }
        }
    };
    if result.is_err() {
        let _ = std::fs::remove_file(destination);
    }
    result
}

#[cfg(not(windows))]
pub fn extract_binary(_archive: &Path, _destination: &Path) -> Result<(), String> {
    Err("本轮内核更新仅支持 Windows".into())
}

fn validate_pe(path: &Path) -> Result<(), String> {
    use std::io::{Seek, SeekFrom};
    let mut file = File::open(path).map_err(|_| "读取解压内核失败")?;
    let size = file.metadata().map_err(|_| "读取解压内核长度失败")?.len();
    let mut header = [0; 64];
    file.read_exact(&mut header)
        .map_err(|_| "内核缺少 PE 文件头")?;
    let offset =
        u32::from_le_bytes(header[60..64].try_into().map_err(|_| "内核 PE 头错误")?) as u64;
    if &header[..2] != b"MZ" || offset < 64 || offset + 6 > size || size > MAX_CORE {
        return Err("内核不是有效的 Windows PE 文件".into());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| "读取 PE 头失败")?;
    let mut pe = [0; 6];
    file.read_exact(&mut pe).map_err(|_| "读取 PE 头失败")?;
    if &pe[..4] != b"PE\0\0" || pe[4..] != [0x64, 0x86] {
        return Err("内核不是 Windows x64 PE 文件".into());
    }
    Ok(())
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    update_io::checked_path(path)?;
    let file = File::open(path).map_err(|_| "读取内核元数据失败")?;
    if file.metadata().map_err(|_| "读取内核元数据失败")?.len() > 16 * 1024 {
        return Err("内核元数据超过大小上限".into());
    }
    serde_json::from_reader(file.take(16 * 1024)).map_err(|_| "内核元数据格式错误".into())
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().ok_or("无效的内核元数据目录")?;
    update_io::checked_path(parent)?;
    if path.exists() {
        update_io::checked_path(path)?;
    }
    let stage = Staging::create(parent)?;
    let temp = stage.0.join("metadata.json");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|_| "创建内核元数据失败")?;
    serde_json::to_writer(&mut file, value).map_err(|_| "写入内核元数据失败")?;
    file.flush()
        .and_then(|_| file.sync_all())
        .map_err(|_| "同步内核元数据失败")?;
    drop(file);
    std::fs::rename(temp, path).map_err(|_| "提交内核元数据失败".into())
}

#[cfg(windows)]
pub struct PreparedManagedCore {
    stage: Staging,
    receipt: CoreReceipt,
}

#[cfg(windows)]
pub async fn prepare_managed(
    config_dir: &Path,
    id: &str,
    bundled_source: &Path,
) -> Result<PreparedManagedCore, String> {
    use nova_service_ipc::policy::windows_security::protect_installation_path;
    let service_dir = crate::service_paths::managed_service_dir();
    // 安装目录必须已由服务安装流程创建并保护；此处不创建新的任意服务目录。
    update_io::checked_path(&service_dir)?;
    protect_installation_path(&service_dir).map_err(|_| "保护服务目录失败")?;
    let stage = Staging::create(&service_dir)?;
    protect_installation_path(&stage.0).map_err(|_| "保护内核暂存目录失败")?;
    let binary = stage.0.join("mihomo.exe");
    let version;
    if id == "bundled" {
        update_io::checked_path(bundled_source)?;
        bounded_copy(bundled_source, &binary, MAX_CORE)?;
        crate::service_paths::verify_bundled_core(&binary)?;
        version = bundled_version()?;
    } else {
        let (requested, hash) = parse_id(id)?;
        let client = update_io::client()?;
        let official = release(&client, Some(requested)).await?;
        if update_io::asset_hash(&official.asset)? != hash {
            return Err("内核缓存与官方当前发布摘要不同，请重新下载".into());
        }
        let archive = stage.0.join("archive.zip");
        let source = cache_dir(config_dir, id)?.join("archive.zip");
        update_io::checked_path(&source)?;
        bounded_copy(&source, &archive, official.asset.size)?;
        // 复制到受保护目录后才哈希，避免校验后到提权执行前被用户替换。
        update_io::verify_file(&archive, official.asset.size, hash)?;
        extract_binary(&archive, &binary)?;
        version = official.version;
    }
    validate_pe(&binary)?;
    protect_installation_path(&binary).map_err(|_| "保护服务内核失败")?;
    let receipt = CoreReceipt {
        id: id.into(),
        version,
        binary_size: std::fs::metadata(&binary)
            .map_err(|_| "读取服务内核长度失败")?
            .len(),
        binary_sha256: update_io::hash_file(&binary, MAX_CORE)?,
    };
    Ok(PreparedManagedCore { stage, receipt })
}

#[cfg(windows)]
pub fn apply_managed(prepared: PreparedManagedCore) -> Result<(), String> {
    let directory = crate::service_paths::managed_service_dir();
    apply_to_directory(prepared, &directory)
}

#[cfg(windows)]
fn apply_to_directory(prepared: PreparedManagedCore, directory: &Path) -> Result<(), String> {
    let target = directory.join("mihomo.exe");
    let backup = directory.join("mihomo.rollback.exe");
    update_io::checked_path(&target)?;
    if backup.exists() {
        update_io::checked_path(&backup)?;
    }
    let pending_backup = prepared.stage.0.join("previous.exe");
    bounded_copy(&target, &pending_backup, MAX_CORE)?;
    // backup 继承已受保护的 staging 目录 ACL，rename 到同一服务目录不放宽权限。
    std::fs::rename(&pending_backup, &backup).map_err(|_| "保存原服务内核失败")?;
    let result = (|| {
        update_io::verify_file(
            &prepared.stage.0.join("mihomo.exe"),
            prepared.receipt.binary_size,
            &prepared.receipt.binary_sha256,
        )?;
        std::fs::rename(prepared.stage.0.join("mihomo.exe"), &target)
            .map_err(|_| "替换服务内核失败")?;
        write_json(&directory.join("core-version.json"), &prepared.receipt)
    })();
    if let Err(error) = result {
        return match rollback_directory(directory) {
            Ok(()) => Err(format!("{error}，已恢复原服务内核")),
            Err(rollback) => Err(format!("{error}；回滚失败: {rollback}")),
        };
    }
    Ok(())
}

#[cfg(windows)]
pub fn rollback_managed() -> Result<(), String> {
    let directory = crate::service_paths::managed_service_dir();
    rollback_directory(&directory)
}

#[cfg(windows)]
fn rollback_directory(directory: &Path) -> Result<(), String> {
    let backup = directory.join("mihomo.rollback.exe");
    update_io::checked_path(&backup)?;
    validate_pe(&backup)?;
    std::fs::rename(&backup, directory.join("mihomo.exe")).map_err(|_| "恢复原服务内核失败")?;
    // 该收据只用于显示，不用于提权信任决策；回滚后二进制以实际摘要为准。
    match std::fs::remove_file(directory.join("core-version.json")) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("原内核已恢复，但清理新版本收据失败".into()),
    }
}

fn bounded_copy(source: &Path, destination: &Path, limit: u64) -> Result<(), String> {
    let input = File::open(source).map_err(|_| "打开内核源文件失败")?;
    let mut input = input.take(limit + 1);
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| "创建内核副本失败")?;
    let copied = std::io::copy(&mut input, &mut output).map_err(|_| "复制内核失败")?;
    if copied == 0 || copied > limit {
        return Err("内核源文件超过声明大小".into());
    }
    output
        .flush()
        .and_then(|_| output.sync_all())
        .map_err(|_| "同步内核副本失败".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_identity_rejects_paths_and_selection_defaults_to_bundle() {
        for id in [
            "../x",
            "v1.2.3-../mihomo",
            "v1.2.3-AAAA",
            "C:\\Windows\\cmd.exe",
        ] {
            assert!(parse_id(id).is_err());
        }
        let root = Staging::create(&std::env::temp_dir()).unwrap();
        assert_eq!(selected_id(&root.0).unwrap(), "bundled");
        let id = format!("v1.19.27-{}", "a".repeat(64));
        assert_eq!(parse_id(&id).unwrap().0, "v1.19.27");
        assert!(select(&root.0, "../x").is_err());
    }

    #[test]
    fn failed_cache_commit_restores_original_directory_before_retry() {
        let root = Staging::create(&std::env::temp_dir()).unwrap();
        let destination = root.0.join("cache");
        std::fs::create_dir(&destination).unwrap();
        std::fs::write(destination.join("old"), b"original").unwrap();
        assert!(commit_cache(&root.0.join("missing-stage"), &destination).is_err());
        assert_eq!(std::fs::read(destination.join("old")).unwrap(), b"original");
        let replacement = Staging::create(&root.0).unwrap();
        std::fs::write(replacement.0.join("new"), b"verified").unwrap();
        commit_cache(&replacement.0, &destination).unwrap();
        assert!(!destination.join("old").exists());
        assert_eq!(std::fs::read(destination.join("new")).unwrap(), b"verified");
        drop(Staging(destination));
    }

    #[test]
    fn cached_pe_detects_tampering_and_non_x64_headers() {
        let root = Staging::create(&std::env::temp_dir()).unwrap();
        let path = root.0.join("mihomo.exe");
        let mut bytes = vec![0u8; 1024];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[60..64].copy_from_slice(&64u32.to_le_bytes());
        bytes[64..70].copy_from_slice(b"PE\0\0\x64\x86");
        std::fs::write(&path, &bytes).unwrap();
        assert!(validate_pe(&path).is_ok());
        bytes[68] = 0x4c;
        bytes[69] = 0x01;
        std::fs::write(&path, &bytes).unwrap();
        assert!(validate_pe(&path).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn service_binary_swap_and_rollback_keep_previous_bytes() {
        let root = Staging::create(&std::env::temp_dir()).unwrap();
        let mut old = vec![0u8; 1024];
        old[..2].copy_from_slice(b"MZ");
        old[60..64].copy_from_slice(&64u32.to_le_bytes());
        old[64..70].copy_from_slice(b"PE\0\0\x64\x86");
        let mut new = old.clone();
        new[128] = 42;
        let target = root.0.join("mihomo.exe");
        std::fs::write(&target, &old).unwrap();
        let prepare = || {
            let stage = Staging::create(&root.0).unwrap();
            let binary = stage.0.join("mihomo.exe");
            std::fs::write(&binary, &new).unwrap();
            let receipt = CoreReceipt {
                id: "bundled".into(),
                version: "v1.19.27".into(),
                binary_size: 1024,
                binary_sha256: update_io::hash_file(&binary, MAX_CORE).unwrap(),
            };
            PreparedManagedCore { stage, receipt }
        };
        apply_to_directory(prepare(), &root.0).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), new);
        rollback_directory(&root.0).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), old);
        // 文件提交成功而收据提交失败时，也必须立即回滚原二进制。
        std::fs::create_dir(root.0.join("core-version.json")).unwrap();
        assert!(apply_to_directory(prepare(), &root.0).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), old);
        std::fs::remove_dir(root.0.join("core-version.json")).unwrap();
    }

    #[cfg(windows)]
    fn write_zip_fixture(archive: &Path, name: &str, extra: bool) {
        use std::os::windows::process::CommandExt;
        let script = format!(
            r#"Add-Type -AssemblyName System.IO.Compression;
$file=[IO.File]::Open('{}',[IO.FileMode]::CreateNew); $zip=[IO.Compression.ZipArchive]::new($file,[IO.Compression.ZipArchiveMode]::Create);
$entry=$zip.CreateEntry('{name}'); $data=New-Object byte[] 1024; $data[0]=77; $data[1]=90; $data[60]=64; $data[64]=80; $data[65]=69; $data[68]=100; $data[69]=134;
$stream=$entry.Open(); $stream.Write($data,0,$data.Length); $stream.Dispose();
if(${extra}){{$null=$zip.CreateEntry('extra.exe')}}; $zip.Dispose(); $file.Dispose();"#,
            archive.to_string_lossy().replace('\'', "''")
        );
        let status = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(0x08000000)
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[cfg(windows)]
    #[test]
    fn zip_extraction_accepts_only_single_fixed_pe_entry() {
        let root = Staging::create(&std::env::temp_dir()).unwrap();
        for (index, name, extra, valid) in [
            (0, ARCHIVE_ENTRY, false, true),
            (1, "../mihomo.exe", false, false),
            (2, ARCHIVE_ENTRY, true, false),
            (3, "wrong.exe", false, false),
        ] {
            let archive = root.0.join(format!("test{index}.zip"));
            let target = root.0.join(format!("test{index}.exe"));
            write_zip_fixture(&archive, name, extra);
            assert_eq!(extract_binary(&archive, &target).is_ok(), valid, "{name}");
            assert_eq!(target.exists(), valid);
        }
        assert!(!root.0.parent().unwrap().join("mihomo.exe").exists());
    }

    #[cfg(windows)]
    #[test]
    fn verified_redownload_repairs_corrupt_cache_without_predeleting_it() {
        let root = Staging::create(&std::env::temp_dir()).unwrap();
        let config = root.0.join("config");
        let archive = root.0.join("official.zip");
        write_zip_fixture(&archive, ARCHIVE_ENTRY, false);
        let hash = update_io::hash_file(&archive, MAX_CORE).unwrap();
        let release = CoreRelease {
            version: "v1.19.27".into(),
            asset: Asset {
                name: "mihomo-windows-amd64-v1.19.27.zip".into(),
                size: std::fs::metadata(&archive).unwrap().len(),
                digest: Some(format!("sha256:{hash}")),
                browser_download_url: "https://github.com/MetaCubeX/mihomo/releases/download/v1.19.27/mihomo-windows-amd64-v1.19.27.zip".into(),
                state: "uploaded".into(),
            },
        };
        let download = || {
            let stage = Staging::create(&root.0).unwrap();
            std::fs::copy(&archive, stage.0.join("archive.zip")).unwrap();
            stage
        };
        let receipt = cache_download(&config, &release, &download()).unwrap();
        let directory = cache_dir(&config, &receipt.id).unwrap();
        for file in ["mihomo.exe", "archive.zip", "receipt.json"] {
            std::fs::write(directory.join(file), b"corrupted").unwrap();
            cache_download(&config, &release, &download()).unwrap();
            verified_cached_binary(&config, &receipt.id).unwrap();
            update_io::verify_file(&directory.join("archive.zip"), release.asset.size, &hash)
                .unwrap();
        }
        let mut wrong = receipt.clone();
        wrong.binary_sha256 = "0".repeat(64);
        write_json(&directory.join("receipt.json"), &wrong).unwrap();
        cache_download(&config, &release, &download()).unwrap();
        verified_cached_binary(&config, &receipt.id).unwrap();

        std::fs::write(
            directory.join("mihomo.exe"),
            b"keep until verified replacement",
        )
        .unwrap();
        let invalid = download();
        std::fs::write(invalid.0.join("archive.zip"), b"bad download").unwrap();
        assert!(cache_download(&config, &release, &invalid).is_err());
        assert_eq!(
            std::fs::read(directory.join("mihomo.exe")).unwrap(),
            b"keep until verified replacement"
        );
        cache_download(&config, &release, &download()).unwrap();
        verified_cached_binary(&config, &receipt.id).unwrap();
        drop(Staging(directory));
        std::fs::remove_dir(config.join("updates/cores")).unwrap();
        std::fs::remove_dir(config.join("updates")).unwrap();
        std::fs::remove_dir(config).unwrap();
    }
}
