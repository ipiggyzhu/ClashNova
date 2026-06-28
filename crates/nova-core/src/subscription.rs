//! 订阅内容解析:支持 ① Clash YAML(取 `proxies` 数组) ② base64(URI 列表)
//! ③ 裸 URI 列表。URI 支持 `ss://` `vmess://` `trojan://` `vless://`,
//! 产物为对齐 Clash 习惯的 `serde_yaml::Value` mapping。

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use serde_yaml::{Mapping, Value};

use crate::CoreError;

/// 解析订阅内容为 Clash proxy mapping 列表(锁定契约 D)。
pub fn parse_subscription(content: &str) -> Result<Vec<Value>, CoreError> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err(CoreError::Empty);
    }

    // ① Clash YAML:mapping 且含 proxies 数组 → 透传
    if let Ok(Value::Mapping(map)) = serde_yaml::from_str::<Value>(trimmed) {
        if let Some(Value::Sequence(seq)) = map.get("proxies") {
            let nodes: Vec<Value> = seq.iter().filter(|v| v.is_mapping()).cloned().collect();
            if !nodes.is_empty() {
                return Ok(nodes);
            }
            return Err(CoreError::Empty);
        }
    }

    // ③ 裸 URI 列表;② 否则尝试整体 base64 → URI 列表
    let body = if trimmed.lines().any(|l| l.contains("://")) {
        trimmed.to_string()
    } else {
        let bytes = decode_b64(trimmed).map_err(|_| CoreError::UnrecognizedFormat)?;
        String::from_utf8(bytes).map_err(|_| CoreError::UnrecognizedFormat)?
    };

    let mut nodes = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(node) = parse_uri(line)? {
            nodes.push(node);
        }
    }
    if nodes.is_empty() {
        return Err(CoreError::Empty);
    }
    Ok(nodes)
}

/// 宽容地解码 base64:依次尝试标准/URL-safe、带/不带 padding。
fn decode_b64(s: &str) -> Result<Vec<u8>, CoreError> {
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    let mut last_err = None;
    for engine in [STANDARD, URL_SAFE, STANDARD_NO_PAD, URL_SAFE_NO_PAD] {
        match engine.decode(cleaned.as_bytes()) {
            Ok(bytes) => return Ok(bytes),
            Err(e) => last_err = Some(e),
        }
    }
    Err(CoreError::Base64(last_err.expect("至少尝试过一个引擎")))
}

/// 解析单条代理 URI;不认识的 scheme 返回 `Ok(None)`(静默跳过)。
fn parse_uri(uri: &str) -> Result<Option<Value>, CoreError> {
    if let Some(rest) = uri.strip_prefix("ss://") {
        return parse_ss(rest).map(Some);
    }
    if let Some(rest) = uri.strip_prefix("vmess://") {
        return parse_vmess(rest).map(Some);
    }
    if let Some(rest) = uri.strip_prefix("trojan://") {
        return parse_trojan(rest).map(Some);
    }
    if let Some(rest) = uri.strip_prefix("vless://") {
        return parse_vless(rest).map(Some);
    }
    Ok(None)
}

// ---------- 通用小件 ----------

/// 摘下 `#fragment`(节点名,百分号解码),返回 (剩余, name)。
fn take_fragment(s: &str) -> (&str, Option<String>) {
    match s.split_once('#') {
        Some((body, frag)) => (body, Some(percent_decode(frag))),
        None => (s, None),
    }
}

/// 摘下 `?query`,返回 (剩余, 键值对列表;键值均已百分号解码)。
fn take_query(s: &str) -> (&str, Vec<(String, String)>) {
    match s.split_once('?') {
        Some((body, query)) => {
            let pairs = query
                .split('&')
                .filter(|kv| !kv.is_empty())
                .map(|kv| match kv.split_once('=') {
                    Some((k, v)) => (percent_decode(k), percent_decode(v)),
                    None => (percent_decode(kv), String::new()),
                })
                .collect();
            (body, pairs)
        }
        None => (s, Vec::new()),
    }
}

fn percent_decode(s: &str) -> String {
    urlencoding::decode(s)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| s.to_string())
}

/// 解析 `host:port`(容忍 `[v6]:port` 与尾部 `/`)。
fn parse_host_port(s: &str, uri_kind: &str) -> Result<(String, u16), CoreError> {
    let s = s.trim_end_matches('/');
    let (host, port) = s
        .rsplit_once(':')
        .ok_or_else(|| CoreError::InvalidUri(format!("{uri_kind}: 缺少端口: {s}")))?;
    let port: u16 = port
        .parse()
        .map_err(|_| CoreError::InvalidUri(format!("{uri_kind}: 端口非法: {port}")))?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return Err(CoreError::InvalidUri(format!("{uri_kind}: 缺少主机: {s}")));
    }
    Ok((host.to_string(), port))
}

fn kv(m: &mut Mapping, key: &str, val: Value) {
    m.insert(Value::String(key.to_string()), val);
}

fn query_get<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

// ---------- 各 scheme ----------

/// ss://base64(method:password)@host:port[/?plugin=...][#name](SIP002)
/// 或旧式 ss://base64(method:password@host:port)[#name]
fn parse_ss(rest: &str) -> Result<Value, CoreError> {
    let (rest, name) = take_fragment(rest);
    let (rest, query) = take_query(rest);

    let (method, password, host, port) = if let Some((userinfo, host_port)) = rest.rsplit_once('@')
    {
        // SIP002:userinfo 为 base64(method:password),容忍未编码的明文
        let decoded = decode_b64(userinfo)
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .filter(|s| s.contains(':'))
            .unwrap_or_else(|| percent_decode(userinfo));
        let (method, password) = decoded
            .split_once(':')
            .ok_or_else(|| CoreError::InvalidUri(format!("ss: userinfo 非法: {userinfo}")))?;
        let (host, port) = parse_host_port(host_port, "ss")?;
        (method.to_string(), password.to_string(), host, port)
    } else {
        // 旧式:整体 base64(method:password@host:port)
        let decoded = String::from_utf8(decode_b64(rest)?)
            .map_err(|_| CoreError::InvalidUri(format!("ss: base64 内容非 UTF-8: {rest}")))?;
        let (userinfo, host_port) = decoded
            .rsplit_once('@')
            .ok_or_else(|| CoreError::InvalidUri(format!("ss: 缺少 @: {decoded}")))?;
        let (method, password) = userinfo
            .split_once(':')
            .ok_or_else(|| CoreError::InvalidUri(format!("ss: userinfo 非法: {userinfo}")))?;
        let (host, port) = parse_host_port(host_port, "ss")?;
        (method.to_string(), password.to_string(), host, port)
    };

    let mut m = Mapping::new();
    kv(
        &mut m,
        "name",
        Value::String(name.unwrap_or_else(|| format!("{host}:{port}"))),
    );
    kv(&mut m, "type", Value::String("ss".into()));
    kv(&mut m, "server", Value::String(host));
    kv(&mut m, "port", Value::from(port as u64));
    kv(&mut m, "cipher", Value::String(method));
    kv(&mut m, "password", Value::String(password));
    kv(&mut m, "udp", Value::Bool(true));

    if let Some(plugin) = query_get(&query, "plugin") {
        apply_ss_plugin(&mut m, plugin);
    }
    Ok(Value::Mapping(m))
}

/// 解析 SIP002 plugin 参数,如 `obfs-local;obfs=http;obfs-host=www.bing.com`。
fn apply_ss_plugin(m: &mut Mapping, plugin: &str) {
    let mut parts = plugin.split(';');
    let Some(raw_name) = parts.next().filter(|p| !p.is_empty()) else {
        return;
    };
    let is_obfs = matches!(raw_name, "obfs-local" | "simple-obfs" | "obfs");
    let plugin_name = if is_obfs { "obfs" } else { raw_name };

    let mut opts = Mapping::new();
    for part in parts {
        if part.is_empty() {
            continue;
        }
        match part.split_once('=') {
            Some((k, v)) => {
                let key = match (is_obfs, k) {
                    (true, "obfs") => "mode",
                    (true, "obfs-host") => "host",
                    _ => k,
                };
                kv(&mut opts, key, Value::String(v.to_string()));
            }
            None => kv(&mut opts, part, Value::Bool(true)),
        }
    }
    kv(m, "plugin", Value::String(plugin_name.to_string()));
    if !opts.is_empty() {
        kv(m, "plugin-opts", Value::Mapping(opts));
    }
}

/// vmess://base64(JSON{v,ps,add,port,id,aid,net,type,host,path,tls})
fn parse_vmess(rest: &str) -> Result<Value, CoreError> {
    let bytes = decode_b64(rest)?;
    let json: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| CoreError::InvalidUri(format!("vmess: JSON 非法: {e}")))?;

    let str_of = |key: &str| -> Option<String> {
        match json.get(key) {
            Some(serde_json::Value::String(s)) if !s.is_empty() => Some(s.clone()),
            Some(serde_json::Value::Number(n)) => Some(n.to_string()),
            _ => None,
        }
    };
    let num_of = |key: &str| -> Option<u64> {
        match json.get(key) {
            Some(serde_json::Value::Number(n)) => n.as_u64(),
            Some(serde_json::Value::String(s)) => s.parse().ok(),
            _ => None,
        }
    };

    let server = str_of("add").ok_or_else(|| CoreError::InvalidUri("vmess: 缺少 add".into()))?;
    let port = num_of("port")
        .and_then(|p| u16::try_from(p).ok())
        .ok_or_else(|| CoreError::InvalidUri("vmess: 端口非法".into()))?;
    let uuid = str_of("id").ok_or_else(|| CoreError::InvalidUri("vmess: 缺少 id".into()))?;

    let mut m = Mapping::new();
    kv(
        &mut m,
        "name",
        Value::String(str_of("ps").unwrap_or_else(|| format!("{server}:{port}"))),
    );
    kv(&mut m, "type", Value::String("vmess".into()));
    kv(&mut m, "server", Value::String(server.clone()));
    kv(&mut m, "port", Value::from(port as u64));
    kv(&mut m, "uuid", Value::String(uuid));
    kv(&mut m, "alterId", Value::from(num_of("aid").unwrap_or(0)));
    kv(
        &mut m,
        "cipher",
        Value::String(str_of("scy").unwrap_or_else(|| "auto".into())),
    );
    kv(&mut m, "udp", Value::Bool(true));

    let tls = matches!(json.get("tls"), Some(serde_json::Value::String(s)) if s == "tls")
        || matches!(json.get("tls"), Some(serde_json::Value::Bool(true)));
    if tls {
        kv(&mut m, "tls", Value::Bool(true));
    }

    let network = str_of("net").unwrap_or_else(|| "tcp".into());
    if network != "tcp" {
        kv(&mut m, "network", Value::String(network.clone()));
    }
    if network == "ws" {
        let mut ws = Mapping::new();
        kv(
            &mut ws,
            "path",
            Value::String(str_of("path").unwrap_or_else(|| "/".into())),
        );
        if let Some(host) = str_of("host") {
            let mut headers = Mapping::new();
            kv(&mut headers, "Host", Value::String(host));
            kv(&mut ws, "headers", Value::Mapping(headers));
        }
        kv(&mut m, "ws-opts", Value::Mapping(ws));
    }
    Ok(Value::Mapping(m))
}

/// trojan://password@host:port?sni=x[&allowInsecure=1]#name
fn parse_trojan(rest: &str) -> Result<Value, CoreError> {
    let (rest, name) = take_fragment(rest);
    let (rest, query) = take_query(rest);
    let (userinfo, host_port) = rest
        .rsplit_once('@')
        .ok_or_else(|| CoreError::InvalidUri(format!("trojan: 缺少 @: {rest}")))?;
    let (host, port) = parse_host_port(host_port, "trojan")?;

    let mut m = Mapping::new();
    kv(
        &mut m,
        "name",
        Value::String(name.unwrap_or_else(|| format!("{host}:{port}"))),
    );
    kv(&mut m, "type", Value::String("trojan".into()));
    kv(&mut m, "server", Value::String(host));
    kv(&mut m, "port", Value::from(port as u64));
    kv(&mut m, "password", Value::String(percent_decode(userinfo)));
    if let Some(sni) = query_get(&query, "sni") {
        kv(&mut m, "sni", Value::String(sni.to_string()));
    }
    if matches!(query_get(&query, "allowInsecure"), Some("1") | Some("true")) {
        kv(&mut m, "skip-cert-verify", Value::Bool(true));
    }
    kv(&mut m, "udp", Value::Bool(true));
    Ok(Value::Mapping(m))
}

/// vless://uuid@host:port?type=ws&path=/x&security=tls[&sni=x&host=x]#name
fn parse_vless(rest: &str) -> Result<Value, CoreError> {
    let (rest, name) = take_fragment(rest);
    let (rest, query) = take_query(rest);
    let (userinfo, host_port) = rest
        .rsplit_once('@')
        .ok_or_else(|| CoreError::InvalidUri(format!("vless: 缺少 @: {rest}")))?;
    let (host, port) = parse_host_port(host_port, "vless")?;

    let mut m = Mapping::new();
    kv(
        &mut m,
        "name",
        Value::String(name.unwrap_or_else(|| format!("{host}:{port}"))),
    );
    kv(&mut m, "type", Value::String("vless".into()));
    kv(&mut m, "server", Value::String(host));
    kv(&mut m, "port", Value::from(port as u64));
    kv(&mut m, "uuid", Value::String(percent_decode(userinfo)));

    let network = query_get(&query, "type").unwrap_or("tcp").to_string();
    if network != "tcp" {
        kv(&mut m, "network", Value::String(network.clone()));
    }
    if matches!(query_get(&query, "security"), Some("tls") | Some("reality")) {
        kv(&mut m, "tls", Value::Bool(true));
    }
    if let Some(sni) = query_get(&query, "sni") {
        kv(&mut m, "servername", Value::String(sni.to_string()));
    }
    if network == "ws" {
        let mut ws = Mapping::new();
        kv(
            &mut ws,
            "path",
            Value::String(query_get(&query, "path").unwrap_or("/").to_string()),
        );
        if let Some(host_header) = query_get(&query, "host") {
            let mut headers = Mapping::new();
            kv(&mut headers, "Host", Value::String(host_header.to_string()));
            kv(&mut ws, "headers", Value::Mapping(headers));
        }
        kv(&mut m, "ws-opts", Value::Mapping(ws));
    }
    kv(&mut m, "udp", Value::Bool(true));
    Ok(Value::Mapping(m))
}

#[cfg(test)]
mod tests {
    use super::parse_subscription;
    use serde_yaml::Value;

    fn yaml(s: &str) -> Value {
        serde_yaml::from_str(s).expect("测试用 YAML 必须合法")
    }

    #[test]
    fn clash_yaml_透传_proxies_数组() {
        let content = r#"
mixed-port: 7890
proxies:
  - name: 直连节点
    type: ss
    server: 1.2.3.4
    port: 443
    cipher: aes-128-gcm
    password: pw
  - name: 备用
    type: trojan
    server: 5.6.7.8
    port: 8443
    password: pw2
rules:
  - MATCH,DIRECT
"#;
        let nodes = parse_subscription(content).expect("Clash YAML 应可解析");
        assert_eq!(nodes.len(), 2);
        assert_eq!(
            nodes[0].get("name"),
            Some(&Value::String("直连节点".into()))
        );
        assert_eq!(nodes[1].get("type"), Some(&Value::String("trojan".into())));
        assert_eq!(nodes[1].get("port"), Some(&Value::from(8443u64)));
    }

    #[test]
    fn base64_订阅解码为_uri_列表() {
        // base64("trojan://t0ken@a.example.com:443#A\nvless://3f6c5d8e-...@b.example.com:443?security=tls#B")
        let content = "dHJvamFuOi8vdDBrZW5AYS5leGFtcGxlLmNvbTo0NDMjQQp2bGVzczovLzNmNmM1ZDhlLTdhMmItNGMxZC05ZTBmLTExMjIzMzQ0NTU2NkBiLmV4YW1wbGUuY29tOjQ0Mz9zZWN1cml0eT10bHMjQg==";
        let nodes = parse_subscription(content).expect("base64 URI 列表应可解析");
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].get("name"), Some(&Value::String("A".into())));
        assert_eq!(nodes[0].get("type"), Some(&Value::String("trojan".into())));
        assert_eq!(nodes[1].get("name"), Some(&Value::String("B".into())));
        assert_eq!(nodes[1].get("type"), Some(&Value::String("vless".into())));
        assert_eq!(nodes[1].get("tls"), Some(&Value::Bool(true)));
    }

    #[test]
    fn ss_uri_sip002_含_plugin_与旧式整体_base64() {
        // SIP002: base64("aes-256-gcm:passw0rd")@host:port/?plugin=obfs-local;obfs=http;obfs-host=www.bing.com#香港 SS
        let sip002 = "ss://YWVzLTI1Ni1nY206cGFzc3cwcmQ@hk.example.com:8388/?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dwww.bing.com#%E9%A6%99%E6%B8%AF%20SS";
        // 旧式: ss://base64("rc4-md5:legacy@old.example.com:8400")
        let legacy = "ss://cmM0LW1kNTpsZWdhY3lAb2xkLmV4YW1wbGUuY29tOjg0MDA=#%E6%97%A7%E5%BC%8F";
        let nodes = parse_subscription(&format!("{sip002}\n{legacy}")).expect("ss URI 应可解析");
        assert_eq!(nodes.len(), 2);
        assert_eq!(
            nodes[0],
            yaml(
                r#"
name: 香港 SS
type: ss
server: hk.example.com
port: 8388
cipher: aes-256-gcm
password: passw0rd
udp: true
plugin: obfs
plugin-opts:
  mode: http
  host: www.bing.com
"#
            )
        );
        assert_eq!(
            nodes[1],
            yaml(
                r#"
name: 旧式
type: ss
server: old.example.com
port: 8400
cipher: rc4-md5
password: legacy
udp: true
"#
            )
        );
    }

    #[test]
    fn vmess_base64_json() {
        // base64(JSON{v,ps,add,port,id,aid,net,type,host,path,tls})
        let uri = "vmess://eyJ2IjoiMiIsInBzIjoi5Lic5LqsIFZNZXNzIiwiYWRkIjoianAuZXhhbXBsZS5jb20iLCJwb3J0IjoiNDQzIiwiaWQiOiIyM2FkNmIxMC04ZDFhLTQwZjctOGFkMC1lM2UzNWNkMzgyOTciLCJhaWQiOiIwIiwibmV0Ijoid3MiLCJ0eXBlIjoibm9uZSIsImhvc3QiOiJqcC5leGFtcGxlLmNvbSIsInBhdGgiOiIvd3MiLCJ0bHMiOiJ0bHMifQ==";
        let nodes = parse_subscription(uri).expect("vmess URI 应可解析");
        assert_eq!(nodes.len(), 1);
        assert_eq!(
            nodes[0],
            yaml(
                r#"
name: 东京 VMess
type: vmess
server: jp.example.com
port: 443
uuid: 23ad6b10-8d1a-40f7-8ad0-e3e35cd38297
alterId: 0
cipher: auto
udp: true
tls: true
network: ws
ws-opts:
  path: /ws
  headers:
    Host: jp.example.com
"#
            )
        );
    }

    #[test]
    fn trojan_uri() {
        let uri = "trojan://secret123@us.example.com:443?sni=cdn.example.com&allowInsecure=1#%E7%BE%8E%E5%9B%BD%20Trojan";
        let nodes = parse_subscription(uri).expect("trojan URI 应可解析");
        assert_eq!(nodes.len(), 1);
        assert_eq!(
            nodes[0],
            yaml(
                r#"
name: 美国 Trojan
type: trojan
server: us.example.com
port: 443
password: secret123
sni: cdn.example.com
skip-cert-verify: true
udp: true
"#
            )
        );
    }

    #[test]
    fn vless_uri() {
        let uri = "vless://3f6c5d8e-7a2b-4c1d-9e0f-112233445566@hk.example.com:2053?type=ws&security=tls&sni=hk.example.com&host=cdn.hk.example.com&path=%2Fvless#HK%20VLESS";
        let nodes = parse_subscription(uri).expect("vless URI 应可解析");
        assert_eq!(nodes.len(), 1);
        assert_eq!(
            nodes[0],
            yaml(
                r#"
name: HK VLESS
type: vless
server: hk.example.com
port: 2053
uuid: 3f6c5d8e-7a2b-4c1d-9e0f-112233445566
network: ws
tls: true
servername: hk.example.com
ws-opts:
  path: /vless
  headers:
    Host: cdn.hk.example.com
udp: true
"#
            )
        );
    }
}
