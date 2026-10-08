//! 应用全局状态:设置镜像(契约 A)、目录布局、内核句柄容器。

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::core::CoreHandle;

/// `AppSettings` 的 Rust 镜像(锁定契约 A, 字段经 camelCase 序列化后与
/// `src/types/clash.ts` 完全一致, 不得擅改)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub sys_proxy: bool,
    pub guard: bool,
    pub guard_interval_sec: u64,
    pub bypass: String,
    pub tun: bool,
    pub autostart: bool,
    pub silent_start: bool,
    pub mixed_port: u16,
    pub external_controller: String,
    pub secret: String,
    pub allow_lan: bool,
    pub ipv6: bool,
    pub log_level: String,
    pub mode: String,
    pub theme: String,
    /* ---- M2(serde default 兼容旧 settings.json) ---- */
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default)]
    pub custom_css: String,
    #[serde(default)]
    pub dns_override: String,
    #[serde(default)]
    pub hosts: String,
    #[serde(default)]
    pub hotkeys: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub stats_retention_days: u32,
    /* ---- DNS 高级配置 ---- */
    #[serde(default = "default_true")]
    pub enable_dns: bool,
    #[serde(default = "default_dns_listen")]
    pub dns_listen: String,
    #[serde(default = "default_dns_enhanced_mode")]
    pub dns_enhanced_mode: String,
    #[serde(default = "default_fake_ip_range")]
    pub fake_ip_range: String,
    #[serde(default = "default_fake_ip_filter_mode")]
    pub fake_ip_filter_mode: String,
    #[serde(default)]
    pub ipv6_dns: bool,
    #[serde(default)]
    pub prefer_h3: bool,
    #[serde(default)]
    pub respect_rules: bool,
    #[serde(default)]
    pub use_hosts: bool,
    #[serde(default)]
    pub use_system_hosts: bool,
}

fn default_language() -> String {
    "zh".into()
}
fn default_true() -> bool {
    true
}
fn default_dns_listen() -> String {
    "127.0.0.1:5335".into()
}
fn default_dns_enhanced_mode() -> String {
    "fake-ip".into()
}
fn default_fake_ip_range() -> String {
    "198.18.0.1/16".into()
}
fn default_fake_ip_filter_mode() -> String {
    "blacklist".into()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            sys_proxy: false,
            guard: false,
            guard_interval_sec: 30,
            bypass: "localhost;127.*;192.168.*;10.*;172.16.*;<local>".into(),
            tun: false,
            autostart: false,
            silent_start: false,
            mixed_port: 7897,
            external_controller: "127.0.0.1:9097".into(),
            secret: random_hex16(),
            allow_lan: false,
            ipv6: false,
            log_level: "info".into(),
            mode: "rule".into(),
            theme: "dark".into(),
            language: default_language(),
            custom_css: String::new(),
            dns_override: String::new(),
            hosts: String::new(),
            hotkeys: std::collections::HashMap::new(),
            stats_retention_days: 0,
            enable_dns: true,
            dns_listen: default_dns_listen(),
            dns_enhanced_mode: default_dns_enhanced_mode(),
            fake_ip_range: default_fake_ip_range(),
            fake_ip_filter_mode: default_fake_ip_filter_mode(),
            ipv6_dns: false,
            prefer_h3: false,
            respect_rules: false,
            use_hosts: false,
            use_system_hosts: false,
        }
    }
}

impl AppSettings {
    /// 转成 nova-core 的运行时覆写项。
    pub fn to_overrides(&self) -> nova_core::RuntimeOverrides {
        nova_core::RuntimeOverrides {
            mixed_port: self.mixed_port,
            external_controller: self.external_controller.clone(),
            secret: self.secret.clone(),
            mode: self.mode.clone(),
            allow_lan: self.allow_lan,
            ipv6: self.ipv6,
            log_level: if self.log_level == "silent" {
                "silent".into()
            } else {
                self.log_level.clone()
            },
            tun_enable: self.tun,
            dns_override: self.dns_override.clone(),
            hosts: self.hosts.clone(),
            enable_dns: self.enable_dns,
            dns_listen: self.dns_listen.clone(),
            dns_enhanced_mode: self.dns_enhanced_mode.clone(),
            fake_ip_range: self.fake_ip_range.clone(),
            fake_ip_filter_mode: self.fake_ip_filter_mode.clone(),
            ipv6_dns: self.ipv6_dns,
            prefer_h3: self.prefer_h3,
            respect_rules: self.respect_rules,
            use_hosts: self.use_hosts,
            use_system_hosts: self.use_system_hosts,
        }
    }
}

/// 无 rand 依赖的 16 位 hex 随机串(基于 RandomState 的随机哈希键 + 时钟熵)。
pub fn random_hex16() -> String {
    use std::hash::{BuildHasher, Hasher};
    let state = std::collections::hash_map::RandomState::new();
    let mut hasher = state.build_hasher();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    hasher.write_u128(nanos);
    hasher.write_u32(std::process::id());
    format!("{:016x}", hasher.finish())
}

/// 当前 Unix 毫秒时间戳。
pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 配置目录布局:`%APPDATA%/ClashNova`(经 `dirs::config_dir()` 解析)。
#[derive(Debug, Clone)]
pub struct Dirs {
    /// 根配置目录: settings.json / profiles.json / runtime.yaml 所在。
    pub config: PathBuf,
    /// 订阅文件目录: profiles/{id}.yaml。
    pub profiles: PathBuf,
    /// 日志目录: logs/mihomo.log 等。
    pub logs: PathBuf,
}

impl Dirs {
    pub fn resolve() -> Result<Self, String> {
        let config = dirs::config_dir()
            .ok_or_else(|| "无法定位系统配置目录".to_string())?
            .join("ClashNova");
        let profiles = config.join("profiles");
        let logs = config.join("logs");
        for dir in [&config, &profiles, &logs] {
            fs::create_dir_all(dir).map_err(|e| format!("创建目录 {} 失败: {e}", dir.display()))?;
        }
        Ok(Self {
            config,
            profiles,
            logs,
        })
    }

    pub fn settings_file(&self) -> PathBuf {
        self.config.join("settings.json")
    }

    pub fn profiles_index(&self) -> PathBuf {
        self.config.join("profiles.json")
    }

    pub fn profile_file(&self, id: &str) -> PathBuf {
        self.profiles.join(format!("{id}.yaml"))
    }

    pub fn runtime_config(&self) -> PathBuf {
        self.config.join("runtime.yaml")
    }

    pub fn core_log_file(&self) -> PathBuf {
        self.logs.join("mihomo.log")
    }
}

/// 原子写盘:先写 `.tmp` 再 rename, 避免半截文件。
pub fn atomic_write(path: &PathBuf, content: &[u8]) -> Result<(), String> {
    static WRITE_ID: AtomicU64 = AtomicU64::new(0);
    let name = path
        .file_name()
        .ok_or("写入目标没有文件名")?
        .to_string_lossy();
    let tmp = path.with_file_name(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        WRITE_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| format!("创建写入临时文件失败: {e}"))?;
    let result = (|| {
        file.write_all(content)
            .map_err(|e| format!("写入失败: {e}"))?;
        file.sync_all().map_err(|e| format!("同步写入失败: {e}"))?;
        drop(file);
        // Windows 的 std::fs::rename 使用可替换目标的 MoveFileExW, 不先删除旧文件。
        fs::rename(&tmp, path).map_err(|e| format!("落盘 {} 失败: {e}", path.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// 多文件配置更新的 last-good 快照; 写入或重载失败时恢复原文件。
pub struct FileTransaction {
    before: Vec<(PathBuf, Option<Vec<u8>>)>,
    finished: bool,
}

impl FileTransaction {
    pub fn capture(paths: &[PathBuf]) -> Result<Self, String> {
        let mut transaction = Self {
            before: Vec::new(),
            finished: false,
        };
        for path in paths {
            transaction.track(path)?;
        }
        Ok(transaction)
    }

    fn track(&mut self, path: &PathBuf) -> Result<(), String> {
        if self.before.iter().any(|(existing, _)| existing == path) {
            return Ok(());
        }
        let content = match fs::read(path) {
            Ok(content) => Some(content),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => return Err(format!("保存配置快照失败: {err}")),
        };
        self.before.push((path.clone(), content));
        Ok(())
    }

    pub fn write(&mut self, path: &PathBuf, content: &[u8]) -> Result<(), String> {
        self.track(path)?;
        atomic_write(path, content)
    }

    pub fn remove(&mut self, path: PathBuf) -> Result<(), String> {
        self.track(&path)?;
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("删除配置文件失败: {err}")),
        }
    }

    pub fn commit(&mut self) {
        self.finished = true;
    }

    pub fn changed(&self, path: &PathBuf) -> bool {
        self.before
            .iter()
            .find(|(existing, _)| existing == path)
            .is_some_and(|(_, before)| fs::read(path).ok() != *before)
    }

    pub fn rollback(&mut self) -> Result<(), String> {
        let mut errors = Vec::new();
        for (path, content) in self.before.iter().rev() {
            if fs::read(path).ok() == *content {
                continue;
            }
            let result = match content {
                Some(content) => atomic_write(path, content),
                None => match fs::remove_file(path) {
                    Ok(()) => Ok(()),
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(err) => Err(err.to_string()),
                },
            };
            if let Err(err) = result {
                errors.push(err);
            }
        }
        self.finished = errors.is_empty();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

impl Drop for FileTransaction {
    fn drop(&mut self) {
        if !self.finished {
            if let Err(err) = self.rollback() {
                log::error!("恢复配置快照失败: {err}");
            }
        }
    }
}

/// Tauri 全局托管状态。
pub struct AppState {
    pub settings: RwLock<AppSettings>,
    pub core: Mutex<CoreHandle>,
    pub dirs: Dirs,
    /// 守卫任务世代号:递增即令旧守卫循环自然退出。
    pub guard_gen: AtomicU64,
    /// 设置和订阅的多文件更新共享串行化边界。
    pub config_lock: tokio::sync::Mutex<()>,
    pub stats: Mutex<crate::stats::Accumulator>,
}

impl AppState {
    /// 解析目录并恢复(或首启初始化)settings.json。
    pub fn init() -> Result<Self, String> {
        let dirs = Dirs::resolve()?;
        let settings = load_or_init_settings(&dirs)?;
        Ok(Self {
            settings: RwLock::new(settings),
            core: Mutex::new(CoreHandle::default()),
            dirs,
            guard_gen: AtomicU64::new(0),
            config_lock: tokio::sync::Mutex::new(()),
            stats: Mutex::new(crate::stats::Accumulator::default()),
        })
    }

    /// 读取设置快照(克隆, 避免持锁跨 await)。
    pub fn settings_snapshot(&self) -> AppSettings {
        self.settings.read().map(|g| g.clone()).unwrap_or_default()
    }

    /// 持久化设置到 settings.json。
    pub fn persist_settings(&self, settings: &AppSettings) -> Result<(), String> {
        let json =
            serde_json::to_string_pretty(settings).map_err(|e| format!("序列化设置失败: {e}"))?;
        atomic_write(&self.dirs.settings_file(), json.as_bytes())
    }
}

/// 首启写默认 settings.json; 已有设置损坏时保留原文件并报错。
fn load_or_init_settings(dirs: &Dirs) -> Result<AppSettings, String> {
    let path = dirs.settings_file();
    if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| format!("读取设置失败: {e}"))?;
        return serde_json::from_str::<AppSettings>(&raw)
            .map_err(|e| format!("settings.json 解析失败，已保留原文件: {e}"));
    }
    let settings = AppSettings::default();
    let json =
        serde_json::to_string_pretty(&settings).map_err(|e| format!("序列化默认设置失败: {e}"))?;
    atomic_write(&path, json.as_bytes())?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        dirs: Dirs,
        base: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join(".tmp");
            fs::create_dir_all(&base).unwrap();
            let base = fs::canonicalize(base).unwrap();
            let config = base.join(format!(
                "state-test-{}-{}",
                std::process::id(),
                random_hex16()
            ));
            fs::create_dir(&config).unwrap();
            Self {
                dirs: Dirs {
                    profiles: config.join("profiles"),
                    logs: config.join("logs"),
                    config,
                },
                base,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Ok(target) = fs::canonicalize(&self.dirs.config) {
                if target.parent() == Some(self.base.as_path()) {
                    let _ = fs::remove_dir_all(target);
                }
            }
        }
    }

    #[test]
    fn atomic_write_replaces_the_file_without_leaving_temporary_files() {
        let fixture = Fixture::new();
        let path = fixture.dirs.settings_file();
        atomic_write(&path, b"before").unwrap();
        atomic_write(&path, b"after").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"after");
        assert_eq!(fs::read_dir(&fixture.dirs.config).unwrap().count(), 1);
    }

    #[test]
    fn failed_replacement_keeps_the_existing_target() {
        let fixture = Fixture::new();
        let target = fixture.dirs.settings_file();
        fs::create_dir(&target).unwrap();
        assert!(atomic_write(&target, b"new content").is_err());
        assert!(target.is_dir());
        assert_eq!(fs::read_dir(&fixture.dirs.config).unwrap().count(), 1);
    }

    #[test]
    fn transaction_restores_changed_deleted_and_new_files() {
        let fixture = Fixture::new();
        let a = fixture.dirs.config.join("a");
        let b = fixture.dirs.config.join("b");
        let c = fixture.dirs.config.join("c");
        atomic_write(&a, b"old a").unwrap();
        atomic_write(&b, b"old b").unwrap();
        let mut transaction = FileTransaction::capture(&[a.clone(), b.clone()]).unwrap();
        transaction.write(&a, b"new a").unwrap();
        transaction.remove(b.clone()).unwrap();
        transaction.write(&c, b"new c").unwrap();
        assert!(transaction.changed(&a));
        transaction.rollback().unwrap();
        assert_eq!(fs::read(&a).unwrap(), b"old a");
        assert_eq!(fs::read(&b).unwrap(), b"old b");
        assert!(!c.exists());
    }

    #[test]
    fn dropped_transaction_rolls_back_but_commit_keeps_changes() {
        let fixture = Fixture::new();
        let path = fixture.dirs.settings_file();
        atomic_write(&path, b"original").unwrap();
        {
            let mut transaction = FileTransaction::capture(&[path.clone()]).unwrap();
            transaction.write(&path, b"uncommitted").unwrap();
        }
        assert_eq!(fs::read(&path).unwrap(), b"original");
        {
            let mut transaction = FileTransaction::capture(&[path.clone()]).unwrap();
            transaction.write(&path, b"committed").unwrap();
            transaction.commit();
        }
        assert_eq!(fs::read(&path).unwrap(), b"committed");
    }

    #[test]
    fn corrupt_settings_are_not_overwritten_by_defaults() {
        let fixture = Fixture::new();
        let path = fixture.dirs.settings_file();
        atomic_write(&path, b"{invalid").unwrap();
        assert!(load_or_init_settings(&fixture.dirs).is_err());
        assert_eq!(fs::read(path).unwrap(), b"{invalid");
    }
}
