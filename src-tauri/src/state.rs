//! 应用全局状态:设置镜像(契约 A)、目录布局、内核句柄容器。

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
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
}

fn default_language() -> String {
    "zh".into()
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
        Ok(Self { config, profiles, logs })
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
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content).map_err(|e| format!("写入 {} 失败: {e}", tmp.display()))?;
    // Windows 上 rename 到已存在目标会失败, 先移除旧文件
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("替换 {} 失败: {e}", path.display()))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("落盘 {} 失败: {e}", path.display()))
}

/// Tauri 全局托管状态。
pub struct AppState {
    pub settings: RwLock<AppSettings>,
    pub core: Mutex<CoreHandle>,
    pub dirs: Dirs,
    /// 守卫任务世代号:递增即令旧守卫循环自然退出。
    pub guard_gen: AtomicU64,
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
        })
    }

    /// 读取设置快照(克隆, 避免持锁跨 await)。
    pub fn settings_snapshot(&self) -> AppSettings {
        self.settings
            .read()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    /// 持久化设置到 settings.json。
    pub fn persist_settings(&self, settings: &AppSettings) -> Result<(), String> {
        let json = serde_json::to_string_pretty(settings)
            .map_err(|e| format!("序列化设置失败: {e}"))?;
        atomic_write(&self.dirs.settings_file(), json.as_bytes())
    }
}

/// 首启写默认 settings.json;已有则读取(损坏时回退默认并重写)。
fn load_or_init_settings(dirs: &Dirs) -> Result<AppSettings, String> {
    let path = dirs.settings_file();
    if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| format!("读取设置失败: {e}"))?;
        match serde_json::from_str::<AppSettings>(&raw) {
            Ok(s) => return Ok(s),
            Err(e) => log::warn!("settings.json 解析失败({e}), 回退默认设置"),
        }
    }
    let settings = AppSettings::default();
    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("序列化默认设置失败: {e}"))?;
    atomic_write(&path, json.as_bytes())?;
    Ok(settings)
}
