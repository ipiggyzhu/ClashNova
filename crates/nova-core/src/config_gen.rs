//! 运行时配置生成:profile YAML + 运行时覆写 → 可直接交给
//! `mihomo -f runtime.yaml` 的 YAML 文本。

use serde_yaml::{Mapping, Value};

use crate::merge::deep_merge;
use crate::CoreError;

/// 运行时覆写项(锁定契约 D,字段不得擅改)。
pub struct RuntimeOverrides {
    pub mixed_port: u16,
    pub external_controller: String,
    pub secret: String,
    pub mode: String,
    pub allow_lan: bool,
    pub ipv6: bool,
    pub log_level: String,
    pub tun_enable: bool,
    /// DNS 覆写 YAML 片段(dns: 段的子键);空串表示不覆写(M2)。
    pub dns_override: String,
    /// hosts 覆写,每行 `域名 IP`;空串表示不覆写(M2)。
    pub hosts: String,
    /* ---- DNS 高级配置 ---- */
    pub enable_dns: bool,
    pub dns_listen: String,
    pub dns_enhanced_mode: String,
    pub fake_ip_range: String,
    pub fake_ip_filter_mode: String,
    pub ipv6_dns: bool,
    pub prefer_h3: bool,
    pub respect_rules: bool,
    pub use_hosts: bool,
    pub use_system_hosts: bool,
}

fn normalize_dns_override(raw: &str) -> Result<Value, CoreError> {
    let value: Value = serde_yaml::from_str(raw)?;
    if let Some(dns) = value.as_mapping().and_then(|map| map.get("dns")) {
        if dns.is_mapping() {
            return Ok(dns.clone());
        }
        return Err(CoreError::UnrecognizedFormat);
    }
    Ok(value)
}

fn ensure_tun_dns(doc: &mut Value, ov: &RuntimeOverrides) {
    let Some(map) = doc.as_mapping_mut() else {
        return;
    };
    let dns_key = Value::String("dns".into());
    if !map
        .get(&dns_key)
        .map(Value::is_mapping)
        .unwrap_or(false)
    {
        map.insert(dns_key.clone(), Value::Mapping(Mapping::new()));
    }
    let Some(dns) = map.get_mut(&dns_key).and_then(Value::as_mapping_mut) else {
        return;
    };

    dns.insert(Value::String("enable".into()), Value::Bool(true));
    dns.entry(Value::String("listen".into()))
        .or_insert_with(|| Value::String(ov.dns_listen.clone()));
    dns.entry(Value::String("ipv6".into()))
        .or_insert(Value::Bool(ov.ipv6));

    let mode_key = Value::String("enhanced-mode".into());
    let enhanced_mode = dns
        .get(&mode_key)
        .and_then(Value::as_str)
        .filter(|mode| !mode.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            let mode = if ov.dns_enhanced_mode.trim().is_empty() {
                "fake-ip".to_string()
            } else {
                ov.dns_enhanced_mode.clone()
            };
            dns.insert(mode_key, Value::String(mode.clone()));
            mode
        });

    if enhanced_mode == "fake-ip" {
        dns.entry(Value::String("fake-ip-range".into()))
            .or_insert_with(|| Value::String(ov.fake_ip_range.clone()));
        dns.entry(Value::String("fake-ip-filter-mode".into()))
            .or_insert_with(|| Value::String(ov.fake_ip_filter_mode.clone()));
    }
}

/// 解析 profile YAML 并应用覆写,序列化回 YAML(锁定契约 D)。
///
/// - 覆写 `mixed-port` / `external-controller` / `secret` / `mode` /
///   `allow-lan` / `ipv6` / `log-level`;
/// - `tun_enable == true` 时深合并
///   `tun: {enable: true, stack: gvisor, auto-route: true, auto-detect-interface: true}`;
/// - `tun_enable == false` 且 profile 自带 `tun` 段时强制 `tun.enable: false`
///   (防止 profile 私带 TUN 劫持开关);
/// - profile 其余内容(proxies/proxy-groups/rules/dns 等)原样保留。
pub fn build_runtime_config(profile_yaml: &str, ov: &RuntimeOverrides) -> Result<String, CoreError> {
    let mut doc: Value = if profile_yaml.trim().is_empty() {
        Value::Mapping(Mapping::new())
    } else {
        serde_yaml::from_str(profile_yaml)?
    };
    if doc.is_null() {
        doc = Value::Mapping(Mapping::new());
    }
    let map = doc
        .as_mapping_mut()
        .ok_or(CoreError::UnrecognizedFormat)?;

    let mut set = |key: &str, val: Value| {
        map.insert(Value::String(key.to_string()), val);
    };
    set("mixed-port", Value::from(ov.mixed_port as u64));
    set("external-controller", Value::String(ov.external_controller.clone()));
    set("secret", Value::String(ov.secret.clone()));
    set("mode", Value::String(ov.mode.clone()));
    set("allow-lan", Value::Bool(ov.allow_lan));
    set("ipv6", Value::Bool(ov.ipv6));
    set("log-level", Value::String(ov.log_level.clone()));
    set("find-process-mode", Value::String("always".into()));

    if ov.tun_enable {
        let patch: Value = serde_yaml::from_str(
            "tun:\n  enable: true\n  stack: gvisor\n  auto-route: true\n  auto-detect-interface: true\n",
        )?;
        deep_merge(&mut doc, &patch);
    } else if let Some(tun) = doc
        .as_mapping_mut()
        .and_then(|m| m.get_mut("tun"))
        .and_then(Value::as_mapping_mut)
    {
        tun.insert(Value::String("enable".into()), Value::Bool(false));
    }

    // DNS 高级配置:根据用户设置生成 DNS 段
    if ov.enable_dns {
        let mut dns_map = Mapping::new();
        dns_map.insert(Value::String("enable".into()), Value::Bool(true));
        dns_map.insert(Value::String("listen".into()), Value::String(ov.dns_listen.clone()));

        if !ov.dns_enhanced_mode.is_empty() {
            dns_map.insert(
                Value::String("enhanced-mode".into()),
                Value::String(ov.dns_enhanced_mode.clone()),
            );
            // Fake IP 配置
            if ov.dns_enhanced_mode == "fake-ip" {
                dns_map.insert(
                    Value::String("fake-ip-range".into()),
                    Value::String(ov.fake_ip_range.clone()),
                );
                dns_map.insert(
                    Value::String("fake-ip-filter-mode".into()),
                    Value::String(ov.fake_ip_filter_mode.clone()),
                );
            }
        }

        dns_map.insert(Value::String("ipv6".into()), Value::Bool(ov.ipv6_dns));
        dns_map.insert(Value::String("prefer-h3".into()), Value::Bool(ov.prefer_h3));
        dns_map.insert(Value::String("respect-rules".into()), Value::Bool(ov.respect_rules));
        dns_map.insert(Value::String("use-hosts".into()), Value::Bool(ov.use_hosts));
        dns_map.insert(Value::String("use-system-hosts".into()), Value::Bool(ov.use_system_hosts));

        let mut patch_map = Mapping::new();
        patch_map.insert(Value::String("dns".into()), Value::Mapping(dns_map));
        deep_merge(&mut doc, &Value::Mapping(patch_map));
    } else {
        let patch: Value = serde_yaml::from_str("dns:\n  enable: false\n")?;
        deep_merge(&mut doc, &patch);
    }

    // DNS 覆写:用户片段深合并进 dns: 段(无 enable 键时默认补 enable: true)
    if !ov.dns_override.trim().is_empty() {
        let dns_val = normalize_dns_override(&ov.dns_override)?;
        if !dns_val.is_mapping() {
            return Err(CoreError::UnrecognizedFormat);
        }
        let mut patch_map = Mapping::new();
        patch_map.insert(Value::String("dns".into()), dns_val);
        deep_merge(&mut doc, &Value::Mapping(patch_map));
        if let Some(dns) = doc
            .as_mapping_mut()
            .and_then(|m| m.get_mut("dns"))
            .and_then(Value::as_mapping_mut)
        {
            dns.entry(Value::String("enable".into()))
                .or_insert(Value::Bool(true));
        }
    }
    if !ov.enable_dns && !ov.tun_enable {
        if let Some(dns) = doc
            .as_mapping_mut()
            .and_then(|m| m.get_mut("dns"))
            .and_then(Value::as_mapping_mut)
        {
            dns.insert(Value::String("enable".into()), Value::Bool(false));
        }
    }

    if ov.tun_enable {
        ensure_tun_dns(&mut doc, ov);
    }

    // hosts 覆写:`域名 IP` 行 → hosts: {域名: IP};非法行跳过
    if !ov.hosts.trim().is_empty() {
        let mut hosts_map = Mapping::new();
        for line in ov.hosts.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut parts = line.split_whitespace();
            if let (Some(domain), Some(ip)) = (parts.next(), parts.next()) {
                hosts_map.insert(
                    Value::String(domain.to_string()),
                    Value::String(ip.to_string()),
                );
            }
        }
        if !hosts_map.is_empty() {
            let mut patch_map = Mapping::new();
            patch_map.insert(Value::String("hosts".into()), Value::Mapping(hosts_map));
            deep_merge(&mut doc, &Value::Mapping(patch_map));
        }
    }

    Ok(serde_yaml::to_string(&doc)?)
}

#[cfg(test)]
mod tests {
    use super::{build_runtime_config, RuntimeOverrides};
    use serde_yaml::Value;

    fn overrides(tun: bool) -> RuntimeOverrides {
        RuntimeOverrides {
            mixed_port: 7897,
            external_controller: "127.0.0.1:9097".into(),
            secret: "s3cret".into(),
            mode: "rule".into(),
            allow_lan: false,
            ipv6: false,
            log_level: "info".into(),
            tun_enable: tun,
            dns_override: String::new(),
            hosts: String::new(),
            enable_dns: false,
            dns_listen: "127.0.0.1:5335".into(),
            dns_enhanced_mode: String::new(),
            fake_ip_range: "198.18.0.1/16".into(),
            fake_ip_filter_mode: "blacklist".into(),
            ipv6_dns: false,
            prefer_h3: false,
            respect_rules: false,
            use_hosts: false,
            use_system_hosts: false,
        }
    }

    fn parse(out: &str) -> Value {
        serde_yaml::from_str(out).expect("输出必须可被 serde_yaml 反序列化")
    }

    #[test]
    fn 覆写端口_控制器_secret_mode_等() {
        let profile = r#"
port: 7890
mode: global
log-level: debug
find-process-mode: strict
allow-lan: true
ipv6: true
tun:
  enable: true
  stack: system
proxies: []
"#;
        let out = build_runtime_config(profile, &overrides(false)).expect("生成应成功");
        let doc = parse(&out);
        assert_eq!(doc.get("mixed-port"), Some(&Value::from(7897u64)));
        assert_eq!(
            doc.get("external-controller"),
            Some(&Value::String("127.0.0.1:9097".into()))
        );
        assert_eq!(doc.get("secret"), Some(&Value::String("s3cret".into())));
        assert_eq!(doc.get("mode"), Some(&Value::String("rule".into())));
        assert_eq!(doc.get("allow-lan"), Some(&Value::Bool(false)));
        assert_eq!(doc.get("ipv6"), Some(&Value::Bool(false)));
        assert_eq!(doc.get("log-level"), Some(&Value::String("info".into())));
        assert_eq!(
            doc.get("find-process-mode"),
            Some(&Value::String("always".into()))
        );
        // tun_enable=false 时,profile 私带的 tun.enable 必须被压成 false
        assert_eq!(
            doc.get("tun").and_then(|t| t.get("enable")),
            Some(&Value::Bool(false))
        );
    }

    #[test]
    fn tun_enable_时深合并_tun_段() {
        let profile = "mode: rule\ntun:\n  device: utun0\n  enable: false\n";
        let out = build_runtime_config(profile, &overrides(true)).expect("生成应成功");
        let doc = parse(&out);
        let tun = doc.get("tun").expect("tun 段应存在");
        assert_eq!(tun.get("enable"), Some(&Value::Bool(true)));
        assert_eq!(tun.get("stack"), Some(&Value::String("gvisor".into())));
        assert_eq!(tun.get("auto-route"), Some(&Value::Bool(true)));
        assert_eq!(
            tun.get("auto-detect-interface"),
            Some(&Value::Bool(true))
        );
        // profile 原有的 tun 子键保留
        assert_eq!(tun.get("device"), Some(&Value::String("utun0".into())));
        let dns = doc.get("dns").expect("TUN 应确保 dns 段存在");
        assert_eq!(dns.get("enable"), Some(&Value::Bool(true)));
        assert_eq!(
            dns.get("enhanced-mode"),
            Some(&Value::String("fake-ip".into()))
        );
        assert_eq!(
            dns.get("fake-ip-range"),
            Some(&Value::String("198.18.0.1/16".into()))
        );
    }

    #[test]
    fn 保留_proxies_groups_rules_且输出可反序列化() {
        let profile = r#"
proxies:
  - name: 节点A
    type: ss
    server: 1.2.3.4
    port: 443
    cipher: aes-128-gcm
    password: pw
proxy-groups:
  - name: 自动选择
    type: url-test
    proxies: [节点A]
rules:
  - DOMAIN-SUFFIX,example.com,自动选择
  - MATCH,DIRECT
"#;
        let out = build_runtime_config(profile, &overrides(false)).expect("生成应成功");
        let doc = parse(&out);
        let src = parse(profile);
        assert_eq!(doc.get("proxies"), src.get("proxies"));
        assert_eq!(doc.get("proxy-groups"), src.get("proxy-groups"));
        assert_eq!(doc.get("rules"), src.get("rules"));
        // 空 profile 也应能生成合法配置
        let empty = build_runtime_config("", &overrides(false)).expect("空 profile 应成功");
        assert_eq!(
            parse(&empty).get("mixed-port"),
            Some(&Value::from(7897u64))
        );
    }

    #[test]
    fn dns_覆写深合并并强制_enable() {
        let profile = "dns:\n  enable: false\n  listen: 0.0.0.0:53\nproxies: []\n";
        let mut ov = overrides(false);
        ov.enable_dns = true;
        ov.dns_override = "enhanced-mode: fake-ip\nnameserver:\n  - https://doh.pub/dns-query\n".into();
        let out = build_runtime_config(profile, &ov).expect("生成应成功");
        let doc = parse(&out);
        let dns = doc.get("dns").expect("dns 段应存在");
        assert_eq!(dns.get("enhanced-mode"), Some(&Value::String("fake-ip".into())));
        // enable_dns=true 时使用 ov.dns_listen，而不是 profile 中的值
        assert_eq!(dns.get("listen"), Some(&Value::String("127.0.0.1:5335".into())));
        // 高级 DNS 已启用时,覆写片段未显式给 enable 也会保持启用
        assert_eq!(dns.get("enable"), Some(&Value::Bool(true)));
        // 显式给 enable: true 则覆盖
        ov.dns_override = "enable: true\n".into();
        let doc2 = parse(&build_runtime_config(profile, &ov).expect("生成应成功"));
        assert_eq!(
            doc2.get("dns").and_then(|d| d.get("enable")),
            Some(&Value::Bool(true))
        );
        // 无 dns 段的 profile → 自动补 enable: true
        let doc3 = parse(&build_runtime_config("proxies: []\n", &ov).expect("生成应成功"));
        assert_eq!(
            doc3.get("dns").and_then(|d| d.get("enable")),
            Some(&Value::Bool(true))
        );
    }

    #[test]
    fn dns_高级关闭时强制_disable() {
        let profile = "dns:\n  enable: true\n  listen: 0.0.0.0:53\nproxies: []\n";
        let mut ov = overrides(false);
        ov.enable_dns = false;
        ov.dns_override = "enable: true\nnameserver:\n  - https://doh.pub/dns-query\n".into();
        let out = build_runtime_config(profile, &ov).expect("生成应成功");
        let doc = parse(&out);
        assert_eq!(
            doc.get("dns").and_then(|d| d.get("enable")),
            Some(&Value::Bool(false))
        );
    }

    #[test]
    fn dns_覆写贴完整配置时仅提取_dns段() {
        let profile = "proxies: []\n";
        let mut ov = overrides(false);
        ov.enable_dns = true;
        ov.dns_override = "mixed-port: 7890\ndns:\n  enable: true\n  nameserver:\n    - https://doh.pub/dns-query\nproxies:\n  - name: should-not-enter-dns\n".into();
        let out = build_runtime_config(profile, &ov).expect("生成应成功");
        let doc = parse(&out);
        let dns = doc.get("dns").expect("dns 段应存在");
        assert!(dns.get("nameserver").is_some());
        assert!(dns.get("proxies").is_none());
        assert_eq!(doc.get("mixed-port"), Some(&Value::from(7897u64)));
    }

    #[test]
    fn hosts_覆写解析行并跳过非法() {
        let mut ov = overrides(false);
        ov.hosts = "router.local 192.168.1.1\n# 注释\n\nbad-line\nnas.lan 10.0.0.2\n".into();
        let out = build_runtime_config("proxies: []\n", &ov).expect("生成应成功");
        let doc = parse(&out);
        let hosts = doc.get("hosts").expect("hosts 段应存在");
        assert_eq!(
            hosts.get("router.local"),
            Some(&Value::String("192.168.1.1".into()))
        );
        assert_eq!(hosts.get("nas.lan"), Some(&Value::String("10.0.0.2".into())));
        assert!(hosts.get("bad-line").is_none());
    }
}
