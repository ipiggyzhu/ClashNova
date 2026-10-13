use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

/// 空的可选项沿用订阅；路由开关的默认值保持旧版行为。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct TunOptions {
    pub stack: Option<String>,
    pub device: Option<String>,
    pub mtu: Option<u32>,
    pub auto_route: bool,
    pub auto_detect_interface: bool,
    pub interface_name: Option<String>,
    pub strict_route: Option<bool>,
    pub dns_hijack: Option<Vec<String>>,
    pub route_exclude_address: Option<Vec<String>>,
}

impl Default for TunOptions {
    fn default() -> Self {
        Self {
            stack: None,
            device: None,
            mtu: None,
            auto_route: true,
            auto_detect_interface: true,
            interface_name: None,
            strict_route: None,
            dns_hijack: None,
            route_exclude_address: None,
        }
    }
}

fn valid_name(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}

fn valid_cidr(value: &str) -> bool {
    let Some((address, prefix)) = value.split_once('/') else { return false };
    match (address.parse::<IpAddr>(), prefix.parse::<u8>()) {
        (Ok(IpAddr::V4(_)), Ok(bits)) => bits <= 32,
        (Ok(IpAddr::V6(_)), Ok(bits)) => bits <= 128,
        _ => false,
    }
}

fn valid_dns_target(value: &str) -> bool {
    let address = value.strip_prefix("udp://").or_else(|| value.strip_prefix("tcp://")).unwrap_or(value);
    let Some((host, port)) = address.rsplit_once(':') else { return false };
    let valid_host = if let Some(host) = host.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        host.parse::<Ipv6Addr>().is_ok()
    } else {
        host == "any" || host.parse::<Ipv4Addr>().is_ok()
    };
    valid_host && port.bytes().all(|byte| byte.is_ascii_digit())
        && port.parse::<u16>().is_ok_and(|port| port > 0)
}

impl TunOptions {
    pub fn validate(&self) -> Result<(), String> {
        if self.stack.as_deref().is_some_and(|value| !matches!(value, "system" | "gvisor" | "mixed")) {
            return Err("TUN 协议栈无效".into());
        }
        if self.device.as_deref().is_some_and(|value| !valid_name(value))
            || self.interface_name.as_deref().is_some_and(|value| !valid_name(value)) {
            return Err("TUN 网卡名称应为 1–128 字节且不含控制字符".into());
        }
        if self.mtu.is_some_and(|value| !(576..=65535).contains(&value)) {
            return Err("TUN MTU 应为 576–65535 的整数".into());
        }
        if self.dns_hijack.as_ref().is_some_and(|values| values.len() > 64 || values.iter().any(|value| !valid_dns_target(value))) {
            return Err("DNS 劫持地址应为 any:53、IP:端口或 tcp://IP:端口，最多 64 条".into());
        }
        if self.route_exclude_address.as_ref().is_some_and(|values| values.len() > 256 || values.iter().any(|value| !valid_cidr(value))) {
            return Err("路由排除应为合法 IPv4/IPv6 CIDR，最多 256 条".into());
        }
        Ok(())
    }

    pub fn apply(&self, document: &mut Value) {
        let Some(root) = document.as_mapping_mut() else { return };
        if let Some(interface) = &self.interface_name {
            root.insert(Value::String("interface-name".into()), Value::String(interface.clone()));
        }
        let tun = root.entry(Value::String("tun".into())).or_insert_with(|| Value::Mapping(Mapping::new()));
        if !tun.is_mapping() { *tun = Value::Mapping(Mapping::new()); }
        let tun = tun.as_mapping_mut().expect("TUN mapping initialized");
        let mut set = |key: &str, value: Value| { tun.insert(Value::String(key.into()), value); };
        set("enable", Value::Bool(true));
        set("auto-route", Value::Bool(self.auto_route));
        set("auto-detect-interface", Value::Bool(self.auto_detect_interface));
        if let Some(stack) = &self.stack { set("stack", Value::String(stack.clone())); }
        if let Some(device) = &self.device { set("device", Value::String(device.clone())); }
        if let Some(mtu) = self.mtu { set("mtu", Value::Number(mtu.into())); }
        if let Some(strict) = self.strict_route { set("strict-route", Value::Bool(strict)); }
        for (key, values) in [("dns-hijack", &self.dns_hijack), ("route-exclude-address", &self.route_exclude_address)] {
            if let Some(values) = values { set(key, Value::Sequence(values.iter().cloned().map(Value::String).collect())); }
        }
        tun.entry(Value::String("stack".into())).or_insert_with(|| Value::String("gvisor".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_settings_keep_tun_defaults() {
        let options: TunOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(options, TunOptions::default());
        assert!(serde_json::from_str::<TunOptions>(r#"{"unknown":true}"#).is_err());
    }

    #[test]
    fn validates_tun_values_without_echoing_input() {
        for mtu in [0, 575, 65536] {
            assert!(TunOptions { mtu: Some(mtu), ..Default::default() }.validate().is_err());
        }
        for cidr in ["127.0.0.1", "10.0.0.0/33", "::/129", "secret.invalid/1"] {
            let error = TunOptions { route_exclude_address: Some(vec![cidr.into()]), ..Default::default() }.validate().unwrap_err();
            assert!(!error.contains(cidr));
        }
        assert!(TunOptions { dns_hijack: Some(vec!["any:53".into(), "tcp://[::1]:53".into()]), route_exclude_address: Some(vec!["10.0.0.0/8".into(), "fd00::/8".into()]), ..Default::default() }.validate().is_ok());
        assert!(TunOptions { dns_hijack: Some(vec!["https://example.invalid:53".into()]), ..Default::default() }.validate().is_err());
        for target in ["::1:53", "tcp://::1:53", "[any]:53", "[127.0.0.1]:53", "any:+53"] {
            assert!(TunOptions { dns_hijack: Some(vec![target.into()]), ..Default::default() }.validate().is_err());
        }
    }

    #[test]
    fn overrides_owned_fields_and_preserves_advanced_keys() {
        let mut config: Value = serde_yaml::from_str("tun:\n  stack: system\n  udp-timeout: 300\n  dns-hijack: [any:53]\n").unwrap();
        TunOptions::default().apply(&mut config);
        assert_eq!(config["tun"]["stack"], "system");
        TunOptions { stack: Some("mixed".into()), auto_route: false, dns_hijack: Some(vec![]), mtu: Some(9000), ..Default::default() }.apply(&mut config);
        assert_eq!(config["tun"]["stack"], "mixed");
        assert_eq!(config["tun"]["auto-route"], false);
        assert_eq!(config["tun"]["udp-timeout"], 300);
        assert!(config["tun"]["dns-hijack"].as_sequence().unwrap().is_empty());
    }
}
