use serde::{Deserialize, Serialize};

pub const DEFAULT_USER_AGENT: &str = "ClashNova/2.0 clash-verge-compatible clash-meta";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadProxy {
    #[default]
    System,
    Direct,
    Core,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProfileDownloadOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    pub timeout_sec: u32,
    pub proxy: DownloadProxy,
    pub update_interval_from_header: bool,
}

impl Default for ProfileDownloadOptions {
    fn default() -> Self {
        Self {
            user_agent: None,
            timeout_sec: 30,
            proxy: DownloadProxy::System,
            update_interval_from_header: true,
        }
    }
}

impl ProfileDownloadOptions {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=300).contains(&self.timeout_sec) {
            return Err("下载超时需要在 1–300 秒之间".into());
        }
        if let Some(agent) = &self.user_agent {
            if agent.len() > 512 || reqwest::header::HeaderValue::from_str(agent).is_err() {
                return Err("User-Agent 需要是不含换行的有效请求头，最多 512 字节".into());
            }
        }
        Ok(())
    }

    pub fn user_agent(&self) -> &str {
        self.user_agent
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or(DEFAULT_USER_AGENT)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSource {
    pub url: String,
    pub name: Option<String>,
}

fn http_url(value: &str) -> Result<String, String> {
    if value.chars().any(char::is_whitespace) {
        return Err("订阅 URL 不能包含空白字符".into());
    }
    let parsed = reqwest::Url::parse(value).map_err(|_| "订阅 URL 格式无效")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("订阅下载地址仅支持 http:// 或 https://".into());
    }
    Ok(parsed.into())
}

/// 分享协议只解码外层查询一次；原始订阅鉴权参数保持不变。
pub fn resolve_import_url(value: &str) -> Result<ImportSource, String> {
    let value = value.trim();
    let parsed = reqwest::Url::parse(value).map_err(|_| "订阅链接格式无效")?;
    if matches!(parsed.scheme(), "http" | "https") {
        return Ok(ImportSource {
            url: http_url(value)?,
            name: None,
        });
    }
    if !matches!(parsed.scheme(), "clash" | "clash-verge" | "clashnova")
        || parsed.host_str() != Some("install-config")
        || !matches!(parsed.path(), "" | "/")
    {
        return Err("不支持的订阅协议，请使用 clash://install-config?url=…".into());
    }
    let mut source = None;
    let mut name = None;
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "url" if source.is_none() => source = Some(value.into_owned()),
            "url" => return Err("协议链接包含重复的 url 参数".into()),
            "name" => {
                let value = value.trim();
                if !value.is_empty() {
                    if value.chars().any(char::is_control) || value.chars().count() > 128 {
                        return Err("订阅名称过长或包含控制字符".into());
                    }
                    name = Some(value.to_string());
                }
            }
            _ => {}
        }
    }
    let source = source.ok_or("协议链接缺少 url 参数")?;
    Ok(ImportSource {
        url: http_url(&source)?,
        name,
    })
}

/// Clash 的 profile-update-interval 响应头使用小时；界面和索引使用分钟。
pub fn header_update_minutes(value: Option<&str>) -> Option<u32> {
    let hours = value?.trim().parse::<u32>().ok()?;
    hours.checked_mul(60).filter(|minutes| *minutes > 0)
}

#[cfg(any(windows, test))]
fn wildcard_matches(pattern: &str, value: &str) -> bool {
    let (pattern, value) = (pattern.as_bytes(), value.as_bytes());
    let (mut p, mut v, mut star, mut retry) = (0, 0, None, 0);
    while v < value.len() {
        if p < pattern.len() && pattern[p] == value[v] {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            retry = v;
        } else if let Some(index) = star {
            retry += 1;
            v = retry;
            p = index + 1;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

#[cfg(any(windows, test))]
pub fn system_proxy_bypassed(url: &reqwest::Url, bypass: &str) -> bool {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    bypass.split(';').map(str::trim).any(|pattern| {
        let pattern = pattern.to_ascii_lowercase();
        if pattern == "<local>" {
            !host.contains('.') && !host.contains(':')
        } else {
            !pattern.is_empty() && wildcard_matches(&pattern, &host)
        }
    })
}

/// Windows 支持单地址和 http=…;https=… 形式；这里不执行 PAC 脚本。
#[cfg(any(windows, test))]
pub fn system_proxy_routes(
    server: &str,
) -> Result<std::collections::HashMap<String, String>, String> {
    let endpoint = |value: &str| -> Result<String, String> {
        let value = value.trim();
        let value = if value.contains("://") {
            value.to_string()
        } else {
            format!("http://{value}")
        };
        let url = reqwest::Url::parse(&value).map_err(|_| "Windows 系统代理地址无效")?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err("下载只支持 HTTP(S) 手动代理；SOCKS/PAC 请选通过 ClashNova 内核".into());
        }
        Ok(value)
    };
    let mut routes = std::collections::HashMap::new();
    if server.contains('=') {
        for part in server.split(';') {
            if let Some((scheme, value)) = part.split_once('=') {
                let scheme = scheme.trim().to_ascii_lowercase();
                if matches!(scheme.as_str(), "http" | "https") {
                    routes.insert(scheme, endpoint(value)?);
                }
            }
        }
    } else {
        let value = endpoint(server)?;
        routes.insert("http".into(), value.clone());
        routes.insert("https".into(), value);
    }
    if routes.is_empty() {
        return Err("Windows 系统代理没有配置 HTTP(S) 地址".into());
    }
    Ok(routes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_scheme_decodes_once_and_keeps_signed_query() {
        for scheme in ["clash", "clash-verge", "clashnova"] {
            let value = format!("{scheme}://install-config?url=https%3A%2F%2Fsubscription.example.invalid%2Fsub%3Ftoken%3Da%252Bb%26target%3Dclash&name=%E6%B5%8B%E8%AF%95");
            let source = resolve_import_url(&value).unwrap();
            assert_eq!(
                source.url,
                "https://subscription.example.invalid/sub?token=a%2Bb&target=clash"
            );
            assert_eq!(source.name.as_deref(), Some("测试"));
        }
    }

    #[test]
    fn invalid_and_nested_protocols_are_rejected() {
        for value in [
            "file:///tmp/profile",
            "clash://run?url=https://example.invalid",
            "clash://install-config",
            "clash://install-config?url=file:///tmp/profile",
            "clash://install-config?url=clash://install-config",
            "clash://install-config?url=https://one.invalid&url=https://two.invalid",
            "https://example.invalid/a b",
        ] {
            assert!(
                resolve_import_url(value).is_err(),
                "accepted invalid protocol"
            );
        }
    }

    #[test]
    fn old_profiles_use_compatible_download_defaults() {
        let value: ProfileDownloadOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(value, ProfileDownloadOptions::default());
        assert_eq!(value.user_agent(), DEFAULT_USER_AGENT);
        assert!(value.validate().is_ok());
    }

    #[test]
    fn download_options_reject_header_injection_and_unbounded_timeout() {
        let mut value = ProfileDownloadOptions::default();
        value.user_agent = Some("agent\r\nAuthorization: fake".into());
        assert!(value.validate().is_err());
        value.user_agent = Some("ClashNova Custom/1.0".into());
        value.timeout_sec = 0;
        assert!(value.validate().is_err());
        value.timeout_sec = 301;
        assert!(value.validate().is_err());
        value.timeout_sec = 60;
        assert!(value.validate().is_ok());
    }

    #[test]
    fn server_update_interval_is_hours_and_does_not_overflow() {
        assert_eq!(header_update_minutes(Some(" 12 ")), Some(720));
        for input in [
            None,
            Some("0"),
            Some("-1"),
            Some("4294967295"),
            Some("invalid"),
        ] {
            assert_eq!(header_update_minutes(input), None);
        }
    }

    #[test]
    fn windows_proxy_routes_preserve_per_scheme_addresses() {
        let routes =
            system_proxy_routes("http=127.0.0.1:8000; https=proxy.example.invalid:8001").unwrap();
        assert_eq!(routes["http"], "http://127.0.0.1:8000");
        assert_eq!(routes["https"], "http://proxy.example.invalid:8001");
        let routes = system_proxy_routes("[::1]:7897").unwrap();
        assert_eq!(routes["http"], routes["https"]);
        assert!(system_proxy_routes("socks=127.0.0.1:1080").is_err());
    }

    #[test]
    fn windows_proxy_bypass_honors_local_wildcards_and_case() {
        let bypass = "<local>;*.example.invalid;192.168.*;EXACT.INVALID";
        for value in [
            "http://localhost",
            "https://api.example.invalid",
            "http://192.168.1.1",
            "https://exact.invalid",
        ] {
            assert!(system_proxy_bypassed(
                &reqwest::Url::parse(value).unwrap(),
                bypass
            ));
        }
        for value in [
            "http://example.invalid",
            "http://public.invalid",
            "http://notexact.invalid",
        ] {
            assert!(!system_proxy_bypassed(
                &reqwest::Url::parse(value).unwrap(),
                bypass
            ));
        }
    }
}
