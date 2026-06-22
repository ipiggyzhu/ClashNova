//! 订阅 Profile 管理:下载/解析/落盘/索引/运行时配置生成。

use std::fs;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::state::{atomic_write, now_millis, AppState};

const USER_AGENT: &str = "ClashNova/2.0 clash-verge-compatible clash-meta";
const BUILTIN_PRUNE_ENHANCER_ID: &str = "builtin-prune-invalid-nodes";
const BUILTIN_PRUNE_ENHANCER_NAME: &str = "内置：去除无效节点";
const BUILTIN_PRUNE_SCRIPT: &str = r#"// 去除名称里明显不是节点的项目，并同步清理策略组和订阅提供者引用。
function main(config) {
  const invalidNodeFilterBody = '过期|到期|失效|剩余|流量|官网|套餐|订阅|网址|重置|用量|群组|频道|traffic|expire|subscription|remaining|reset|used|total';
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

fn ensure_builtin_prune_enhancers(app: &AppHandle, index: &mut [ProfileMeta]) -> bool {
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
            let needs_write = fs::read(&path)
                .map(|content| content != BUILTIN_PRUNE_SCRIPT.as_bytes())
                .unwrap_or(true);
            if needs_write {
                if let Err(err) = atomic_write(&path, BUILTIN_PRUNE_SCRIPT.as_bytes()) {
                    log::warn!("写入内置增强脚本失败 {}: {err}", path.display());
                }
            }
        }
    }

    changed
}

/// 读取 profiles.json 索引(缺失时返回空表)。
pub fn load_index(app: &AppHandle) -> Vec<ProfileMeta> {
    let state = app.state::<AppState>();
    let path = state.dirs.profiles_index();
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut index: Vec<ProfileMeta> = serde_json::from_str(&raw).unwrap_or_default();
    if ensure_builtin_prune_enhancers(app, &mut index) {
        if let Err(err) = save_index(app, &index) {
            log::warn!("迁移内置增强脚本索引失败: {err}");
        }
    }
    index
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
            "expire" if v > 0 => expire = Some(v * 1000), // 秒 → 毫秒
            _ => {}
        }
    }
    if total == 0 {
        return None;
    }
    Some(ProfileQuota {
        used: upload + download,
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

/// 下载并导入订阅, 返回新 ProfileMeta。
pub async fn import(app: &AppHandle, url: String) -> Result<ProfileMeta, String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载订阅失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载订阅失败: HTTP {}", resp.status()));
    }

    let quota = resp
        .headers()
        .get("subscription-userinfo")
        .and_then(|v| v.to_str().ok())
        .and_then(parse_userinfo);
    let disp_name = resp
        .headers()
        .get("content-disposition")
        .and_then(|v| v.to_str().ok())
        .and_then(parse_filename)
        .map(|f| {
            f.trim_end_matches(".yaml")
                .trim_end_matches(".yml")
                .to_string()
        });

    let raw = resp
        .text()
        .await
        .map_err(|e| format!("读取订阅失败: {e}"))?;
    let content = normalize_content(&raw)?;

    let name = disp_name
        .filter(|s| !s.is_empty())
        .or_else(|| url::host(&url).map(|h| h.to_string()))
        .unwrap_or_else(|| "新订阅".into());

    let id = base36(now_millis());
    let state = app.state::<AppState>();
    atomic_write(&state.dirs.profile_file(&id), content.as_bytes())?;
    let builtin_prune = builtin_prune_enhancer();
    atomic_write(
        &enhancer_file(&state, &id, &builtin_prune),
        BUILTIN_PRUNE_SCRIPT.as_bytes(),
    )?;

    let mut index = load_index(app);
    let first = index.is_empty();
    let meta = ProfileMeta {
        id,
        name,
        kind: "remote".into(),
        url: Some(url),
        updated_at: now_millis(),
        auto_update_min: Some(1440),
        size_bytes: Some(content.len() as u64),
        quota,
        current: first,
        builtin_enhancers_seeded: true,
        enhancers: vec![builtin_prune],
    };
    index.push(meta.clone());
    save_index(app, &index)?;
    if first {
        regenerate_runtime(app)?;
        // 首次订阅自动成为当前配置 → 热加载或启动内核
        if crate::core::is_running(app).await {
            crate::core::reload_runtime(app).await?;
        } else {
            crate::core::start(app)?;
        }
    }
    Ok(meta)
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

    let id = base36(now_millis());
    let state = app.state::<AppState>();
    atomic_write(&state.dirs.profile_file(&id), content.as_bytes())?;
    let builtin_prune = builtin_prune_enhancer();
    atomic_write(
        &enhancer_file(&state, &id, &builtin_prune),
        BUILTIN_PRUNE_SCRIPT.as_bytes(),
    )?;

    let mut index = load_index(app);
    let first = index.is_empty();
    let meta = ProfileMeta {
        id,
        name: profile_name,
        kind: "local".into(),
        url: Some(name),
        updated_at: now_millis(),
        auto_update_min: None,
        size_bytes: Some(content.len() as u64),
        quota: None,
        current: first,
        builtin_enhancers_seeded: true,
        enhancers: vec![builtin_prune],
    };
    index.push(meta.clone());
    save_index(app, &index)?;
    if first {
        regenerate_runtime(app)?;
        if crate::core::is_running(app).await {
            crate::core::reload_runtime(app).await?;
        } else {
            crate::core::start(app)?;
        }
    }
    Ok(meta)
}

/// 重新下载已有订阅并刷新元信息。
pub async fn update(app: &AppHandle, id: String) -> Result<ProfileMeta, String> {
    let index = load_index(app);
    let meta = index
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("订阅不存在: {id}"))?;
    let url = meta
        .url
        .clone()
        .ok_or_else(|| "本地配置不支持远程更新".to_string())?;

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载订阅失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载订阅失败: HTTP {}", resp.status()));
    }
    let quota = resp
        .headers()
        .get("subscription-userinfo")
        .and_then(|v| v.to_str().ok())
        .and_then(parse_userinfo);
    let raw = resp
        .text()
        .await
        .map_err(|e| format!("读取订阅失败: {e}"))?;
    let content = normalize_content(&raw)?;

    let state = app.state::<AppState>();
    atomic_write(&state.dirs.profile_file(&id), content.as_bytes())?;

    let mut index = load_index(app);
    let slot = index
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("订阅不存在: {id}"))?;
    slot.updated_at = now_millis();
    slot.size_bytes = Some(content.len() as u64);
    if quota.is_some() {
        slot.quota = quota;
    }
    let updated = slot.clone();
    let is_current = slot.current;
    save_index(app, &index)?;

    if is_current {
        regenerate_runtime(app)?;
        crate::core::reload_runtime(app).await?;
    }
    Ok(updated)
}

/// 切换当前订阅并热加载。
pub async fn select(app: &AppHandle, id: String) -> Result<(), String> {
    let mut index = load_index(app);
    if !index.iter().any(|p| p.id == id) {
        return Err(format!("订阅不存在: {id}"));
    }
    for p in index.iter_mut() {
        p.current = p.id == id;
    }
    save_index(app, &index)?;
    regenerate_runtime(app)?;
    crate::core::reload_runtime(app).await
}

/// 删除订阅;若删的是当前项, 自动切到剩余第一项。
pub async fn delete(app: &AppHandle, id: String) -> Result<(), String> {
    let mut index = load_index(app);
    let was_current = index.iter().any(|p| p.id == id && p.current);
    index.retain(|p| p.id != id);
    if was_current {
        if let Some(first) = index.first_mut() {
            first.current = true;
        }
    }
    save_index(app, &index)?;
    let state = app.state::<AppState>();
    let _ = fs::remove_file(state.dirs.profile_file(&id));
    if was_current {
        regenerate_runtime(app)?;
        crate::core::reload_runtime(app).await?;
    }
    Ok(())
}

/// 读取订阅 YAML 原文。
pub fn read_content(app: &AppHandle, id: &str) -> Result<String, String> {
    let state = app.state::<AppState>();
    fs::read_to_string(state.dirs.profile_file(id)).map_err(|e| format!("读取订阅失败: {e}"))
}

pub fn list_rule_targets(app: &AppHandle, id: &str) -> Result<Vec<String>, String> {
    let index = load_index(app);
    let meta = index
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("订阅不存在: {id}"))?;
    let profile_yaml = read_content(app, &meta.id)?;
    let enhanced = if meta.enhancers.iter().any(|e| e.enabled) {
        apply_enhancers(app, meta, &profile_yaml)
    } else {
        profile_yaml
    };
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
    serde_yaml::from_str::<serde_yaml::Value>(&content)
        .map_err(|e| format!("YAML 语法错误: {e}"))?;
    let state = app.state::<AppState>();
    atomic_write(&state.dirs.profile_file(&id), content.as_bytes())?;

    let mut index = load_index(app);
    let mut is_current = false;
    if let Some(slot) = index.iter_mut().find(|p| p.id == id) {
        slot.updated_at = now_millis();
        slot.size_bytes = Some(content.len() as u64);
        is_current = slot.current;
        save_index(app, &index)?;
    }
    if is_current {
        regenerate_runtime(app)?;
        crate::core::reload_runtime(app).await?;
    }
    Ok(())
}

/// 用当前订阅 + 增强链 + 设置覆写生成 runtime.yaml(无订阅时生成最小可启动配置)。
///
/// 增强链单项失败仅记日志并跳过,不阻断内核配置生成。
pub fn regenerate_runtime(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let settings = state.settings_snapshot();
    let index = load_index(app);
    let current = index.iter().find(|p| p.current);
    let profile_yaml = current
        .map(|p| read_content(app, &p.id))
        .transpose()?
        .unwrap_or_else(|| "proxies: []\n".to_string());

    let enhanced = match current {
        Some(meta) if meta.enhancers.iter().any(|e| e.enabled) => {
            apply_enhancers(app, meta, &profile_yaml)
        }
        _ => profile_yaml,
    };

    let runtime = nova_core::build_runtime_config(&enhanced, &settings.to_overrides())
        .map_err(|e| format!("生成运行时配置失败: {e}"))?;
    atomic_write(&state.dirs.runtime_config(), runtime.as_bytes())
}

/* ---------------- 配置增强链(M2) ---------------- */

fn enhancer_file(state: &AppState, pid: &str, e: &EnhancerMeta) -> std::path::PathBuf {
    let ext = if e.kind == "merge" { "yaml" } else { "js" };
    state.dirs.profiles.join(format!("{pid}.{}.{ext}", e.id))
}

/// 依序应用启用的增强项;任一项读取/解析/执行失败 → 记日志跳过该项。
fn apply_enhancers(app: &AppHandle, meta: &ProfileMeta, profile_yaml: &str) -> String {
    let state = app.state::<AppState>();
    let Ok(mut base) = serde_yaml::from_str::<serde_yaml::Value>(profile_yaml) else {
        return profile_yaml.to_string();
    };
    let mut enabled_enhancers: Vec<&EnhancerMeta> =
        meta.enhancers.iter().filter(|e| e.enabled).collect();
    // Cleanup enhancers should see the final config produced by user scripts.
    enabled_enhancers.sort_by_key(|e| {
        if e.id == BUILTIN_PRUNE_ENHANCER_ID {
            1
        } else {
            0
        }
    });

    for e in enabled_enhancers {
        let path = enhancer_file(&state, &meta.id, e);
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(err) => {
                log::warn!("增强项 {}({}) 读取失败, 已跳过: {err}", e.name, e.id);
                continue;
            }
        };
        let item = if e.kind == "merge" {
            match serde_yaml::from_str::<serde_yaml::Value>(&content) {
                Ok(v) => nova_core::EnhancerItem::Merge(v),
                Err(err) => {
                    log::warn!("增强项 {}({}) YAML 非法, 已跳过: {err}", e.name, e.id);
                    continue;
                }
            }
        } else {
            nova_core::EnhancerItem::Script(content)
        };
        if let Err(err) = nova_core::apply_chain(&mut base, std::slice::from_ref(&item)) {
            log::warn!("增强项 {}({}) 应用失败, 已跳过: {err}", e.name, e.id);
        }
    }
    serde_yaml::to_string(&base).unwrap_or_else(|_| profile_yaml.to_string())
}

/// 读取增强项内容(不存在时返回空串, 便于新建后首次编辑)。
pub fn read_enhancer(app: &AppHandle, pid: &str, eid: &str) -> Result<String, String> {
    let index = load_index(app);
    let meta = index
        .iter()
        .find(|p| p.id == pid)
        .ok_or_else(|| format!("订阅不存在: {pid}"))?;
    let e = meta
        .enhancers
        .iter()
        .find(|e| e.id == eid)
        .ok_or_else(|| format!("增强项不存在: {eid}"))?;
    let state = app.state::<AppState>();
    Ok(fs::read_to_string(enhancer_file(&state, pid, e)).unwrap_or_default())
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
    if !matches!(kind.as_str(), "merge" | "script") {
        return Err(format!("非法增强类型: {kind}"));
    }
    if kind == "merge" {
        serde_yaml::from_str::<serde_yaml::Value>(&content)
            .map_err(|e| format!("Merge YAML 语法错误: {e}"))?;
    }

    let mut index = load_index(app);
    let slot = index
        .iter_mut()
        .find(|p| p.id == pid)
        .ok_or_else(|| format!("订阅不存在: {pid}"))?;

    let meta = match eid {
        Some(eid) => {
            let e = slot
                .enhancers
                .iter_mut()
                .find(|e| e.id == eid)
                .ok_or_else(|| format!("增强项不存在: {eid}"))?;
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
            slot.enhancers.push(e.clone());
            e
        }
    };
    let is_current = slot.current;
    let state = app.state::<AppState>();
    atomic_write(&enhancer_file(&state, &pid, &meta), content.as_bytes())?;
    save_index(app, &index)?;

    if is_current {
        regenerate_runtime(app)?;
        crate::core::reload_runtime(app).await?;
    }
    Ok(meta)
}

/// 删除增强项(连同内容文件)。
pub async fn delete_enhancer(app: &AppHandle, pid: String, eid: String) -> Result<(), String> {
    let mut index = load_index(app);
    let slot = index
        .iter_mut()
        .find(|p| p.id == pid)
        .ok_or_else(|| format!("订阅不存在: {pid}"))?;
    let Some(pos) = slot.enhancers.iter().position(|e| e.id == eid) else {
        return Err(format!("增强项不存在: {eid}"));
    };
    let removed = slot.enhancers.remove(pos);
    let is_current = slot.current;
    let state = app.state::<AppState>();
    let _ = fs::remove_file(enhancer_file(&state, &pid, &removed));
    save_index(app, &index)?;

    if is_current {
        regenerate_runtime(app)?;
        crate::core::reload_runtime(app).await?;
    }
    Ok(())
}

/// 启用/停用增强项。
pub async fn toggle_enhancer(
    app: &AppHandle,
    pid: String,
    eid: String,
    enabled: bool,
) -> Result<(), String> {
    let mut index = load_index(app);
    let slot = index
        .iter_mut()
        .find(|p| p.id == pid)
        .ok_or_else(|| format!("订阅不存在: {pid}"))?;
    let e = slot
        .enhancers
        .iter_mut()
        .find(|e| e.id == eid)
        .ok_or_else(|| format!("增强项不存在: {eid}"))?;
    e.enabled = enabled;
    let is_current = slot.current;
    save_index(app, &index)?;

    if is_current {
        regenerate_runtime(app)?;
        crate::core::reload_runtime(app).await?;
    }
    Ok(())
}

/// 重排序增强项。
pub async fn reorder_enhancers(
    app: &AppHandle,
    pid: String,
    eids: Vec<String>,
) -> Result<(), String> {
    let mut index = load_index(app);
    let slot = index
        .iter_mut()
        .find(|p| p.id == pid)
        .ok_or_else(|| format!("订阅不存在: {pid}"))?;

    // 验证所有 ID 都存在
    if eids.len() != slot.enhancers.len() {
        return Err("增强项数量不匹配".into());
    }

    // 验证 ID 唯一性
    let mut unique_ids = std::collections::HashSet::new();
    for eid in &eids {
        if !unique_ids.insert(eid) {
            return Err(format!("增强项 ID 重复: {eid}"));
        }
        if !slot.enhancers.iter().any(|e| &e.id == eid) {
            return Err(format!("增强项不存在: {eid}"));
        }
    }

    // 按新顺序重排
    let mut reordered = Vec::with_capacity(eids.len());
    for eid in &eids {
        if let Some(enh) = slot.enhancers.iter().find(|e| &e.id == eid).cloned() {
            reordered.push(enh);
        }
    }
    slot.enhancers = reordered;
    let is_current = slot.current;
    save_index(app, &index)?;

    if is_current {
        regenerate_runtime(app)?;
        crate::core::reload_runtime(app).await?;
    }
    Ok(())
}

/// 极小 URL host 提取(避免为取名引入 url crate)。
mod url {
    pub fn host(url: &str) -> Option<&str> {
        let rest = url.split_once("//").map(|(_, r)| r).unwrap_or(url);
        let host_port = rest.split(['/', '?', '#']).next()?;
        let host = host_port.split('@').next_back()?.split(':').next()?;
        if host.is_empty() {
            None
        } else {
            Some(host)
        }
    }
}
