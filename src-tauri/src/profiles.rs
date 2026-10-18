//! 订阅 Profile 管理:下载/解析/落盘/索引/运行时配置生成。

use std::fs;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::{atomic_write, now_millis, AppSettings, AppState, FileTransaction};

#[path = "profile_options.rs"]
mod options;
#[path = "profile_topology.rs"]
mod topology;
pub use options::{resolve_import_url, DownloadProxy, ImportSource, ProfileDownloadOptions};
pub use topology::ProfileTopology;

const GLOBAL_ENHANCER_ID: &str = "__global__";
const MAX_SUBSCRIPTION_BYTES: usize = 16 * 1024 * 1024;
const BUILTIN_PRUNE_ENHANCER_ID: &str = "builtin-prune-invalid-nodes";
const BUILTIN_PRUNE_ENHANCER_NAME: &str = "内置：去除无效节点";
const BUILTIN_PRUNE_SCRIPT: &str = r#"// 去除名称里明显不是节点的项目，并同步清理策略组和订阅提供者引用。
function main(config) {
  const invalidNodeFilterBody = '过期|到期|失效|剩余|流量|官网|套餐|订阅(?:[：:]|地址|链接|更新)|网址|重置|用量|群组|频道|traffic|expire|subscription(?:[：:]|[ ]+(?:info|url|link|expire))|remaining|reset|used|total';
  const invalidNodeFilter = '(?i)(' + invalidNodeFilterBody + ')';
  const badName = new RegExp(invalidNodeFilterBody, 'i');
  const removed = {};
  const applyExcludeFilter = function(target) {
    if (!target || typeof target !== 'object') return;
    const current = String(target['exclude-filter'] || '').trim();
    if (!current) {
      target['exclude-filter'] = invalidNodeFilter;
    } else if (!/剩余|流量|remaining|traffic|expire/i.test(current)) {
      target['exclude-filter'] = '(?i)(?:' + current.replace(/^\(\?i\)/, '') + '|' + invalidNodeFilterBody + ')';
    }
  };

  config.proxies = (config.proxies || []).filter(function(proxy) {
    const name = String((proxy && proxy.name) || '');
    const drop = badName.test(name);
    if (drop) removed[name] = true;
    return !drop;
  });

  for (const provider of Object.values(config['proxy-providers'] || {})) {
    applyExcludeFilter(provider);
  }

  for (const group of config['proxy-groups'] || []) {
    if (group && group.use) applyExcludeFilter(group);
    if (Array.isArray(group.proxies)) {
      group.proxies = group.proxies.filter(function(name) {
        const text = String(name || '');
        return !removed[text] && !badName.test(text);
      });
    }
  }
  return config;
}
"#;

/// 契约 A 的 `ProfileMeta` 镜像。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileMeta {
    pub id: String,
    pub name: String,
    /// "remote" | "local"
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_update_min: Option<u32>,
    #[serde(default)]
    pub download_options: ProfileDownloadOptions,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota: Option<ProfileQuota>,
    pub current: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub builtin_enhancers_seeded: bool,
    /// Merge/Script 配置增强链(M2),按序应用。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub enhancers: Vec<EnhancerMeta>,
}

/// 单个增强项元数据;内容存 profiles/{pid}.{eid}.{yaml|js}。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhancerMeta {
    pub id: String,
    /// "merge" | "script"
    pub kind: String,
    pub name: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileQuota {
    pub used: u64,
    pub total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expire_at: Option<u64>,
}

fn builtin_prune_enhancer() -> EnhancerMeta {
    EnhancerMeta {
        id: BUILTIN_PRUNE_ENHANCER_ID.into(),
        kind: "script".into(),
        name: BUILTIN_PRUNE_ENHANCER_NAME.into(),
        enabled: false,
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// 只升级原封未改的旧内置脚本，不覆盖用户编辑或改变其启用状态。
fn should_upgrade_builtin_prune_script(content: &str) -> bool {
    let previous = BUILTIN_PRUNE_SCRIPT
        .replace("订阅(?:[：:]|地址|链接|更新)", "订阅")
        .replace("subscription(?:[：:]|[ ]+(?:info|url|link|expire))", "subscription");
    content.replace("\r\n", "\n") == previous.replace("\r\n", "\n")
}

fn ensure_builtin_prune_enhancers(
    app: &AppHandle,
    index: &mut [ProfileMeta],
    transaction: &mut FileTransaction,
) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let builtin = builtin_prune_enhancer();
    let mut changed = false;

    for profile in index.iter_mut() {
        if !profile.builtin_enhancers_seeded {
            if !profile
                .enhancers
                .iter()
                .any(|e| e.id == BUILTIN_PRUNE_ENHANCER_ID)
            {
                profile.enhancers.insert(0, builtin.clone());
            }
            profile.builtin_enhancers_seeded = true;
            changed = true;
        }

        if profile
            .enhancers
            .iter()
            .any(|e| e.id == BUILTIN_PRUNE_ENHANCER_ID)
        {
            let path = enhancer_file(&state, &profile.id, &builtin);
            if !path.exists()
                || fs::read_to_string(&path)
                    .is_ok_and(|content| should_upgrade_builtin_prune_script(&content))
            {
                transaction.write(&path, BUILTIN_PRUNE_SCRIPT.as_bytes())?;
            }
        }
    }

    Ok(changed)
}

/// 读取 profiles.json 索引(缺失时返回空表)。
pub fn load_index(app: &AppHandle) -> Result<Vec<ProfileMeta>, String> {
    let state = app.state::<AppState>();
    let path = state.dirs.profiles_index();
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("读取订阅索引失败: {err}")),
    };
    serde_json::from_str(&raw).map_err(|err| format!("订阅索引损坏，保留原文件: {err}"))
}

/// 迁移仅在启动时执行, 普通读取不修改磁盘上的索引。
pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut transaction = FileTransaction::capture(&[state.dirs.profiles_index()])?;
    let mut index = load_index(app)?;
    if ensure_builtin_prune_enhancers(app, &mut index, &mut transaction)? {
        save_index(app, &index)?;
    }
    transaction.commit();
    Ok(())
}

async fn finish_transaction<T>(
    app: &AppHandle,
    transaction: &mut FileTransaction,
    result: Result<T, String>,
) -> Result<T, String> {
    match result {
        Ok(value) => {
            transaction.commit();
            let _ = app.emit("profiles-changed", ());
            Ok(value)
        }
        Err(err) => {
            let runtime_changed =
                transaction.changed(&app.state::<AppState>().dirs.runtime_config());
            transaction
                .rollback()
                .map_err(|rollback| format!("{err}; 配置恢复失败: {rollback}"))?;
            if runtime_changed {
                if let Err(reload) = crate::core::reload_runtime(app).await {
                    return Err(format!(
                        "{err}; 原配置已恢复到磁盘，但运行态恢复失败: {reload}"
                    ));
                }
            }
            Err(err)
        }
    }
}

fn save_index(app: &AppHandle, index: &[ProfileMeta]) -> Result<(), String> {
    let state = app.state::<AppState>();
    let json = serde_json::to_string_pretty(index).map_err(|e| format!("序列化索引失败: {e}"))?;
    atomic_write(&state.dirs.profiles_index(), json.as_bytes())
}

/// 解析 `subscription-userinfo` 响应头: upload=..; download=..; total=..; expire=..
fn parse_userinfo(header: &str) -> Option<ProfileQuota> {
    let mut upload = 0u64;
    let mut download = 0u64;
    let mut total = 0u64;
    let mut expire = None;
    for pair in header.split(';') {
        let mut kv = pair.trim().splitn(2, '=');
        let (Some(k), Some(v)) = (kv.next(), kv.next()) else {
            continue;
        };
        let v = v.trim().parse::<u64>().unwrap_or(0);
        match k.trim() {
            "upload" => upload = v,
            "download" => download = v,
            "total" => total = v,
            "expire" if v > 0 => expire = Some(v.saturating_mul(1000)), // 秒 → 毫秒
            _ => {}
        }
    }
    if total == 0 {
        return None;
    }
    Some(ProfileQuota {
        used: upload.saturating_add(download),
        total,
        expire_at: expire,
    })
}

/// 从 Content-Disposition 提取 filename。
fn parse_filename(header: &str) -> Option<String> {
    for part in header.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix("filename*=UTF-8''") {
            if let Ok(decoded) = urlencoding_decode(rest) {
                return Some(decoded);
            }
        }
        if let Some(rest) = part.strip_prefix("filename=") {
            return Some(rest.trim_matches('"').to_string());
        }
    }
    None
}

/// 最小 percent-decoding(避免引新依赖)。
fn urlencoding_decode(s: &str) -> Result<String, ()> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|_| ())?;
            let byte = u8::from_str_radix(hex, 16).map_err(|_| ())?;
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

/// 内容若已是 Clash 配置(含 proxies/proxy-providers)则原样保留;
/// 否则尝试 nova-core 解析(base64/URI 列表)并包装为最小配置。
fn normalize_content(raw: &str) -> Result<String, String> {
    let looks_like_clash = serde_yaml::from_str::<serde_yaml::Value>(raw)
        .ok()
        .and_then(|v| {
            v.as_mapping().map(|m| {
                m.contains_key(serde_yaml::Value::from("proxies"))
                    || m.contains_key(serde_yaml::Value::from("proxy-providers"))
            })
        })
        .unwrap_or(false);
    if looks_like_clash {
        return Ok(raw.to_string());
    }
    let proxies = nova_core::parse_subscription(raw).map_err(|e| format!("订阅解析失败: {e}"))?;
    // 提取节点名列表用于构造 proxy-group
    let proxy_names: Vec<serde_yaml::Value> = proxies
        .iter()
        .filter_map(|p| {
            p.as_mapping()
                .and_then(|m| m.get(&serde_yaml::Value::from("name")))
                .cloned()
        })
        .collect();
    let mut root = serde_yaml::Mapping::new();
    root.insert(
        serde_yaml::Value::from("proxies"),
        serde_yaml::Value::Sequence(proxies),
    );
    // 自动生成默认 proxy-group: 类型 select, 包含所有节点
    if !proxy_names.is_empty() {
        let mut group = serde_yaml::Mapping::new();
        group.insert(
            serde_yaml::Value::from("name"),
            serde_yaml::Value::from("PROXY"),
        );
        group.insert(
            serde_yaml::Value::from("type"),
            serde_yaml::Value::from("select"),
        );
        group.insert(
            serde_yaml::Value::from("proxies"),
            serde_yaml::Value::Sequence(proxy_names),
        );
        root.insert(
            serde_yaml::Value::from("proxy-groups"),
            serde_yaml::Value::Sequence(vec![serde_yaml::Value::Mapping(group)]),
        );
        // 生成默认规则: MATCH,PROXY
        root.insert(
            serde_yaml::Value::from("rules"),
            serde_yaml::Value::Sequence(vec![serde_yaml::Value::from("MATCH,PROXY")]),
        );
    }
    serde_yaml::to_string(&serde_yaml::Value::Mapping(root))
        .map_err(|e| format!("生成配置失败: {e}"))
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("base36 总是合法 ASCII")
}

struct DownloadedProfile {
    content: String,
    name: Option<String>,
    quota: Option<ProfileQuota>,
    interval_min: Option<u32>,
}

fn system_download_builder(
    builder: reqwest::ClientBuilder,
) -> Result<reqwest::ClientBuilder, String> {
    #[cfg(windows)]
    {
        use winreg::{
            enums::{HKEY_CURRENT_USER, KEY_READ},
            RegKey,
        };
        let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
            KEY_READ,
        );
        let key = match key {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(builder),
            Err(error) => return Err(format!("读取 Windows 系统代理失败: {error}")),
        };
        if key.get_value::<u32, _>("ProxyEnable").unwrap_or(0) != 0 {
            let server = key
                .get_value::<String, _>("ProxyServer")
                .map_err(|_| "Windows 系统代理缺少地址")?;
            let bypass = key
                .get_value::<String, _>("ProxyOverride")
                .unwrap_or_default();
            let routes = options::system_proxy_routes(&server)?;
            return Ok(builder.proxy(reqwest::Proxy::custom(move |url| {
                if options::system_proxy_bypassed(url, &bypass) {
                    None
                } else {
                    routes.get(url.scheme()).cloned()
                }
            })));
        }
    }
    Ok(builder)
}

async fn download_profile(
    url: &str,
    options: &ProfileDownloadOptions,
    core_port: u16,
) -> Result<DownloadedProfile, String> {
    options.validate()?;
    let mut builder = reqwest::Client::builder()
        .user_agent(options.user_agent())
        .timeout(Duration::from_secs(u64::from(options.timeout_sec)));
    builder = match options.proxy {
        DownloadProxy::System => system_download_builder(builder)?,
        DownloadProxy::Direct => builder.no_proxy(),
        DownloadProxy::Core => builder.proxy(
            reqwest::Proxy::all(format!("http://127.0.0.1:{core_port}"))
                .map_err(|e| format!("构建内核下载代理失败: {}", e.without_url()))?,
        ),
    };
    let client = builder
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {}", e.without_url()))?;
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载订阅失败: {}", e.without_url()))?;
    if !resp.status().is_success() {
        return Err(format!("下载订阅失败: HTTP {}", resp.status()));
    }
    let quota = resp
        .headers()
        .get("subscription-userinfo")
        .and_then(|v| v.to_str().ok())
        .and_then(parse_userinfo);
    let name = resp
        .headers()
        .get("content-disposition")
        .and_then(|v| v.to_str().ok())
        .and_then(parse_filename)
        .map(|f| {
            f.trim_end_matches(".yaml")
                .trim_end_matches(".yml")
                .to_string()
        });

    let interval_min = options
        .update_interval_from_header
        .then(|| {
            options::header_update_minutes(
                resp.headers()
                    .get("profile-update-interval")
                    .and_then(|value| value.to_str().ok()),
            )
        })
        .flatten();
    if resp
        .content_length()
        .is_some_and(|size| size > MAX_SUBSCRIPTION_BYTES as u64)
    {
        return Err("订阅超过 16 MiB 大小限制".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("读取订阅失败: {}", e.without_url()))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_SUBSCRIPTION_BYTES {
            return Err("订阅超过 16 MiB 大小限制".into());
        }
        body.extend_from_slice(&chunk);
    }
    let raw = String::from_utf8(body).map_err(|_| "订阅不是有效的 UTF-8 文本")?;
    Ok(DownloadedProfile {
        content: normalize_content(&raw)?,
        name,
        quota,
        interval_min,
    })
}

/// 下载并导入订阅，兼容浏览器分享协议和显式下载选项。
pub async fn import(
    app: &AppHandle,
    url: String,
    options: Option<ProfileDownloadOptions>,
) -> Result<ProfileMeta, String> {
    let source: ImportSource = resolve_import_url(&url)?;
    let options = options.unwrap_or_default();
    let downloaded = download_profile(
        &source.url,
        &options,
        app.state::<AppState>().settings_snapshot().mixed_port,
    )
    .await?;
    let content = downloaded.content;
    let url = source.url;

    let name = source
        .name
        .or(downloaded.name)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            reqwest::Url::parse(&url)
                .ok()
                .and_then(|url| url.host_str().map(str::to_string))
        })
        .unwrap_or_else(|| "新订阅".into());

    let transaction_state = app.state::<AppState>();
    let _configuration = transaction_state.config_lock.lock().await;
    let mut transaction = FileTransaction::capture(&[
        transaction_state.dirs.profiles_index(),
        transaction_state.dirs.runtime_config(),
    ])?;
    let result = async {
        let id = base36(now_millis());
        let state = app.state::<AppState>();
        transaction.write(&state.dirs.profile_file(&id), content.as_bytes())?;
        let builtin_prune = builtin_prune_enhancer();
        transaction.write(
            &enhancer_file(&state, &id, &builtin_prune),
            BUILTIN_PRUNE_SCRIPT.as_bytes(),
        )?;

        let mut index = load_index(app)?;
        let first = index.is_empty();
        let meta = ProfileMeta {
            id,
            name,
            kind: "remote".into(),
            url: Some(url),
            updated_at: now_millis(),
            auto_update_min: Some(downloaded.interval_min.unwrap_or(1440)),
            download_options: options,
            size_bytes: Some(content.len() as u64),
            quota: downloaded.quota,
            current: first,
            builtin_enhancers_seeded: true,
            enhancers: vec![builtin_prune],
        };
        index.push(meta.clone());
        save_index(app, &index)?;
        if first {
            regenerate_runtime_async(app).await?;
            // 首次订阅自动成为当前配置 → 热加载或启动内核
            if crate::core::is_running(app).await {
                crate::core::reload_runtime(app).await?;
            } else {
                crate::core::start(app)?;
            }
        }
        Ok(meta)
    }
    .await;
    finish_transaction(app, &mut transaction, result).await
}

/// 导入本地配置文件内容, 返回新 ProfileMeta。
pub async fn import_file(
    app: &AppHandle,
    name: String,
    raw: String,
) -> Result<ProfileMeta, String> {
    if raw.trim().is_empty() {
        return Err("配置文件为空".into());
    }

    let content = normalize_content(&raw)?;
    let profile_name = std::path::Path::new(&name)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("本地配置")
        .to_string();

    let transaction_state = app.state::<AppState>();
    let _configuration = transaction_state.config_lock.lock().await;
    let mut transaction = FileTransaction::capture(&[
        transaction_state.dirs.profiles_index(),
        transaction_state.dirs.runtime_config(),
    ])?;
    let result = async {
        let id = base36(now_millis());
        let state = app.state::<AppState>();
        transaction.write(&state.dirs.profile_file(&id), content.as_bytes())?;
        let builtin_prune = builtin_prune_enhancer();
        transaction.write(
            &enhancer_file(&state, &id, &builtin_prune),
            BUILTIN_PRUNE_SCRIPT.as_bytes(),
        )?;

        let mut index = load_index(app)?;
        let first = index.is_empty();
        let meta = ProfileMeta {
            id,
            name: profile_name,
            kind: "local".into(),
            url: Some(name),
            updated_at: now_millis(),
            auto_update_min: None,
            download_options: ProfileDownloadOptions::default(),
            size_bytes: Some(content.len() as u64),
            quota: None,
            current: first,
            builtin_enhancers_seeded: true,
            enhancers: vec![builtin_prune],
        };
        index.push(meta.clone());
        save_index(app, &index)?;
        if first {
            regenerate_runtime_async(app).await?;
            if crate::core::is_running(app).await {
                crate::core::reload_runtime(app).await?;
            } else {
                crate::core::start(app)?;
            }
        }
        Ok(meta)
    }
    .await;
    finish_transaction(app, &mut transaction, result).await
}

/// 重新下载已有订阅并刷新元信息。
pub async fn update(app: &AppHandle, id: String) -> Result<ProfileMeta, String> {
    let index = load_index(app)?;
    let meta = index
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("订阅不存在: {id}"))?;
    if meta.kind != "remote" {
        return Err("本地配置不支持远程更新".into());
    }
    let url = meta
        .url
        .clone()
        .ok_or_else(|| "本地配置不支持远程更新".to_string())?;

    let source = resolve_import_url(&url)?;
    let options = meta.download_options.clone();
    let downloaded = download_profile(
        &source.url,
        &options,
        app.state::<AppState>().settings_snapshot().mixed_port,
    )
    .await?;
    let content = downloaded.content;

    let transaction_state = app.state::<AppState>();
    let _configuration = transaction_state.config_lock.lock().await;
    let mut transaction = FileTransaction::capture(&[
        transaction_state.dirs.profiles_index(),
        transaction_state.dirs.runtime_config(),
    ])?;
    let result = async {
        let state = app.state::<AppState>();
        transaction.write(&state.dirs.profile_file(&id), content.as_bytes())?;

        let mut index = load_index(app)?;
        let slot = index
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("订阅不存在: {id}"))?;
        if slot.url.as_deref() != Some(url.as_str()) || slot.download_options != options {
            return Err("下载期间订阅地址或下载选项已改变，请重新更新".into());
        }
        slot.updated_at = now_millis();
        slot.size_bytes = Some(content.len() as u64);
        if downloaded.quota.is_some() {
            slot.quota = downloaded.quota;
        }
        // 用户关闭自动更新后，手动刷新不得被服务端响应头重新开启。
        if slot.auto_update_min.is_some() && downloaded.interval_min.is_some() {
            slot.auto_update_min = downloaded.interval_min;
        }
        let updated = slot.clone();
        let is_current = slot.current;
        save_index(app, &index)?;

        if is_current {
            regenerate_runtime_async(app).await?;
            crate::core::reload_runtime(app).await?;
        }
        Ok(updated)
    }
    .await;
    finish_transaction(app, &mut transaction, result).await
}

/// 更新订阅元信息(名称、订阅地址、自动更新间隔)。
pub async fn update_meta(
    app: &AppHandle,
    id: String,
    name: String,
    url: Option<String>,
    auto_update_min: Option<u32>,
    download_options: Option<ProfileDownloadOptions>,
) -> Result<ProfileMeta, String> {
    let transaction_state = app.state::<AppState>();
    let _configuration = transaction_state.config_lock.lock().await;
    let mut transaction = FileTransaction::capture(&[
        transaction_state.dirs.profiles_index(),
        transaction_state.dirs.runtime_config(),
    ])?;
    let result = async {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("订阅名称不能为空".into());
        }

        let mut index = load_index(app)?;
        let slot = index
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("订阅不存在: {id}"))?;

        let mut next_url = url
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if slot.kind == "remote" {
            let Some(remote_url) = next_url.as_deref() else {
                return Err("远程订阅 URL 不能为空".into());
            };
            next_url = Some(resolve_import_url(remote_url)?.url);
        }
        if let Some(options) = download_options {
            options.validate()?;
            slot.download_options = options;
        }

        slot.name = name;
        slot.url = next_url;
        slot.auto_update_min = auto_update_min.filter(|value| *value > 0);
        let updated = slot.clone();
        save_index(app, &index)?;
        Ok(updated)
    }
    .await;
    finish_transaction(app, &mut transaction, result).await
}

/// 切换当前订阅并热加载。
pub async fn select(app: &AppHandle, id: String) -> Result<(), String> {
    let transaction_state = app.state::<AppState>();
    let _configuration = transaction_state.config_lock.lock().await;
    let mut transaction = FileTransaction::capture(&[
        transaction_state.dirs.profiles_index(),
        transaction_state.dirs.runtime_config(),
    ])?;
    let result = async {
        let mut index = load_index(app)?;
        if !index.iter().any(|p| p.id == id) {
            return Err(format!("订阅不存在: {id}"));
        }
        for p in index.iter_mut() {
            p.current = p.id == id;
        }
        save_index(app, &index)?;
        regenerate_runtime_async(app).await?;
        crate::core::reload_runtime(app).await
    }
    .await;
    finish_transaction(app, &mut transaction, result).await
}

/// 删除订阅;若删的是当前项, 自动切到剩余第一项。
pub async fn delete(app: &AppHandle, id: String) -> Result<(), String> {
    let transaction_state = app.state::<AppState>();
    let _configuration = transaction_state.config_lock.lock().await;
    let mut transaction = FileTransaction::capture(&[
        transaction_state.dirs.profiles_index(),
        transaction_state.dirs.runtime_config(),
    ])?;
    let result = async {
        let mut index = load_index(app)?;
        let removed = index
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| format!("订阅不存在: {id}"))?;
        let was_current = removed.current;
        index.retain(|p| p.id != id);
        if was_current {
            if let Some(first) = index.first_mut() {
                first.current = true;
            }
        }
        save_index(app, &index)?;
        let state = app.state::<AppState>();
        transaction.remove(state.dirs.profile_file(&id))?;
        for enhancer in &removed.enhancers {
            transaction.remove(enhancer_file(&state, &id, enhancer))?;
        }
        if was_current {
            regenerate_runtime_async(app).await?;
            crate::core::reload_runtime(app).await?;
        }
        Ok(())
    }
    .await;
    finish_transaction(app, &mut transaction, result).await
}

/// 读取订阅 YAML 原文。
pub fn read_content(app: &AppHandle, id: &str) -> Result<String, String> {
    if !load_index(app)?.iter().any(|profile| profile.id == id) {
        return Err(format!("订阅不存在: {id}"));
    }
    let state = app.state::<AppState>();
    fs::read_to_string(state.dirs.profile_file(id)).map_err(|e| format!("读取订阅失败: {e}"))
}

pub fn read_profile_topology(app: &AppHandle, id: &str) -> Result<ProfileTopology, String> {
    topology::read_topology(read_content(app, id)?)
}

pub async fn save_profile_topology(
    app: &AppHandle,
    id: String,
    original_content: String,
    proxies: Vec<serde_json::Value>,
    groups: Vec<serde_json::Value>,
    renames: Option<std::collections::HashMap<String, String>>,
) -> Result<(), String> {
    let content = topology::write_topology(
        &original_content,
        proxies,
        groups,
        &renames.unwrap_or_default(),
    )?;
    save_content_checked(app, id, content, Some(original_content)).await
}

pub fn list_rule_targets(app: &AppHandle, id: &str) -> Result<Vec<String>, String> {
    let index = load_index(app)?;
    let meta = index
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("订阅不存在: {id}"))?;
    let profile_yaml = read_content(app, &meta.id)?;
    let state = app.state::<AppState>();
    let enhanced = apply_enhancers(
        Some(meta),
        &list_global_enhancers(app)?,
        &profile_yaml,
        |file| {
            fs::read_to_string(state.dirs.profiles.join(file))
                .map_err(|err| format!("读取增强项失败: {err}"))
        },
    )?;
    let root = serde_yaml::from_str::<serde_yaml::Value>(&enhanced)
        .map_err(|e| format!("YAML 语法错误: {e}"))?;

    let mut targets = Vec::new();
    for item in ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "GLOBAL"] {
        push_rule_target(&mut targets, item);
    }

    if let Some(groups) = yaml_get(&root, "proxy-groups").and_then(|v| v.as_sequence()) {
        for group in groups {
            if let Some(name) = yaml_get(group, "name").and_then(|v| v.as_str()) {
                push_rule_target(&mut targets, name);
            }
        }
        for group in groups {
            if let Some(proxies) = yaml_get(group, "proxies").and_then(|v| v.as_sequence()) {
                for proxy in proxies {
                    if let Some(name) = proxy.as_str() {
                        push_rule_target(&mut targets, name);
                    }
                }
            }
        }
    }

    if let Some(proxies) = yaml_get(&root, "proxies").and_then(|v| v.as_sequence()) {
        for proxy in proxies {
            if let Some(name) = yaml_get(proxy, "name").and_then(|v| v.as_str()) {
                push_rule_target(&mut targets, name);
            }
        }
    }

    Ok(targets)
}

fn yaml_get<'a>(value: &'a serde_yaml::Value, key: &str) -> Option<&'a serde_yaml::Value> {
    value
        .as_mapping()
        .and_then(|mapping| mapping.get(&serde_yaml::Value::from(key)))
}

fn push_rule_target(targets: &mut Vec<String>, value: &str) {
    let name = value.trim();
    if name.is_empty() || targets.iter().any(|item| item == name) {
        return;
    }
    targets.push(name.to_string());
}

/// 校验 YAML 后写回订阅内容;当前项则重生成并热加载。
pub async fn save_content(app: &AppHandle, id: String, content: String) -> Result<(), String> {
    save_content_checked(app, id, content, None).await
}

async fn save_content_checked(
    app: &AppHandle,
    id: String,
    content: String,
    original: Option<String>,
) -> Result<(), String> {
    let transaction_state = app.state::<AppState>();
    let _configuration = transaction_state.config_lock.lock().await;
    let mut transaction = FileTransaction::capture(&[
        transaction_state.dirs.profiles_index(),
        transaction_state.dirs.runtime_config(),
    ])?;
    let result = async {
        serde_yaml::from_str::<serde_yaml::Value>(&content)
            .map_err(|e| format!("YAML 语法错误: {e}"))?;
        if !load_index(app)?.iter().any(|profile| profile.id == id) {
            return Err(format!("订阅不存在: {id}"));
        }
        if let Some(original) = &original {
            if read_content(app, &id)? != *original {
                return Err("编辑期间订阅已更新，请重新打开编辑器后再保存".into());
            }
        }
        let state = app.state::<AppState>();
        transaction.write(&state.dirs.profile_file(&id), content.as_bytes())?;

        let mut index = load_index(app)?;
        let mut is_current = false;
        if let Some(slot) = index.iter_mut().find(|p| p.id == id) {
            slot.updated_at = now_millis();
            slot.size_bytes = Some(content.len() as u64);
            is_current = slot.current;
            save_index(app, &index)?;
        }
        if is_current {
            regenerate_runtime_async(app).await?;
            crate::core::reload_runtime(app).await?;
        } else if original.is_some() {
            // 可视化编辑未启用的订阅也做同一套内核语义检查，但不切换当前订阅。
            for profile in &mut index {
                profile.current = profile.id == id;
            }
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = app.state::<AppState>();
                let runtime = build_runtime_from_files(
                    &state.settings_snapshot(),
                    &index,
                    &list_global_enhancers(&app)?,
                    |file| {
                        fs::read_to_string(state.dirs.profiles.join(file))
                            .map_err(|error| format!("读取配置文件失败: {error}"))
                    },
                )?;
                crate::core::validate_runtime(&app, &runtime)
            })
            .await
            .map_err(|error| format!("验证节点与策略组任务失败: {error}"))??;
        }
        Ok(())
    }
    .await;
    finish_transaction(app, &mut transaction, result).await
}

/// 用当前订阅 + 增强链 + 设置覆写生成 runtime.yaml(无订阅时生成最小可启动配置)。
///
/// 增强链、语义预检均成功后才替换运行时文件。
pub fn regenerate_runtime(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let settings = state.settings_snapshot();
    let index = load_index(app)?;
    let runtime =
        build_runtime_from_files(&settings, &index, &list_global_enhancers(app)?, |file| {
            fs::read_to_string(state.dirs.profiles.join(file))
                .map_err(|err| format!("读取配置文件失败: {err}"))
        })?;
    crate::core::validate_runtime(app, &runtime)?;
    atomic_write(&state.dirs.runtime_config(), runtime.as_bytes())
}

/// 运行时生成与备份恢复共用同一增强顺序；这里只读配置，不落盘或改动内核。
pub fn build_runtime_from_files(
    settings: &AppSettings,
    index: &[ProfileMeta],
    global: &[EnhancerMeta],
    mut read: impl FnMut(&str) -> Result<String, String>,
) -> Result<String, String> {
    let current = index.iter().find(|p| p.current);
    let profile_yaml = current
        .map(|p| read(&format!("{}.yaml", p.id)))
        .transpose()?
        .unwrap_or_else(|| "proxies: []\n".to_string());
    let enhanced = apply_enhancers(current, global, &profile_yaml, read)?;
    nova_core::build_runtime_config(&enhanced, &settings.to_overrides())
        .map_err(|e| format!("生成运行时配置失败: {e}"))
}

pub async fn regenerate_runtime_async(app: &AppHandle) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || regenerate_runtime(&app))
        .await
        .map_err(|e| format!("生成配置任务失败: {e}"))?
}

/// 按订阅间隔更新; 顺序执行, 失败至少间隔一分钟再试。
pub fn spawn_updater(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut attempted = std::collections::HashMap::<String, u64>::new();
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let index = match load_index(&app) {
                Ok(index) => index,
                Err(err) => {
                    log::warn!("自动更新读取订阅失败: {err}");
                    continue;
                }
            };
            attempted.retain(|id, _| index.iter().any(|profile| &profile.id == id));
            for profile in index {
                let Some(minutes) = profile.auto_update_min.filter(|minutes| *minutes > 0) else {
                    continue;
                };
                if profile.kind != "remote" {
                    continue;
                }
                let now = now_millis();
                let interval = u64::from(minutes) * 60_000;
                if now.saturating_sub(profile.updated_at) < interval
                    || attempted
                        .get(&profile.id)
                        .is_some_and(|last| now.saturating_sub(*last) < interval.min(300_000))
                {
                    continue;
                }
                attempted.insert(profile.id.clone(), now);
                if let Err(err) = update(&app, profile.id).await {
                    log::warn!("订阅自动更新失败: {err}");
                    let _ = app.emit(
                        "operation-error",
                        serde_json::json!({
                            "title": "订阅自动更新失败", "message": err,
                        }),
                    );
                }
            }
        }
    });
}

/* ---------------- 配置增强链(M2) ---------------- */

fn enhancer_file(state: &AppState, pid: &str, e: &EnhancerMeta) -> std::path::PathBuf {
    state.dirs.profiles.join(enhancer_filename(pid, e))
}

fn enhancer_filename(pid: &str, e: &EnhancerMeta) -> String {
    let ext = if e.kind == "merge" { "yaml" } else { "js" };
    format!("{pid}.{}.{ext}", e.id)
}

fn global_enhancer_index(app: &AppHandle) -> std::path::PathBuf {
    app.state::<AppState>()
        .dirs
        .profiles
        .join("global-enhancers.json")
}

pub fn list_global_enhancers(app: &AppHandle) -> Result<Vec<EnhancerMeta>, String> {
    match fs::read_to_string(global_enhancer_index(app)) {
        Ok(content) => {
            serde_json::from_str(&content).map_err(|err| format!("全局增强索引损坏: {err}"))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(format!("读取全局增强索引失败: {err}")),
    }
}

/// 依序应用启用的增强项, 读取/解析/执行失败必须反馈给调用者。
fn apply_enhancers(
    meta: Option<&ProfileMeta>,
    global: &[EnhancerMeta],
    profile_yaml: &str,
    mut read: impl FnMut(&str) -> Result<String, String>,
) -> Result<String, String> {
    let mut base = serde_yaml::from_str::<serde_yaml::Value>(profile_yaml)
        .map_err(|err| format!("订阅 YAML 无效: {err}"))?;
    let mut enabled_enhancers: Vec<(&str, &EnhancerMeta)> = meta
        .into_iter()
        .flat_map(|meta| meta.enhancers.iter().map(move |e| (meta.id.as_str(), e)))
        .chain(global.iter().map(|e| (GLOBAL_ENHANCER_ID, e)))
        .filter(|(_, e)| e.enabled)
        .collect();
    // Cleanup enhancers should see the final config produced by user scripts.
    enabled_enhancers.sort_by_key(|(_, e)| {
        if e.id == BUILTIN_PRUNE_ENHANCER_ID {
            1
        } else {
            0
        }
    });

    for (pid, e) in enabled_enhancers {
        let content = read(&enhancer_filename(pid, e))
            .map_err(|err| format!("增强项 {} 读取失败: {err}", e.name))?;
        let item = if e.kind == "merge" {
            nova_core::EnhancerItem::Merge(
                serde_yaml::from_str::<serde_yaml::Value>(&content)
                    .map_err(|err| format!("增强项 {} YAML 无效: {err}", e.name))?,
            )
        } else {
            nova_core::EnhancerItem::Script(content)
        };
        nova_core::apply_chain_with_profile(
            &mut base,
            std::slice::from_ref(&item),
            meta.map(|profile| profile.name.as_str()).unwrap_or_default(),
        )
            .map_err(|err| format!("增强项 {} 执行失败: {err}", e.name))?;
    }
    serde_yaml::to_string(&base).map_err(|err| format!("序列化增强结果失败: {err}"))
}

/// 局部与全局增强共用 CRUD 和事务，避免两套编辑流程漂移。
enum EnhancerScope {
    Global(Vec<EnhancerMeta>),
    Profile {
        index: Vec<ProfileMeta>,
        position: usize,
    },
}

impl EnhancerScope {
    fn load(app: &AppHandle, pid: &str) -> Result<Self, String> {
        if pid == GLOBAL_ENHANCER_ID {
            return Ok(Self::Global(list_global_enhancers(app)?));
        }
        let index = load_index(app)?;
        let position = index
            .iter()
            .position(|p| p.id == pid)
            .ok_or_else(|| format!("订阅不存在: {pid}"))?;
        Ok(Self::Profile { index, position })
    }

    fn entries(&self) -> &Vec<EnhancerMeta> {
        match self {
            Self::Global(entries) => entries,
            Self::Profile { index, position } => &index[*position].enhancers,
        }
    }

    fn entries_mut(&mut self) -> &mut Vec<EnhancerMeta> {
        match self {
            Self::Global(entries) => entries,
            Self::Profile { index, position } => &mut index[*position].enhancers,
        }
    }

    fn affects_runtime(&self) -> bool {
        match self {
            Self::Global(_) => true,
            Self::Profile { index, position } => index[*position].current,
        }
    }

    fn save(&self, app: &AppHandle) -> Result<(), String> {
        match self {
            Self::Global(entries) => {
                let json = serde_json::to_vec_pretty(entries)
                    .map_err(|err| format!("序列化增强索引失败: {err}"))?;
                atomic_write(&global_enhancer_index(app), &json)
            }
            Self::Profile { index, .. } => save_index(app, index),
        }
    }
}

/// 读取增强项内容; 缺失/不可读时明确报错, 不用空字符串覆盖原配置。
pub fn read_enhancer(app: &AppHandle, pid: &str, eid: &str) -> Result<String, String> {
    let scope = EnhancerScope::load(app, pid)?;
    let e = scope
        .entries()
        .iter()
        .find(|e| e.id == eid)
        .ok_or_else(|| format!("增强项不存在: {eid}"))?;
    let state = app.state::<AppState>();
    fs::read_to_string(enhancer_file(&state, pid, e))
        .map_err(|err| format!("读取增强项失败: {err}"))
}

/// 新建或更新增强项(eid 缺省则新建);merge 内容先做 YAML 校验。
/// 作用于当前订阅时重生成运行时配置并热加载。
pub async fn save_enhancer(
    app: &AppHandle,
    pid: String,
    eid: Option<String>,
    kind: String,
    name: String,
    content: String,
) -> Result<EnhancerMeta, String> {
    let transaction_state = app.state::<AppState>();
    let _configuration = transaction_state.config_lock.lock().await;
    let mut transaction = FileTransaction::capture(&[
        transaction_state.dirs.profiles_index(),
        transaction_state.dirs.runtime_config(),
        global_enhancer_index(app),
    ])?;
    let result = async {
        if !matches!(kind.as_str(), "merge" | "script") {
            return Err(format!("非法增强类型: {kind}"));
        }
        if kind == "merge" {
            serde_yaml::from_str::<serde_yaml::Value>(&content)
                .map_err(|e| format!("Merge YAML 语法错误: {e}"))?;
        }

        let mut scope = EnhancerScope::load(app, &pid)?;
        let entries = scope.entries_mut();
        let meta = match eid {
            Some(eid) => {
                let e = entries
                    .iter_mut()
                    .find(|e| e.id == eid)
                    .ok_or_else(|| format!("增强项不存在: {eid}"))?;
                if e.kind != kind {
                    return Err("已有增强项的类型不能改变，请新建对应类型".into());
                }
                e.name = name;
                e.clone()
            }
            None => {
                let e = EnhancerMeta {
                    id: base36(now_millis()),
                    kind,
                    name,
                    enabled: true,
                };
                entries.push(e.clone());
                e
            }
        };
        let is_current = scope.affects_runtime();
        let state = app.state::<AppState>();
        transaction.write(&enhancer_file(&state, &pid, &meta), content.as_bytes())?;
        scope.save(app)?;

        if is_current {
            regenerate_runtime_async(app).await?;
            crate::core::reload_runtime(app).await?;
        }
        Ok(meta)
    }
    .await;
    finish_transaction(app, &mut transaction, result).await
}

/// 删除增强项(连同内容文件)。
pub async fn delete_enhancer(app: &AppHandle, pid: String, eid: String) -> Result<(), String> {
    let transaction_state = app.state::<AppState>();
    let _configuration = transaction_state.config_lock.lock().await;
    let mut transaction = FileTransaction::capture(&[
        transaction_state.dirs.profiles_index(),
        transaction_state.dirs.runtime_config(),
        global_enhancer_index(app),
    ])?;
    let result = async {
        let mut scope = EnhancerScope::load(app, &pid)?;
        let entries = scope.entries_mut();
        let Some(pos) = entries.iter().position(|e| e.id == eid) else {
            return Err(format!("增强项不存在: {eid}"));
        };
        let removed = entries.remove(pos);
        let is_current = scope.affects_runtime();
        let state = app.state::<AppState>();
        transaction.remove(enhancer_file(&state, &pid, &removed))?;
        scope.save(app)?;

        if is_current {
            regenerate_runtime_async(app).await?;
            crate::core::reload_runtime(app).await?;
        }
        Ok(())
    }
    .await;
    finish_transaction(app, &mut transaction, result).await
}

/// 启用/停用增强项。
pub async fn toggle_enhancer(
    app: &AppHandle,
    pid: String,
    eid: String,
    enabled: bool,
) -> Result<(), String> {
    let transaction_state = app.state::<AppState>();
    let _configuration = transaction_state.config_lock.lock().await;
    let mut transaction = FileTransaction::capture(&[
        transaction_state.dirs.profiles_index(),
        transaction_state.dirs.runtime_config(),
        global_enhancer_index(app),
    ])?;
    let result = async {
        let mut scope = EnhancerScope::load(app, &pid)?;
        let e = scope
            .entries_mut()
            .iter_mut()
            .find(|e| e.id == eid)
            .ok_or_else(|| format!("增强项不存在: {eid}"))?;
        e.enabled = enabled;
        let is_current = scope.affects_runtime();
        scope.save(app)?;

        if is_current {
            regenerate_runtime_async(app).await?;
            crate::core::reload_runtime(app).await?;
        }
        Ok(())
    }
    .await;
    finish_transaction(app, &mut transaction, result).await
}

/// 重排序增强项。
pub async fn reorder_enhancers(
    app: &AppHandle,
    pid: String,
    eids: Vec<String>,
) -> Result<(), String> {
    let transaction_state = app.state::<AppState>();
    let _configuration = transaction_state.config_lock.lock().await;
    let mut transaction = FileTransaction::capture(&[
        transaction_state.dirs.profiles_index(),
        transaction_state.dirs.runtime_config(),
        global_enhancer_index(app),
    ])?;
    let result = async {
        let mut scope = EnhancerScope::load(app, &pid)?;
        let entries = scope.entries_mut();

        // 验证所有 ID 都存在
        if eids.len() != entries.len() {
            return Err("增强项数量不匹配".into());
        }

        // 验证 ID 唯一性
        let mut unique_ids = std::collections::HashSet::new();
        for eid in &eids {
            if !unique_ids.insert(eid) {
                return Err(format!("增强项 ID 重复: {eid}"));
            }
            if !entries.iter().any(|e| &e.id == eid) {
                return Err(format!("增强项不存在: {eid}"));
            }
        }

        // 按新顺序重排
        let mut reordered = Vec::with_capacity(eids.len());
        for eid in &eids {
            if let Some(enh) = entries.iter().find(|e| &e.id == eid).cloned() {
                reordered.push(enh);
            }
        }
        *entries = reordered;
        let is_current = scope.affects_runtime();
        scope.save(app)?;

        if is_current {
            regenerate_runtime_async(app).await?;
            crate::core::reload_runtime(app).await?;
        }
        Ok(())
    }
    .await;
    finish_transaction(app, &mut transaction, result).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn http_fixture(
        status: &str,
        headers: &str,
        body: &str,
    ) -> (u16, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
            body.as_bytes().len()
        );
        let thread = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 2048];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = socket.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
            }
            socket.write_all(response.as_bytes()).unwrap();
            String::from_utf8(request).unwrap()
        });
        (port, thread)
    }

    #[tokio::test]
    async fn downloads_use_custom_headers_and_server_update_interval() {
        let (port, server) = http_fixture("200 OK", "profile-update-interval: 6\r\nsubscription-userinfo: upload=10; download=20; total=100; expire=1000\r\ncontent-disposition: attachment; filename=fixture.yaml\r\n", "proxies: []\n");
        let options = ProfileDownloadOptions {
            user_agent: Some("ClashNova-Fixture/1.0".into()),
            proxy: DownloadProxy::Direct,
            ..Default::default()
        };
        let downloaded = download_profile(
            &format!("http://127.0.0.1:{port}/subscription"),
            &options,
            0,
        )
        .await
        .unwrap();
        assert_eq!(downloaded.interval_min, Some(360));
        assert_eq!(downloaded.quota.unwrap().used, 30);
        assert_eq!(downloaded.name.as_deref(), Some("fixture"));
        assert!(server
            .join()
            .unwrap()
            .to_lowercase()
            .contains("user-agent: clashnova-fixture/1.0"));
    }

    #[tokio::test]
    async fn core_download_proxy_routes_requests_and_manual_interval_is_preserved() {
        let (port, server) =
            http_fixture("200 OK", "profile-update-interval: 6\r\n", "proxies: []\n");
        let options = ProfileDownloadOptions {
            proxy: DownloadProxy::Core,
            update_interval_from_header: false,
            ..Default::default()
        };
        let downloaded =
            download_profile("http://subscription.example.invalid/sub", &options, port)
                .await
                .unwrap();
        assert!(server
            .join()
            .unwrap()
            .starts_with("GET http://subscription.example.invalid/sub HTTP/1.1"));
        assert_eq!(downloaded.interval_min, None);
    }

    #[tokio::test]
    async fn failed_downloads_do_not_expose_subscription_queries() {
        let (port, server) = http_fixture("503 Service Unavailable", "", "");
        let options = ProfileDownloadOptions {
            proxy: DownloadProxy::Direct,
            ..Default::default()
        };
        let error = download_profile(
            &format!("http://127.0.0.1:{port}/?token=fixture-private-value"),
            &options,
            0,
        )
        .await
        .err()
        .unwrap();
        server.join().unwrap();
        assert!(error.contains("503"));
        assert!(!error.contains("fixture-private-value"));
        let error = download_profile(
            "http://127.0.0.1:0/?token=fixture-private-value",
            &options,
            0,
        )
        .await
        .err()
        .unwrap();
        assert!(!error.contains("fixture-private-value"));
    }

    #[test]
    fn global_enhancers_apply_after_profile_and_before_application_settings() {
        let mut meta: ProfileMeta = serde_json::from_value(serde_json::json!({"id":"p", "name":"fixture", "kind":"local", "current":true, "updatedAt":0})).unwrap();
        meta.enhancers.push(EnhancerMeta {
            id: "local".into(),
            kind: "merge".into(),
            name: "local".into(),
            enabled: true,
        });
        let global = vec![EnhancerMeta {
            id: "shared".into(),
            kind: "script".into(),
            name: "shared".into(),
            enabled: true,
        }];
        let files = std::collections::HashMap::from([
            ("p.yaml", "proxies: []\nprofile-marker: original\n"),
            ("p.local.yaml", "profile-marker: local\n"),
            ("__global__.shared.js", "function main(config) { config['profile-marker'] += '-global'; config['mixed-port'] = 9999; return config; }"),
        ]);
        let settings = AppSettings::default();
        let runtime = build_runtime_from_files(&settings, &[meta], &global, |file| {
            files
                .get(file)
                .map(|content| content.to_string())
                .ok_or_else(|| "missing fixture".into())
        })
        .unwrap();
        let root: serde_yaml::Value = serde_yaml::from_str(&runtime).unwrap();
        assert_eq!(root["profile-marker"].as_str(), Some("local-global"));
        assert_eq!(
            root["mixed-port"].as_u64(),
            Some(settings.mixed_port as u64)
        );
    }

    #[test]
    fn profile_and_global_scripts_receive_the_current_profile_name() {
        let name = "机场 'quoted' \"name\"\\path\nline";
        let mut meta: ProfileMeta = serde_json::from_value(serde_json::json!({"id":"p", "name":name, "kind":"local", "current":true, "updatedAt":0})).unwrap();
        meta.enhancers.push(EnhancerMeta {
            id: "local".into(), kind: "script".into(), name: "not the profile name".into(), enabled: true,
        });
        let global = vec![EnhancerMeta {
            id: "shared".into(), kind: "script".into(), name: "global script name".into(), enabled: true,
        }];
        let files = std::collections::HashMap::from([
            ("p.yaml", "proxies: []\n"),
            ("p.local.js", "function main(config, profileName) { config.localName = profileName; return config; }"),
            ("__global__.shared.js", "function main(config, profileName) { config.globalName = profileName; return config; }"),
        ]);
        let runtime = build_runtime_from_files(&AppSettings::default(), &[meta], &global, |file| Ok(files[file].to_string())).unwrap();
        let root: serde_yaml::Value = serde_yaml::from_str(&runtime).unwrap();
        assert_eq!(root["localName"].as_str(), Some(name));
        assert_eq!(root["globalName"].as_str(), Some(name));
        let runtime = build_runtime_from_files(&AppSettings::default(), &[], &global, |file| Ok(files[file].to_string())).unwrap();
        let root: serde_yaml::Value = serde_yaml::from_str(&runtime).unwrap();
        assert_eq!(root["globalName"].as_str(), Some(""));
    }

    #[test]
    fn builtin_cleanup_upgrade_only_matches_the_unedited_previous_script() {
        let previous = include_str!("../../tests/fixtures/prune-invalid-nodes-v1.js");
        assert!(should_upgrade_builtin_prune_script(previous));
        assert!(!should_upgrade_builtin_prune_script(BUILTIN_PRUNE_SCRIPT));
        assert!(!should_upgrade_builtin_prune_script(&format!("{previous}\n// user customization")));
        assert!(!should_upgrade_builtin_prune_script("function main(config) { return config; }"));
    }

    #[test]
    fn builtin_cleanup_keeps_subscription_source_labels_and_removes_information_nodes() {
        let mut meta: ProfileMeta = serde_json::from_value(serde_json::json!({"id":"p", "name":"fixture", "kind":"local", "current":true, "updatedAt":0})).unwrap();
        let mut builtin = builtin_prune_enhancer();
        builtin.enabled = true;
        meta.enhancers.push(builtin);
        let base = "proxies:\n  - {name: '[当前订阅] 香港', type: socks5, server: proxy.example.invalid, port: 1080}\n  - {name: 'subscription | Tokyo', type: socks5, server: proxy.example.invalid, port: 1080}\n  - {name: '剩余流量 10GB', type: socks5, server: proxy.example.invalid, port: 1080}\n  - {name: '订阅地址: example.invalid', type: socks5, server: proxy.example.invalid, port: 1080}\nproxy-groups:\n  - name: select\n    type: select\n    proxies: ['[当前订阅] 香港', 'subscription | Tokyo', '剩余流量 10GB', '订阅地址: example.invalid']\n";
        let enhanced = apply_enhancers(Some(&meta), &[], base, |_| Ok(BUILTIN_PRUNE_SCRIPT.into())).unwrap();
        let root: serde_yaml::Value = serde_yaml::from_str(&enhanced).unwrap();
        let names: Vec<_> = root["proxies"].as_sequence().unwrap().iter().map(|node| node["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["[当前订阅] 香港", "subscription | Tokyo"]);
        assert_eq!(root["proxy-groups"][0]["proxies"].as_sequence().unwrap().len(), 2);
    }

    #[test]
    fn global_enhancer_failure_is_reported_and_disabled_items_are_not_read() {
        let mut enhancer = EnhancerMeta {
            id: "missing".into(),
            kind: "script".into(),
            name: "fixture".into(),
            enabled: true,
        };
        let error =
            build_runtime_from_files(&AppSettings::default(), &[], &[enhancer.clone()], |_| {
                Err("fixture file missing".into())
            })
            .unwrap_err();
        assert!(error.contains("fixture file missing"));
        enhancer.enabled = false;
        assert!(
            build_runtime_from_files(&AppSettings::default(), &[], &[enhancer], |_| panic!(
                "disabled file read"
            ))
            .is_ok()
        );
    }
}
