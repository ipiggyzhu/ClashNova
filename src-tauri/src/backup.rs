//! 可移植的完整配置快照；运行时、日志和 WebDAV 凭据不进入备份。
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::profiles::{EnhancerMeta, ProfileMeta};
use crate::state::{
    atomic_write, now_millis, random_hex16, AppSettings, AppState, Dirs, FileTransaction,
};

#[path = "backup_webdav.rs"]
mod webdav;
pub use webdav::{WebDavConfig, WebDavConfigInput};

const FORMAT: &str = "ClashNovaBackup";
const SCHEMA_VERSION: u32 = 1;
const EXTENSION: &str = ".novabackup";
const MAX_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;
const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;
const MAX_FILES: usize = 2048;
const PROTECTED_SETTINGS: &[&str] = &[
    "sysProxy",
    "tun",
    "autostart",
    "silentStart",
    "hotkeys",
    "secret",
    "mixedPort",
    "externalController",
    "allowLan",
    "guard",
    "guardIntervalSec",
    "bypass",
    "dnsListen",
];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupFile {
    content: String,
    sha256: String,
}

impl BackupFile {
    fn new(content: String) -> Self {
        let sha256 = format!("{:x}", Sha256::digest(content.as_bytes()));
        Self { content, sha256 }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    format: String,
    schema_version: u32,
    id: String,
    label: String,
    created_at: u64,
    app_version: String,
    files: BTreeMap<String, BackupFile>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub id: String,
    pub label: String,
    pub created_at: u64,
    pub app_version: String,
    pub size_bytes: u64,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview {
    pub entry: BackupEntry,
    pub profile_count: usize,
    pub enhancer_count: usize,
    pub file_count: usize,
    pub preserved_settings: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupExport {
    pub filename: String,
    pub content: String,
}

fn new_id() -> String {
    format!("backup-{}-{}", now_millis(), random_hex16())
}

fn validate_id(id: &str) -> Result<(), String> {
    let parts: Vec<_> = id.split('-').collect();
    if parts.len() != 3
        || parts[0] != "backup"
        || parts[1].parse::<u64>().is_err()
        || !parts[1].bytes().all(|byte| byte.is_ascii_digit())
        || parts[1].len() > 20
        || parts[2].len() != 16
        || !parts[2].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("备份标识无效".into());
    }
    Ok(())
}

fn is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn checked_directory(parent: &Path, name: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(parent).map_err(|_| "配置目录不可读")?;
    let child = root.join(name);
    match fs::symlink_metadata(&child) {
        Ok(meta) if meta.is_dir() && !is_reparse(&meta) => {}
        Ok(_) => return Err("配置子目录不是普通目录".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&child).map_err(|_| "创建配置子目录失败")?;
        }
        Err(_) => return Err("配置子目录不可读".into()),
    }
    if fs::canonicalize(&child)
        .map_err(|_| "配置子目录不可读")?
        .parent()
        != Some(root.as_path())
    {
        return Err("配置子目录超出允许范围".into());
    }
    Ok(child)
}

fn checked_file(path: &Path, optional: bool) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !is_reparse(&meta) => Ok(()),
        Ok(_) => Err("备份目标不是普通文件".into()),
        Err(error) if optional && error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("备份文件不可读".into()),
    }
}

fn read_limited(path: &Path, limit: usize) -> Result<String, String> {
    checked_file(path, false)?;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "打开备份文件失败")?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取备份文件失败")?;
    if bytes.len() > limit {
        return Err("备份文件超过大小限制".into());
    }
    String::from_utf8(bytes).map_err(|_| "备份文件不是 UTF-8 文本".into())
}

fn safe_name(name: &str) -> bool {
    if name.is_empty()
        || name.len() > 200
        || name.starts_with('.')
        || name.ends_with('.')
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    {
        return false;
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn allowed_path(path: &str) -> bool {
    if path == "settings.json" || path == "profiles.json" {
        return true;
    }
    path.strip_prefix("profiles/").is_some_and(|name| {
        safe_name(name)
            && (name == "global-enhancers.json"
                || name.ends_with(".yaml")
                || name.ends_with(".yml")
                || name.ends_with(".js"))
    })
}

fn configuration_files(dirs: &Dirs) -> Result<BTreeMap<String, PathBuf>, String> {
    let mut paths = BTreeMap::new();
    for name in ["settings.json", "profiles.json"] {
        let path = dirs.config.join(name);
        checked_file(&path, true)?;
        if path.exists() {
            paths.insert(name.into(), path);
        }
    }
    let profiles = checked_directory(&dirs.config, "profiles")?;
    for entry in fs::read_dir(profiles).map_err(|_| "读取订阅目录失败")? {
        let entry = entry.map_err(|_| "读取订阅目录项失败")?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "订阅文件名不是 UTF-8")?;
        let key = format!("profiles/{name}");
        if allowed_path(&key) {
            checked_file(&entry.path(), false)?;
            paths.insert(key, entry.path());
        }
    }
    if paths.len() > MAX_FILES {
        return Err("备份文件数量超过限制".into());
    }
    Ok(paths)
}

fn snapshot_entry(snapshot: &Snapshot, size: usize) -> BackupEntry {
    BackupEntry {
        id: snapshot.id.clone(),
        label: snapshot.label.clone(),
        created_at: snapshot.created_at,
        app_version: snapshot.app_version.clone(),
        size_bytes: size as u64,
        source: "local".into(),
        error: None,
    }
}

fn indexes(snapshot: &Snapshot) -> Result<(Vec<ProfileMeta>, Vec<EnhancerMeta>), String> {
    let profiles = serde_json::from_str::<Vec<ProfileMeta>>(
        &snapshot
            .files
            .get("profiles.json")
            .ok_or("备份缺少订阅索引")?
            .content,
    )
    .map_err(|_| "备份订阅索引格式无效")?;
    let global = snapshot
        .files
        .get("profiles/global-enhancers.json")
        .map(|file| serde_json::from_str::<Vec<EnhancerMeta>>(&file.content))
        .transpose()
        .map_err(|_| "备份全局增强索引格式无效")?
        .unwrap_or_default();
    Ok((profiles, global))
}

fn validate_enhancers(
    snapshot: &Snapshot,
    prefix: &str,
    enhancers: &[EnhancerMeta],
) -> Result<(), String> {
    let mut ids = HashSet::new();
    for enhancer in enhancers {
        if !safe_name(&enhancer.id) || !ids.insert(enhancer.id.to_ascii_lowercase()) {
            return Err("备份增强项标识无效或重复".into());
        }
        let extension = match enhancer.kind.as_str() {
            "merge" => "yaml",
            "script" => "js",
            _ => return Err("备份增强项类型无效".into()),
        };
        if !snapshot
            .files
            .contains_key(&format!("profiles/{prefix}.{}.{extension}", enhancer.id))
        {
            return Err("备份缺少增强项内容".into());
        }
    }
    Ok(())
}

fn validate_snapshot(snapshot: &Snapshot) -> Result<(), String> {
    if snapshot.format != FORMAT || snapshot.schema_version != SCHEMA_VERSION {
        return Err("备份格式或版本不受支持（脱敏摘要不可恢复）".into());
    }
    validate_id(&snapshot.id)?;
    if snapshot.label.chars().count() > 80
        || snapshot.label.chars().any(char::is_control)
        || snapshot.app_version.len() > 40
        || snapshot.files.len() > MAX_FILES
    {
        return Err("备份元信息超出限制".into());
    }
    let mut size = 0usize;
    let mut names = HashSet::new();
    for (name, file) in &snapshot.files {
        if !allowed_path(name) || !names.insert(name.to_ascii_lowercase()) {
            return Err("备份包含不安全或重复的文件路径".into());
        }
        size = size.checked_add(file.content.len()).ok_or("备份大小溢出")?;
        if file.content.len() > MAX_FILE_BYTES || size > MAX_ARCHIVE_BYTES {
            return Err("备份内容超过大小限制".into());
        }
        if format!("{:x}", Sha256::digest(file.content.as_bytes())) != file.sha256 {
            return Err("备份内容 SHA-256 校验失败".into());
        }
        if name.ends_with(".yaml") || name.ends_with(".yml") {
            if !serde_yaml::from_str::<serde_yaml::Value>(&file.content)
                .map_err(|_| "备份包含无效 YAML")?
                .is_mapping()
            {
                return Err("备份 YAML 顶层必须为对象".into());
            }
        }
    }
    serde_json::from_str::<AppSettings>(
        &snapshot
            .files
            .get("settings.json")
            .ok_or("备份缺少应用设置")?
            .content,
    )
    .map_err(|_| "备份设置字段无效")?;
    let (profiles, global) = indexes(snapshot)?;
    let mut ids = HashSet::new();
    if profiles.iter().filter(|profile| profile.current).count() > 1 {
        return Err("备份包含多个当前订阅".into());
    }
    for profile in &profiles {
        if !safe_name(&profile.id)
            || profile.id == "__global__"
            || !ids.insert(profile.id.to_ascii_lowercase())
            || !matches!(profile.kind.as_str(), "remote" | "local")
        {
            return Err("备份订阅标识或类型无效".into());
        }
        if !snapshot
            .files
            .contains_key(&format!("profiles/{}.yaml", profile.id))
        {
            return Err("备份缺少订阅内容".into());
        }
        validate_enhancers(snapshot, &profile.id, &profile.enhancers)?;
    }
    validate_enhancers(snapshot, "__global__", &global)
}

fn decode_snapshot(content: &str) -> Result<Snapshot, String> {
    if content.len() > MAX_ARCHIVE_BYTES {
        return Err("备份文件超过 64 MiB 限制".into());
    }
    let snapshot: Snapshot =
        serde_json::from_str(content).map_err(|_| "备份 JSON 格式无效（脱敏摘要不可恢复）")?;
    validate_snapshot(&snapshot)?;
    Ok(snapshot)
}

fn encode_snapshot(snapshot: &Snapshot) -> Result<String, String> {
    let content = serde_json::to_string_pretty(snapshot).map_err(|_| "序列化备份失败")?;
    if content.len() > MAX_ARCHIVE_BYTES {
        return Err("备份文件超过 64 MiB 限制".into());
    }
    Ok(content)
}

fn backup_path(dirs: &Dirs, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    let path = checked_directory(&dirs.config, "backups")?.join(format!("{id}{EXTENSION}"));
    checked_file(&path, true)?;
    Ok(path)
}

fn load_snapshot(dirs: &Dirs, id: &str) -> Result<(Snapshot, usize), String> {
    let content = read_limited(&backup_path(dirs, id)?, MAX_ARCHIVE_BYTES)?;
    let snapshot = decode_snapshot(&content)?;
    if snapshot.id != id {
        return Err("备份文件名与内容标识不一致".into());
    }
    Ok((snapshot, content.len()))
}

fn save_snapshot(dirs: &Dirs, snapshot: &Snapshot) -> Result<BackupEntry, String> {
    let content = encode_snapshot(snapshot)?;
    let path = backup_path(dirs, &snapshot.id)?;
    if path.exists() {
        if read_limited(&path, MAX_ARCHIVE_BYTES)? != content {
            return Err("同名备份已存在且内容不同，未覆盖".into());
        }
    } else {
        atomic_write(&path, content.as_bytes()).map_err(|_| "保存备份失败")?;
    }
    Ok(snapshot_entry(snapshot, content.len()))
}

fn create(dirs: &Dirs, label: String) -> Result<BackupEntry, String> {
    let label = label.trim();
    let mut snapshot = Snapshot {
        format: FORMAT.into(),
        schema_version: SCHEMA_VERSION,
        id: new_id(),
        label: if label.is_empty() {
            "手动备份".into()
        } else {
            label.into()
        },
        created_at: now_millis(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        files: BTreeMap::new(),
    };
    let mut size = 0usize;
    for (name, path) in configuration_files(dirs)? {
        let content = read_limited(&path, MAX_FILE_BYTES)?;
        size += content.len();
        if size > MAX_ARCHIVE_BYTES {
            return Err("备份内容超过大小限制".into());
        }
        snapshot.files.insert(name, BackupFile::new(content));
    }
    snapshot
        .files
        .entry("profiles.json".into())
        .or_insert_with(|| BackupFile::new("[]".into()));
    validate_snapshot(&snapshot)?;
    save_snapshot(dirs, &snapshot)
}

fn list(dirs: &Dirs) -> Result<Vec<BackupEntry>, String> {
    let mut entries = Vec::new();
    for item in
        fs::read_dir(checked_directory(&dirs.config, "backups")?).map_err(|_| "读取备份目录失败")?
    {
        let item = item.map_err(|_| "读取备份目录项失败")?;
        let name = item.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(EXTENSION) else {
            continue;
        };
        if validate_id(id).is_err() {
            continue;
        }
        // 单个损坏文件不阻断其余历史，也不伪装为可恢复项。
        entries.push(match load_snapshot(dirs, id) {
            Ok((snapshot, size)) => snapshot_entry(&snapshot, size),
            Err(error) => BackupEntry {
                id: id.into(),
                label: "损坏的备份".into(),
                created_at: id
                    .split('-')
                    .nth(1)
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0),
                app_version: String::new(),
                size_bytes: fs::symlink_metadata(item.path())
                    .map(|meta| meta.len())
                    .unwrap_or(0),
                source: "local".into(),
                error: Some(error),
            },
        });
        if entries.len() > MAX_FILES {
            return Err("本地备份数量超过限制".into());
        }
    }
    entries.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(entries)
}

fn preview(dirs: &Dirs, id: &str) -> Result<BackupPreview, String> {
    let (snapshot, size) = load_snapshot(dirs, id)?;
    let (profiles, global) = indexes(&snapshot)?;
    Ok(BackupPreview {
        entry: snapshot_entry(&snapshot, size),
        profile_count: profiles.len(),
        enhancer_count: global.len() + profiles.iter().map(|p| p.enhancers.len()).sum::<usize>(),
        file_count: snapshot.files.len(),
        preserved_settings: PROTECTED_SETTINGS
            .iter()
            .map(|value| (*value).into())
            .chain(std::iter::once("tun*".into()))
            .collect(),
        warnings: vec![
            "恢复将替换订阅与全局增强；执行前自动创建本地备份。".into(),
            "保留本机系统代理、TUN、自启、快捷键、控制器凭据和监听端口；不启动已停止的内核。"
                .into(),
        ],
    })
}

fn export(dirs: &Dirs, id: &str, redacted: bool) -> Result<BackupExport, String> {
    let (snapshot, _) = load_snapshot(dirs, id)?;
    if !redacted {
        return Ok(BackupExport {
            filename: format!("{id}{EXTENSION}"),
            content: encode_snapshot(&snapshot)?,
        });
    }
    let (profiles, global) = indexes(&snapshot)?;
    // 任意 YAML/JS 可嵌入密码、URL 或用户路径；分享时只导出白名单统计，不猜测密钥名称。
    let summary = serde_json::json!({
        "format": "ClashNovaBackupReport", "schemaVersion": SCHEMA_VERSION, "redacted": true,
        "appVersion": env!("CARGO_PKG_VERSION"), "createdAt": snapshot.created_at,
        "profileCount": profiles.len(), "enhancerCount": global.len()
            + profiles.iter().map(|p| p.enhancers.len()).sum::<usize>(),
        "fileCount": snapshot.files.len(), "restorable": false,
    });
    Ok(BackupExport {
        filename: "ClashNova-backup-redacted.json".into(),
        content: serde_json::to_string_pretty(&summary).map_err(|_| "导出脱敏摘要失败")?,
    })
}

fn import(dirs: &Dirs, content: &str) -> Result<BackupEntry, String> {
    let mut snapshot = decode_snapshot(content)?;
    // 导入使用新的本地标识；外部文件永远不能覆盖现有历史。
    snapshot.id = new_id();
    save_snapshot(dirs, &snapshot)
}

struct RestorePlan {
    snapshot: Snapshot,
    settings: AppSettings,
    runtime: String,
}

fn prepare_restore(snapshot: Snapshot, current: &AppSettings) -> Result<RestorePlan, String> {
    validate_snapshot(&snapshot)?;
    let mut restored: serde_json::Value =
        serde_json::from_str(&snapshot.files["settings.json"].content)
            .map_err(|_| "备份设置格式无效")?;
    let current = serde_json::to_value(current).map_err(|_| "读取本机设置失败")?;
    let object = restored.as_object_mut().ok_or("备份设置格式无效")?;
    for (key, value) in current.as_object().ok_or("本机设置格式无效")? {
        if PROTECTED_SETTINGS.contains(&key.as_str()) || key.starts_with("tun") {
            object.insert(key.clone(), value.clone());
        }
    }
    let mut settings: AppSettings =
        serde_json::from_value(restored).map_err(|_| "备份设置字段无效")?;
    settings.migrate();
    let (profiles, global) = indexes(&snapshot)?;
    let runtime =
        crate::profiles::build_runtime_from_files(&settings, &profiles, &global, |name| {
            snapshot
                .files
                .get(&format!("profiles/{name}"))
                .map(|file| file.content.clone())
                .ok_or_else(|| "备份缺少运行配置引用的文件".into())
        })
        .map_err(|_| "备份运行配置生成失败，请检查订阅和增强项")?;
    Ok(RestorePlan {
        snapshot,
        settings,
        runtime,
    })
}

async fn apply_restore<Reload, Future>(
    dirs: &Dirs,
    settings: &RwLock<AppSettings>,
    plan: RestorePlan,
    running: bool,
    mut reload: Reload,
) -> Result<AppSettings, String>
where
    Reload: FnMut() -> Future,
    Future: std::future::Future<Output = Result<(), String>>,
{
    let before = settings.read().map_err(|_| "读取设置内存失败")?.clone();
    let mut paths = configuration_files(dirs)?;
    for name in plan.snapshot.files.keys() {
        let path = dirs.config.join(name);
        checked_file(&path, true)?;
        paths.insert(name.clone(), path);
    }
    checked_file(&dirs.runtime_config(), true)?;
    let mut targets: Vec<_> = paths.values().cloned().collect();
    targets.push(dirs.runtime_config());
    let mut transaction =
        FileTransaction::capture(&targets).map_err(|_| "保存恢复前文件快照失败")?;
    let mut reload_attempted = false;
    let result = async {
        for (name, path) in &paths {
            match plan.snapshot.files.get(name) {
                Some(_) if name == "settings.json" => {
                    let content = serde_json::to_vec_pretty(&plan.settings)
                        .map_err(|_| "序列化恢复设置失败")?;
                    transaction
                        .write(path, &content)
                        .map_err(|_| "恢复设置写入失败")?;
                }
                Some(file) => transaction
                    .write(path, file.content.as_bytes())
                    .map_err(|_| "恢复订阅写入失败")?,
                None => transaction
                    .remove(path.clone())
                    .map_err(|_| "移除旧订阅失败")?,
            }
        }
        transaction
            .write(&dirs.runtime_config(), plan.runtime.as_bytes())
            .map_err(|_| "恢复运行配置写入失败")?;
        *settings.write().map_err(|_| "更新设置内存失败")? = plan.settings.clone();
        if running {
            reload_attempted = true;
            reload().await.map_err(|_| "恢复后的运行配置加载失败")?;
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = result {
        let memory_restored = settings.write().map(|mut value| *value = before).is_ok();
        let files_restored = transaction.rollback().is_ok();
        let runtime_restored = !reload_attempted || !files_restored || reload().await.is_ok();
        return Err(if memory_restored && files_restored && runtime_restored {
            format!("{error}；已恢复原配置")
        } else {
            format!("{error}；原配置回滚未完全成功，请停止内核并检查本地备份")
        });
    }
    transaction.commit();
    Ok(plan.settings)
}

async fn local<R, F>(app: AppHandle, operation: F) -> Result<R, String>
where
    R: Send + 'static,
    F: FnOnce(&Dirs) -> Result<R, String> + Send + 'static,
{
    let state = app.state::<AppState>();
    let _configuration = state.config_lock.lock().await;
    let dirs = state.dirs.clone();
    tauri::async_runtime::spawn_blocking(move || operation(&dirs))
        .await
        .map_err(|_| "备份任务中断")?
}

#[tauri::command]
pub async fn backup_list(app: AppHandle) -> Result<Vec<BackupEntry>, String> {
    local(app, list).await
}

#[tauri::command]
pub async fn backup_create(app: AppHandle, label: String) -> Result<BackupEntry, String> {
    local(app, move |dirs| create(dirs, label)).await
}

#[tauri::command]
pub async fn backup_delete(app: AppHandle, id: String) -> Result<(), String> {
    local(app, move |dirs| {
        fs::remove_file(backup_path(dirs, &id)?).map_err(|_| "删除本地备份失败".into())
    })
    .await
}

#[tauri::command]
pub async fn backup_export(
    app: AppHandle,
    id: String,
    redacted: bool,
) -> Result<BackupExport, String> {
    local(app, move |dirs| export(dirs, &id, redacted)).await
}

#[tauri::command]
pub async fn backup_import(app: AppHandle, content: String) -> Result<BackupEntry, String> {
    local(app, move |dirs| import(dirs, &content)).await
}

#[tauri::command]
pub async fn backup_preview(app: AppHandle, id: String) -> Result<BackupPreview, String> {
    local(app, move |dirs| preview(dirs, &id)).await
}

#[tauri::command]
pub async fn backup_restore(app: AppHandle, id: String) -> Result<AppSettings, String> {
    let state = app.state::<AppState>();
    let _configuration = state.config_lock.lock().await;
    let worker = app.clone();
    let plan = tauri::async_runtime::spawn_blocking(move || {
        let state = worker.state::<AppState>();
        let (snapshot, _) = load_snapshot(&state.dirs, &id)?;
        let plan = prepare_restore(snapshot, &state.settings_snapshot())?;
        crate::core::validate_runtime(&worker, &plan.runtime)
            .map_err(|_| "备份运行配置原生预检失败，未替换现有配置")?;
        create(&state.dirs, "恢复前自动备份".into())?;
        Ok::<_, String>(plan)
    })
    .await
    .map_err(|_| "备份预检任务中断")??;
    let running = crate::core::status(&app).await.running;
    let restored = apply_restore(&state.dirs, &state.settings, plan, running, || {
        crate::core::reload_runtime(&app)
    })
    .await?;
    crate::tray::sync_tray(&app);
    let _ = app.emit("settings-changed", ());
    let _ = app.emit("profiles-changed", ());
    Ok(restored)
}

#[tauri::command]
pub async fn backup_webdav_get(app: AppHandle) -> Result<WebDavConfig, String> {
    local(app, webdav::get_config).await
}

#[tauri::command]
pub async fn backup_webdav_save(app: AppHandle, config: WebDavConfigInput) -> Result<(), String> {
    local(app, move |dirs| webdav::save_config(dirs, config)).await
}

#[tauri::command]
pub async fn backup_webdav_list(app: AppHandle) -> Result<Vec<BackupEntry>, String> {
    let client = local(app, webdav::Client::load).await?;
    client.list().await
}

#[tauri::command]
pub async fn backup_webdav_upload(app: AppHandle, id: String) -> Result<(), String> {
    let (client, content) = local(app, move |dirs| {
        let client = webdav::Client::load(dirs)?;
        let (snapshot, _) = load_snapshot(dirs, &id)?;
        Ok((client, snapshot))
    })
    .await?;
    client.upload(&content).await
}

#[tauri::command]
pub async fn backup_webdav_download(app: AppHandle, id: String) -> Result<BackupEntry, String> {
    let client = local(app.clone(), webdav::Client::load).await?;
    let snapshot = client.download(&id).await?;
    local(app, move |dirs| save_snapshot(dirs, &snapshot)).await
}

#[tauri::command]
pub async fn backup_webdav_delete(app: AppHandle, id: String) -> Result<(), String> {
    let client = local(app, webdav::Client::load).await?;
    client.delete(&id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    pub(super) struct Fixture {
        pub(super) dirs: Dirs,
        root: PathBuf,
        base: PathBuf,
    }

    impl Fixture {
        pub(super) fn new() -> Self {
            let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join(".tmp");
            fs::create_dir_all(&base).unwrap();
            let base = fs::canonicalize(base).unwrap();
            let root = base.join(format!(
                "backup-test-{}-{}",
                std::process::id(),
                random_hex16()
            ));
            let dirs = Dirs {
                config: root.join("config"),
                profiles: root.join("config/profiles"),
                logs: root.join("config/logs"),
            };
            fs::create_dir_all(&dirs.profiles).unwrap();
            fs::create_dir_all(&dirs.logs).unwrap();
            let settings = AppSettings {
                secret: "FIXTURE_CONTROLLER_ONLY".into(),
                ..AppSettings::default()
            };
            fs::write(dirs.settings_file(), serde_json::to_vec(&settings).unwrap()).unwrap();
            fs::write(dirs.profiles_index(), serde_json::to_vec(&serde_json::json!([{
                "id": "profile-fixture", "name": "fixture", "kind": "remote", "current": true,
                "url": "https://subscription.example.invalid/?token=FIXTURE_SUBSCRIPTION_ONLY", "updatedAt": 123,
                "enhancers": [{"id":"enhancer-fixture","kind":"script","name":"fixture script","enabled":true}]
            }])).unwrap()).unwrap();
            fs::write(
                dirs.profiles.join("profile-fixture.yaml"),
                "proxies: []\nproxy-groups: []\nrules: ['MATCH,DIRECT']\n",
            )
            .unwrap();
            fs::write(
                dirs.profiles.join("profile-fixture.enhancer-fixture.js"),
                "function main(config) { return config; }",
            )
            .unwrap();
            fs::write(
                dirs.profiles.join("global-enhancers.json"),
                r#"[{"id":"global-fixture","kind":"merge","name":"global","enabled":true}]"#,
            )
            .unwrap();
            fs::write(
                dirs.profiles.join("__global__.global-fixture.yaml"),
                "dns:\n  enable: true\n",
            )
            .unwrap();
            fs::write(dirs.runtime_config(), "fixture-old-runtime").unwrap();
            fs::write(dirs.logs.join("test.log"), "FIXTURE_LOG_ONLY").unwrap();
            fs::write(
                dirs.config.join("backup-webdav.json"),
                "FIXTURE_CREDENTIAL_ONLY",
            )
            .unwrap();
            fs::write(dirs.config.join("stats.db"), "FIXTURE_STATS_ONLY").unwrap();
            Self { dirs, root, base }
        }

        pub(super) fn snapshot(&self) -> Snapshot {
            let entry = create(&self.dirs, "FIXTURE_LABEL_ONLY".into()).unwrap();
            load_snapshot(&self.dirs, &entry.id).unwrap().0
        }

        fn current_settings(&self) -> AppSettings {
            serde_json::from_slice(&fs::read(self.dirs.settings_file()).unwrap()).unwrap()
        }

        fn live_files(&self) -> BTreeMap<String, Vec<u8>> {
            let mut files: BTreeMap<_, _> = configuration_files(&self.dirs)
                .unwrap()
                .into_iter()
                .map(|(name, path)| (name, fs::read(path).unwrap()))
                .collect();
            files.insert(
                "runtime.yaml".into(),
                fs::read(self.dirs.runtime_config()).unwrap(),
            );
            files
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Ok(root) = fs::canonicalize(&self.root) {
                if root.parent() == Some(self.base.as_path()) {
                    let _ = fs::remove_dir_all(root);
                }
            }
        }
    }

    #[test]
    fn full_snapshot_roundtrip_covers_profiles_and_global_enhancers_without_credentials_or_logs() {
        let fixture = Fixture::new();
        let snapshot = fixture.snapshot();
        assert_eq!(snapshot.files.len(), 6);
        assert!(snapshot
            .files
            .contains_key("profiles/global-enhancers.json"));
        assert!(snapshot
            .files
            .contains_key("profiles/__global__.global-fixture.yaml"));
        let encoded = encode_snapshot(&snapshot).unwrap();
        for secret in [
            "FIXTURE_LOG_ONLY",
            "FIXTURE_CREDENTIAL_ONLY",
            "FIXTURE_STATS_ONLY",
        ] {
            assert!(!encoded.contains(secret));
        }
        assert!(encoded.contains("FIXTURE_SUBSCRIPTION_ONLY"));
        let imported = import(&fixture.dirs, &encoded).unwrap();
        assert_ne!(imported.id, snapshot.id);
        let (copy, _) = load_snapshot(&fixture.dirs, &imported.id).unwrap();
        assert_eq!(
            serde_json::to_value(&copy.files).unwrap(),
            serde_json::to_value(&snapshot.files).unwrap()
        );
        assert_eq!(list(&fixture.dirs).unwrap().len(), 2);
        let preview = preview(&fixture.dirs, &snapshot.id).unwrap();
        assert_eq!((preview.profile_count, preview.enhancer_count), (1, 2));
    }

    #[test]
    fn redacted_export_is_non_restorable_and_contains_no_arbitrary_input() {
        let fixture = Fixture::new();
        let mut snapshot = fixture.snapshot();
        snapshot.app_version = "FIXTURE_VERSION_ONLY".into();
        let content = encode_snapshot(&snapshot).unwrap();
        fs::write(backup_path(&fixture.dirs, &snapshot.id).unwrap(), content).unwrap();
        let redacted = export(&fixture.dirs, &snapshot.id, true).unwrap();
        for value in [
            "FIXTURE_",
            "https://",
            "profile-fixture",
            "function main",
            "secret",
            "password",
        ] {
            assert!(!redacted.content.contains(value));
        }
        assert!(decode_snapshot(&redacted.content).is_err());
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&redacted.content).unwrap()["restorable"],
            false
        );
    }

    #[test]
    fn damaged_history_does_not_hide_healthy_backups() {
        let fixture = Fixture::new();
        let snapshot = fixture.snapshot();
        fs::write(
            backup_path(&fixture.dirs, &new_id()).unwrap(),
            "broken-json",
        )
        .unwrap();
        let entries = list(&fixture.dirs).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|entry| entry.id == snapshot.id));
    }

    #[test]
    fn rejects_traversal_reserved_names_case_aliases_invalid_hash_and_missing_files() {
        for name in [
            "../settings.json",
            "profiles/../settings.json",
            "profiles/C:\\test.yaml",
            "profiles/a/b.yaml",
            "profiles/a:secret.yaml",
            "profiles/CON.yaml",
            "profiles/LPT1.js",
            "profiles/.hidden.yaml",
            "profiles/a.yaml.",
            "logs/test.yaml",
            "runtime.yaml",
            "backup-webdav.json",
            "profiles/%2e%2e.yaml",
        ] {
            assert!(!allowed_path(name), "accepted unsafe path");
        }
        for id in [
            "../x",
            "backup-1-1234567890123456:secret",
            "backup-1-1234567890123456/child",
            "backup--1234567890123456",
        ] {
            assert!(validate_id(id).is_err());
        }
        let fixture = Fixture::new();
        let original = fixture.snapshot();
        let mut snapshot = original.clone();
        snapshot
            .files
            .get_mut("settings.json")
            .unwrap()
            .content
            .push(' ');
        assert!(validate_snapshot(&snapshot)
            .unwrap_err()
            .contains("SHA-256"));
        let mut snapshot = original.clone();
        snapshot.files.insert(
            "profiles/PROFILE-fixture.yaml".into(),
            snapshot.files["profiles/profile-fixture.yaml"].clone(),
        );
        assert!(validate_snapshot(&snapshot).is_err());
        let mut snapshot = original.clone();
        snapshot
            .files
            .remove("profiles/__global__.global-fixture.yaml");
        assert!(validate_snapshot(&snapshot).is_err());
        let mut snapshot = original;
        snapshot.schema_version += 1;
        assert!(validate_snapshot(&snapshot).is_err());
    }

    #[test]
    fn refuses_oversize_content_and_inconsistent_backup_identity() {
        let fixture = Fixture::new();
        let mut snapshot = fixture.snapshot();
        snapshot.files.insert(
            "profiles/oversize.js".into(),
            BackupFile::new(" ".repeat(MAX_FILE_BYTES + 1)),
        );
        assert!(validate_snapshot(&snapshot).unwrap_err().contains("大小"));
        let snapshot = fixture.snapshot();
        let path = backup_path(&fixture.dirs, &snapshot.id).unwrap();
        let mut changed = snapshot.clone();
        changed.id = new_id();
        fs::write(&path, encode_snapshot(&changed).unwrap()).unwrap();
        assert!(load_snapshot(&fixture.dirs, &snapshot.id).is_err());
        assert!(save_snapshot(&fixture.dirs, &snapshot).is_err());
    }

    #[tokio::test]
    async fn restore_keeps_local_connection_settings_and_never_starts_a_stopped_core() {
        let fixture = Fixture::new();
        let snapshot = fixture.snapshot();
        let mut current = fixture.current_settings();
        current.theme = "light".into();
        current.secret = "FIXTURE_LOCAL_ONLY".into();
        current.mixed_port = 17897;
        current.external_controller = "127.0.0.1:19097".into();
        current.tun = true;
        current.sys_proxy = true;
        current.autostart = true;
        current
            .hotkeys
            .insert("toggle-window".into(), "Ctrl+Alt+K".into());
        let memory = RwLock::new(current.clone());
        let plan = prepare_restore(snapshot, &current).unwrap();
        assert_eq!(plan.settings.secret, current.secret);
        assert_eq!(plan.settings.mixed_port, current.mixed_port);
        assert_eq!(plan.settings.hotkeys, current.hotkeys);
        assert!(plan.settings.tun && plan.settings.sys_proxy && plan.settings.autostart);
        assert_eq!(plan.settings.theme, "dark");
        fs::write(fixture.dirs.profiles.join("orphan.yaml"), "proxies: []").unwrap();
        let restored = apply_restore(&fixture.dirs, &memory, plan, false, || async {
            panic!("stopped core must not be reloaded or started");
            #[allow(unreachable_code)]
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(*memory.read().unwrap(), restored);
        assert_eq!(fixture.current_settings(), restored);
        assert!(!fixture.dirs.profiles.join("orphan.yaml").exists());
        assert_eq!(
            fs::read_to_string(fixture.dirs.config.join("backup-webdav.json")).unwrap(),
            "FIXTURE_CREDENTIAL_ONLY"
        );
    }

    #[tokio::test]
    async fn failed_live_reload_restores_all_file_bytes_memory_and_previous_runtime() {
        let fixture = Fixture::new();
        let snapshot = fixture.snapshot();
        fs::write(
            fixture.dirs.profiles.join("profile-fixture.yaml"),
            "proxies: []\nmode: direct\n",
        )
        .unwrap();
        fs::write(
            fixture.dirs.profiles.join("after-backup.yaml"),
            "proxies: []",
        )
        .unwrap();
        let mut current = fixture.current_settings();
        current.theme = "light".into();
        fs::write(
            fixture.dirs.settings_file(),
            serde_json::to_vec(&current).unwrap(),
        )
        .unwrap();
        let before = fixture.live_files();
        let memory = RwLock::new(current.clone());
        let calls = AtomicUsize::new(0);
        let plan = prepare_restore(snapshot, &current).unwrap();
        let result = apply_restore(&fixture.dirs, &memory, plan, true, || {
            let first = calls.fetch_add(1, Ordering::SeqCst) == 0;
            std::future::ready(if first {
                Err("FIXTURE_PRIVATE_ERROR".into())
            } else {
                Ok(())
            })
        })
        .await;
        let error = result.unwrap_err();
        assert!(error.contains("已恢复原配置"));
        assert!(!error.contains("FIXTURE_PRIVATE_ERROR"));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(fixture.live_files(), before);
        assert_eq!(*memory.read().unwrap(), current);
    }

    #[test]
    fn broken_enhancement_is_rejected_before_touching_live_files() {
        let fixture = Fixture::new();
        let mut snapshot = fixture.snapshot();
        snapshot.files.insert(
            "profiles/profile-fixture.enhancer-fixture.js".into(),
            BackupFile::new(
                "function main(config) { throw new Error('FIXTURE_PRIVATE_SCRIPT'); }".into(),
            ),
        );
        let before = fixture.live_files();
        let error = prepare_restore(snapshot, &fixture.current_settings())
            .err()
            .unwrap();
        assert!(!error.contains("FIXTURE_PRIVATE_SCRIPT"));
        assert_eq!(fixture.live_files(), before);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn failed_final_file_replace_rolls_back_already_written_profiles() {
        let fixture = Fixture::new();
        let snapshot = fixture.snapshot();
        fs::write(
            fixture.dirs.profiles.join("profile-fixture.yaml"),
            "proxies: []\nmode: direct\n",
        )
        .unwrap();
        let current = fixture.current_settings();
        let before = fixture.live_files();
        let runtime = fixture.dirs.runtime_config();
        let old_permissions = fs::metadata(&runtime).unwrap().permissions();
        let mut readonly = old_permissions.clone();
        readonly.set_readonly(true);
        fs::set_permissions(&runtime, readonly).unwrap();
        let memory = RwLock::new(current.clone());
        let result = apply_restore(
            &fixture.dirs,
            &memory,
            prepare_restore(snapshot, &current).unwrap(),
            false,
            || std::future::ready(Ok(())),
        )
        .await;
        fs::set_permissions(runtime, old_permissions).unwrap();
        assert!(result.is_err());
        assert_eq!(fixture.live_files(), before);
        assert_eq!(*memory.read().unwrap(), current);
    }

    #[cfg(windows)]
    #[test]
    fn refuses_directory_junctions_without_reading_external_content() {
        use std::os::windows::process::CommandExt;
        let fixture = Fixture::new();
        let target = fixture.root.join("external");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("fixture.yaml"), "FIXTURE_EXTERNAL_ONLY").unwrap();
        let link = fixture.dirs.config.join("backups");
        let output = std::process::Command::new("cmd.exe")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "creating isolated junction fixture failed"
        );
        assert!(checked_directory(&fixture.dirs.config, "backups").is_err());
        assert_eq!(
            fs::read_to_string(target.join("fixture.yaml")).unwrap(),
            "FIXTURE_EXTERNAL_ONLY"
        );
        fs::remove_dir(&link).unwrap();
    }
}
