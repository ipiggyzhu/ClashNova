// 验证配置修复:模拟用户真实场景,打印生成的 runtime.yaml 关键项。
use nova_core::config_gen::{build_runtime_config, RuntimeOverrides};

fn ov(tun: bool) -> RuntimeOverrides {
    RuntimeOverrides {
        mixed_port: 7897,
        external_controller: "127.0.0.1:9097".into(),
        secret: "x".into(),
        mode: "rule".into(),
        allow_lan: false,
        ipv6: false,
        log_level: "info".into(),
        tun_enable: tun,
        dns_override: String::new(),
        hosts: String::new(),
        enable_dns: true,
        dns_listen: "127.0.0.1:5335".into(),
        dns_enhanced_mode: "fake-ip".into(),
        fake_ip_range: "198.18.0.1/16".into(),
        fake_ip_filter_mode: "blacklist".into(),
        ipv6_dns: false,
        prefer_h3: false,
        respect_rules: true,
        use_hosts: false,
        use_system_hosts: false,
    }
}

fn field(yaml: &str, key: &str) -> String {
    serde_yaml::from_str::<serde_yaml::Value>(yaml)
        .ok()
        .and_then(|v| v.get(key).cloned())
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "<缺失>".into())
}
fn tun_stack(yaml: &str) -> String {
    serde_yaml::from_str::<serde_yaml::Value>(yaml)
        .ok()
        .and_then(|v| v.get("tun").and_then(|t| t.get("stack")).cloned())
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "<缺失>".into())
}

fn main() {
    println!("=== 场景1:TUN开启, profile 未指定 find-process-mode / stack(你的默认情况)===");
    let p = "proxies: []\nrules:\n  - MATCH,DIRECT\n";
    let out = build_runtime_config(p, &ov(true)).unwrap();
    println!(
        "find-process-mode = {}  (修复前=always, 期望=strict)",
        field(&out, "find-process-mode")
    );
    println!("tun.stack         = {}  (期望=gvisor 兜底)", tun_stack(&out));

    println!("\n=== 场景2:profile 显式 find-process-mode: always + tun.stack: system(应被尊重)===");
    let p2 = "find-process-mode: always\ntun:\n  stack: system\nproxies: []\n";
    let out2 = build_runtime_config(p2, &ov(true)).unwrap();
    println!(
        "find-process-mode = {}  (期望=always, 尊重profile)",
        field(&out2, "find-process-mode")
    );
    println!("tun.stack         = {}  (期望=system, 尊重profile)", tun_stack(&out2));

    let ok = field(&out, "find-process-mode") == "strict"
        && tun_stack(&out) == "gvisor"
        && field(&out2, "find-process-mode") == "always"
        && tun_stack(&out2) == "system";
    println!("\n结果: {}", if ok { "✅ 全部符合预期" } else { "❌ 有偏差" });
    std::process::exit(if ok { 0 } else { 1 });
}
