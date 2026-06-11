//! 订阅 Profile 管理:下载/解析/落盘/索引/运行时配置生成。

use std::fs;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::state::{atomic_write, now_millis, AppState};

const USER_AGENT: &str = "ClashNova/2.0 clash-verge-compatible clash-meta";

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

/// 读取 profiles.json 索引(缺失时返回空表)。
pub fn load_index(app: &AppHandle) -> Vec<ProfileMeta> {
    let state = app.state::<AppState>();
    let path = state.dirs.profiles_index();
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
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
    let mut root = serde_yaml::Mapping::new();
    root.insert(
        serde_yaml::Value::from("proxies"),
        serde_yaml::Value::Sequence(proxies),
    );
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
        .map(|f| f.trim_end_matches(".yaml").trim_end_matches(".yml").to_string());

    let raw = resp.text().await.map_err(|e| format!("读取订阅失败: {e}"))?;
    let content = normalize_content(&raw)?;

    let name = disp_name
        .filter(|s| !s.is_empty())
        .or_else(|| {
            url::host(&url).map(|h| h.to_string())
        })
        .unwrap_or_else(|| "新订阅".into());

    let id = base36(now_millis());
    let state = app.state::<AppState>();
    atomic_write(&state.dirs.profile_file(&id), content.as_bytes())?;

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
        enhancers: Vec::new(),
    };
    index.push(meta.clone());
    save_index(app, &index)?;
    if first {
        regenerate_runtime(app)?;
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
    let raw = resp.text().await.map_err(|e| format!("读取订阅失败: {e}"))?;
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
    for e in meta.enhancers.iter().filter(|e| e.enabled) {
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
