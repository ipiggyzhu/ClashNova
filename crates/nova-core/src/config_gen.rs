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
}
