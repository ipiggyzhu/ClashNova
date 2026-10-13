//! 只读网络诊断。报告按白名单构造，不收集日志、订阅、地址、路径或原始错误。
use std::error::Error;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::{Duration, Instant};

use reqwest::{Client, ClientBuilder};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::state::{AppSettings, AppState};

const INTERNET_URL: &str = "https://one.one.one.one/cdn-cgi/trace";
const JSON_LIMIT: usize = 64 * 1024;

#[derive(Default)]
pub struct Diagnostics(tokio::sync::Mutex<()>);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Pass,
    Warn,
    Fail,
    Unknown,
    Skipped,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticCheck {
    id: &'static str,
    title: &'static str,
    status: Status,
    // 固定文案使响应体、API secret、系统路径和错误信息没有进入报告的通道。
    detail: &'static str,
    suggestion: &'static str,
    elapsed_ms: Option<u64>,
}

fn check(
    id: &'static str,
    title: &'static str,
    status: Status,
    detail: &'static str,
    suggestion: &'static str,
) -> DiagnosticCheck {
    DiagnosticCheck {
        id,
        title,
        status,
        detail,
        suggestion,
        elapsed_ms: None,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    schema_version: u8,
    source: &'static str,
    app_version: &'static str,
    platform: &'static str,
    generated_at: u64,
    duration_ms: u64,
    include_internet: bool,
    checks: Vec<DiagnosticCheck>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct Listener {
    occupied: bool,
    owned: Option<bool>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsSnapshot {
    mixed: Option<Listener>,
    controller: Option<Listener>,
    dns: Option<Listener>,
    tun_up: Option<bool>,
    service: Option<String>,
}

#[derive(Deserialize)]
struct RuntimeConfig {
    #[serde(rename = "mixed-port")]
    mixed_port: u16,
    ipv6: bool,
    tun: RuntimeTun,
}

#[derive(Deserialize)]
struct RuntimeTun {
    enable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeError {
    NotChecked,
    Auth,
    Timeout,
    Http,
    Invalid,
    Certificate,
    Connect,
}

/// 不解析远程主机、不向非回环控制器发送凭据；通配监听地址转为同族回环。
fn loopback_endpoint(value: &str) -> Option<SocketAddr> {
    let value = value
        .strip_prefix("localhost:")
        .map(|port| format!("127.0.0.1:{port}"))
        .unwrap_or_else(|| value.to_string());
    let mut address: SocketAddr = value.parse().ok()?;
    if address.port() == 0 {
        return None;
    }
    if address.ip().is_unspecified() {
        address.set_ip(if address.is_ipv4() {
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        } else {
            IpAddr::V6(Ipv6Addr::LOCALHOST)
        });
    }
    address.ip().is_loopback().then_some(address)
}

fn client_builder(timeout: Duration) -> ClientBuilder {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(timeout)
        .timeout(timeout)
        .user_agent(concat!(
            "ClashNova/",
            env!("CARGO_PKG_VERSION"),
            " (network diagnosis)"
        ))
}

fn request_error(error: reqwest::Error) -> ProbeError {
    if error.is_timeout() {
        return ProbeError::Timeout;
    }
    let mut source = error.source();
    while let Some(cause) = source {
        // 当前锁定 rustls 的 InvalidCertificate 显示前缀。只分类，不导出错误链。
        if cause.to_string().starts_with("invalid peer certificate:") {
            return ProbeError::Certificate;
        }
        source = cause.source();
    }
    ProbeError::Connect
}

async fn local_json(
    client: &Client,
    address: SocketAddr,
    endpoint: &str,
    secret: &str,
) -> Result<serde_json::Value, ProbeError> {
    let mut response = client
        .get(format!("http://{address}{endpoint}"))
        .bearer_auth(secret)
        .send()
        .await
        .map_err(request_error)?;
    match response.status().as_u16() {
        401 | 403 => return Err(ProbeError::Auth),
        200 => {}
        _ => return Err(ProbeError::Http),
    }
    if response
        .content_length()
        .is_some_and(|size| size > JSON_LIMIT as u64)
    {
        return Err(ProbeError::Invalid);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if body.len() + chunk.len() > JSON_LIMIT {
            return Err(ProbeError::Invalid);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| ProbeError::Invalid)
}

fn probe_check(
    id: &'static str,
    title: &'static str,
    result: Result<(), ProbeError>,
    success: &'static str,
) -> DiagnosticCheck {
    let (status, detail, suggestion) = match result {
        Ok(()) => (Status::Pass, success, ""),
        Err(ProbeError::NotChecked) => (
            Status::Skipped,
            "前置条件未满足，未发送探测请求。",
            "先处理相关监听或控制器诊断，再重试。",
        ),
        Err(ProbeError::Auth) => (
            Status::Fail,
            "本机控制器拒绝认证；未导出凭据或响应内容。",
            "检查客户端和内核运行配置的 API 密钥是否一致。",
        ),
        Err(ProbeError::Timeout) => (
            Status::Warn,
            "探测超时；单个目标超时不代表整个网络故障。",
            "检查对应网络路径、DNS 或防火墙后重试。",
        ),
        Err(ProbeError::Http) => (
            Status::Warn,
            "收到非预期 HTTP 状态；未跟随重定向。",
            "检查代理认证、网络登录页或目标服务状态。",
        ),
        Err(ProbeError::Invalid) => (
            Status::Unknown,
            "响应不符合预期或超过读取上限；未将响应内容写入报告。",
            "核对内核版本与控制器状态后重试。",
        ),
        Err(ProbeError::Certificate) => (
            Status::Warn,
            "TLS 证书验证失败；未跳过验证或接受不受信任的证书。",
            "核对系统时间、证书链和网络证书环境；此结果不代表整个 IPv4 / IPv6 网络不通。",
        ),
        Err(ProbeError::Connect) => (
            Status::Warn,
            "连接或 TLS 请求失败；未推断具体故障原因。",
            "检查对应地址族的网络支持和防火墙；IPv6 不通不等于客户端故障。",
        ),
    };
    check(id, title, status, detail, suggestion)
}

fn listener_check(
    id: &'static str,
    title: &'static str,
    listener: Option<Listener>,
    running: bool,
) -> DiagnosticCheck {
    let (status, detail, suggestion) = match listener {
        Some(Listener {
            occupied: true,
            owned: Some(true),
        }) => (
            Status::Pass,
            "检测到当前内核 PID 的本机监听；不代表外网连通。",
            "",
        ),
        Some(Listener {
            occupied: true,
            owned: Some(false),
        }) => (
            Status::Fail,
            "检测到其他进程占用此监听地址和端口。",
            "检查端口冲突；诊断不会终止进程或修改端口。",
        ),
        Some(Listener {
            occupied: true,
            owned: None,
        }) => (
            Status::Warn,
            "端口存在监听，但未确认当前内核 PID。",
            "先确认内核运行状态，再判断是否有端口冲突。",
        ),
        Some(Listener {
            occupied: false, ..
        }) if running => (
            Status::Fail,
            "当前内核存在，但未发现预期的本机监听。",
            "检查运行配置是否生效以及内核启动错误。",
        ),
        Some(_) => (
            Status::Skipped,
            "未确认运行中的内核，也未发现此端口监听。",
            "需要代理时先手动启动内核，再运行诊断。",
        ),
        None => (
            Status::Unknown,
            "未取得此监听信息；地址不受支持、查询超时或权限不足均可能导致此结果。",
            "当前仅检查本机回环或通配监听，不探测远程控制器。",
        ),
    };
    check(id, title, status, detail, suggestion)
}

#[cfg(windows)]
async fn windows_snapshot(settings: &AppSettings, pid: Option<u32>) -> WindowsSnapshot {
    let controller = loopback_endpoint(&settings.external_controller);
    let dns = if settings.enable_dns {
        loopback_endpoint(&settings.dns_listen)
    } else {
        None
    };
    let Some(root) = std::env::var_os("SystemRoot") else {
        return WindowsSnapshot::default();
    };
    let mut command = tokio::process::Command::new(
        std::path::PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
    );
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            include_str!("diagnostics_windows.ps1"),
        ])
        .env("CLASHNOVA_DIAG_PID", pid.unwrap_or(0).to_string())
        .env("CLASHNOVA_DIAG_MIXED_PORT", settings.mixed_port.to_string())
        .env(
            "CLASHNOVA_DIAG_CONTROLLER_PORT",
            controller.map_or(0, |address| address.port()).to_string(),
        )
        .env(
            "CLASHNOVA_DIAG_CONTROLLER_IP",
            controller.map_or(String::new(), |address| address.ip().to_string()),
        )
        .env(
            "CLASHNOVA_DIAG_DNS_PORT",
            dns.map_or(0, |address| address.port()).to_string(),
        )
        .env(
            "CLASHNOVA_DIAG_DNS_IP",
            dns.map_or(String::new(), |address| address.ip().to_string()),
        )
        .env("CLASHNOVA_DIAG_TUN", if settings.tun { "1" } else { "0" })
        .env(
            "CLASHNOVA_DIAG_DEVICE",
            settings.tun_options.device.as_deref().unwrap_or(""),
        )
        .creation_flags(0x0800_0000)
        .kill_on_drop(true);
    match tokio::time::timeout(Duration::from_secs(8), command.output()).await {
        Ok(Ok(output)) if output.status.success() && output.stdout.len() <= 4096 => {
            serde_json::from_slice(&output.stdout).unwrap_or_default()
        }
        _ => WindowsSnapshot::default(),
    }
}

#[cfg(not(windows))]
async fn windows_snapshot(_settings: &AppSettings, _pid: Option<u32>) -> WindowsSnapshot {
    WindowsSnapshot::default()
}

fn service_check(snapshot: &WindowsSnapshot, tun: bool) -> DiagnosticCheck {
    let (status, detail) = match snapshot.service.as_deref() {
        Some("missing") if tun => (Status::Fail, "设置启用了 TUN，但 Windows 服务未安装。"),
        Some("missing") => (
            Status::Skipped,
            "Windows 服务未安装；普通代理模式不要求安装服务。",
        ),
        Some("stopped") if tun => (Status::Fail, "设置启用了 TUN，但 Windows 服务已停止。"),
        Some("stopped") => (
            Status::Skipped,
            "Windows 服务已安装但未运行；普通模式可使用独立内核。",
        ),
        Some("running") => (
            Status::Pass,
            "Windows 服务处于运行状态；不等于 TUN 流量接管已验收。",
        ),
        Some("pending") => (Status::Warn, "Windows 服务正在启动或停止，请稍后复查。"),
        _ => (
            Status::Unknown,
            "未取得 Windows 服务状态；可能是权限、平台或查询超时问题。",
        ),
    };
    #[cfg(windows)]
    if matches!(snapshot.service.as_deref(), Some("running" | "stopped"))
        && crate::service::inspect_installation().is_err()
    {
        return check(
            "service",
            "Windows 服务",
            Status::Fail,
            "服务注册或托管文件检查未通过；未输出系统路径。",
            "在设置页检查服务状态，确认后手动修复；诊断不会执行修复。",
        );
    }
    check("service", "Windows 服务", status, detail, "")
}

fn system_proxy_check(settings: &AppSettings) -> DiagnosticCheck {
    #[cfg(windows)]
    {
        let actual = sysproxy::Sysproxy::get_system_proxy();
        let pac = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
            .and_then(|key| key.get_value::<String, _>("AutoConfigURL"))
            .ok()
            .is_some_and(|value| !value.trim().is_empty());
        let (status, detail) = match actual {
            Ok(_) if pac => (
                Status::Warn,
                "系统还配置了自动代理脚本；本项不验证 PAC、WinHTTP 或浏览器扩展。",
            ),
            Ok(actual) if actual.enable != settings.sys_proxy => {
                (Status::Warn, "系统手动代理开关与应用设置不一致。")
            }
            Ok(actual)
                if settings.sys_proxy
                    && (actual.host != "127.0.0.1"
                        || actual.port != settings.mixed_port
                        || actual.bypass != settings.bypass) =>
            {
                (
                    Status::Warn,
                    "系统手动代理地址、端口或绕过列表与应用设置不一致。",
                )
            }
            Ok(_) => (
                Status::Pass,
                "Windows 手动代理与应用设置一致；不代表 PAC、WinHTTP 或外网连通。",
            ),
            Err(_) => (
                Status::Unknown,
                "读取 Windows 手动代理状态失败；未输出原始错误。",
            ),
        };
        check(
            "system-proxy",
            "Windows 手动代理",
            status,
            detail,
            "诊断不会恢复或改写系统代理。",
        )
    }
    #[cfg(not(windows))]
    {
        let _ = settings;
        check(
            "system-proxy",
            "Windows 手动代理",
            Status::Skipped,
            "本项仅支持 Windows。",
            "",
        )
    }
}

fn tun_check(
    settings: &AppSettings,
    runtime: Option<&RuntimeConfig>,
    adapter_up: Option<bool>,
) -> DiagnosticCheck {
    let (status, detail) = if runtime.is_some_and(|config| config.tun.enable != settings.tun) {
        (Status::Fail, "TUN 运行状态与应用设置不一致。")
    } else if !settings.tun {
        (
            Status::Skipped,
            "应用设置未开启 TUN；本次未验证路由或网卡接管。",
        )
    } else if runtime.is_none() || adapter_up.is_none() {
        (
            Status::Unknown,
            "TUN 已请求开启，但运行配置或网卡信息尚未确认。",
        )
    } else if adapter_up == Some(true) {
        (
            Status::Pass,
            "内核配置已开启 TUN，且发现匹配的 Up 网卡；不证明流量或路由已正确接管。",
        )
    } else {
        (Status::Warn, "内核配置已开启 TUN，但未找到匹配的 Up 网卡。")
    };
    check(
        "tun",
        "TUN 状态",
        status,
        detail,
        "诊断不启停服务、不更改路由；完整接管仍需实机验收。",
    )
}

fn ipv6_check(settings: &AppSettings, runtime: Option<&RuntimeConfig>) -> DiagnosticCheck {
    let (status, detail) = if runtime.is_some_and(|config| config.ipv6 != settings.ipv6) {
        (Status::Warn, "内核 IPv6 运行开关与应用设置不一致。")
    } else if !settings.ipv6 {
        (
            Status::Skipped,
            "应用 IPv6 开关关闭；可单独选择外网探测查看网络的 IPv6 能力。",
        )
    } else if settings.enable_dns && !settings.ipv6_dns {
        (
            Status::Warn,
            "应用 IPv6 已开启，但 DNS 的 IPv6 返回开关关闭；这不一定是故障。",
        )
    } else if runtime.is_none() {
        (
            Status::Unknown,
            "应用 IPv6 已开启，但内核运行状态尚未确认。",
        )
    } else {
        (
            Status::Pass,
            "应用与内核 IPv6 开关一致；尚不能据此判定 IPv6 外网连通。",
        )
    };
    check(
        "ipv6-config",
        "IPv6 配置",
        status,
        detail,
        "IPv6 网络探测不会开启或修改 IPv6 设置。",
    )
}

async fn internet_probe(
    id: &'static str,
    title: &'static str,
    client: Result<Client, reqwest::Error>,
    url: &str,
) -> DiagnosticCheck {
    let started = Instant::now();
    let result = match client {
        Ok(client) => client
            .get(url)
            .send()
            .await
            .map_err(request_error)
            .and_then(|response| {
                // 不读取 trace 响应体，避免收集出口 IP 等信息。
                if response.status() == reqwest::StatusCode::OK {
                    Ok(())
                } else {
                    Err(ProbeError::Http)
                }
            }),
        Err(_) => Err(ProbeError::Connect),
    };
    let mut item = probe_check(
        id,
        title,
        result,
        "指定 HTTPS 端点可达；未读取响应体，也未收集出口 IP。",
    );
    item.elapsed_ms = Some(started.elapsed().as_millis() as u64);
    item
}

fn valid_dns_answer(value: &serde_json::Value) -> bool {
    value["Status"].as_u64() == Some(0)
        && value["TC"].as_bool() != Some(true)
        && value["Answer"].as_array().is_some_and(|answers| {
            answers.iter().any(|answer| {
                (answer["type"].as_u64() == Some(1) || answer["type"].as_str() == Some("A"))
                    && answer["data"]
                        .as_str()
                        .is_some_and(|data| data.parse::<Ipv4Addr>().is_ok())
            })
        })
}

async fn collect(app: &AppHandle, include_internet: bool) -> DiagnosticReport {
    let started = Instant::now();
    let settings = app.state::<AppState>().settings_snapshot();
    let pid = tokio::time::timeout(Duration::from_secs(3), crate::core::diagnostic_pid(app))
        .await
        .ok()
        .flatten();
    let proxy_settings = settings.clone();
    let (snapshot, system_proxy) = tokio::join!(
        windows_snapshot(&settings, pid),
        tokio::time::timeout(
            Duration::from_secs(3),
            tauri::async_runtime::spawn_blocking(move || system_proxy_check(&proxy_settings))
        ),
    );
    let address = loopback_endpoint(&settings.external_controller);
    let controller_owned = snapshot
        .controller
        .is_some_and(|listener| listener.occupied && listener.owned == Some(true));
    let client = client_builder(Duration::from_secs(3)).build();
    let runtime = match (address, client.as_ref(), controller_owned) {
        (Some(address), Ok(client), true) => {
            local_json(client, address, "/configs", &settings.secret)
                .await
                .and_then(|value| {
                    serde_json::from_value::<RuntimeConfig>(value).map_err(|_| ProbeError::Invalid)
                })
        }
        _ => Err(ProbeError::NotChecked),
    };
    let mut checks = vec![
        check(
            "core",
            "内核进程",
            if pid.is_some() {
                Status::Pass
            } else {
                Status::Warn
            },
            if pid.is_some() {
                "已从本应用取得运行中的内核 PID；PID 未写入报告。"
            } else {
                "未确认运行中的内核；可能已停止或服务 IPC 不可用。"
            },
            "",
        ),
        service_check(&snapshot, settings.tun),
        listener_check("mixed-port", "混合端口监听", snapshot.mixed, pid.is_some()),
        listener_check(
            "controller-port",
            "控制器端口监听",
            snapshot.controller,
            pid.is_some(),
        ),
        probe_check(
            "controller-api",
            "内核控制器 API",
            runtime.as_ref().map(|_| ()).map_err(|error| *error),
            "本机控制器认证和运行配置读取成功；未导出配置内容。",
        ),
        system_proxy.ok().and_then(Result::ok).unwrap_or_else(|| {
            check(
                "system-proxy",
                "Windows 手动代理",
                Status::Unknown,
                "代理状态读取超时或失败。",
                "",
            )
        }),
        if settings.enable_dns {
            listener_check("dns-listener", "DNS UDP 监听", snapshot.dns, pid.is_some())
        } else {
            check(
                "dns-listener",
                "DNS UDP 监听",
                Status::Skipped,
                "应用 DNS 开关关闭，未检查监听。",
                "",
            )
        },
        tun_check(&settings, runtime.as_ref().ok(), snapshot.tun_up),
        ipv6_check(&settings, runtime.as_ref().ok()),
    ];
    if runtime
        .as_ref()
        .is_ok_and(|config| config.mixed_port != settings.mixed_port)
    {
        checks.push(check(
            "runtime-port",
            "运行端口一致性",
            Status::Fail,
            "内核运行混合端口与应用设置不一致。",
            "检查配置是否加载成功；诊断不会重载配置。",
        ));
    }
    if include_internet {
        let timeout = Duration::from_secs(5);
        let dns = async {
            let result = match (address, client.as_ref(), runtime.is_ok()) {
                (Some(address), Ok(client), true) if settings.enable_dns => local_json(
                    client,
                    address,
                    "/dns/query?name=example.com&type=A",
                    &settings.secret,
                )
                .await
                .and_then(|value| {
                    if valid_dns_answer(&value) {
                        Ok(())
                    } else {
                        Err(ProbeError::Invalid)
                    }
                }),
                _ => Err(ProbeError::NotChecked),
            };
            probe_check(
                "dns-query",
                "内核 DNS 查询",
                result,
                "内核 DNS 返回有效 A 记录；不代表操作系统所有应用的 DNS 路径相同。",
            )
        };
        let proxy = async {
            if !snapshot
                .mixed
                .is_some_and(|listener| listener.occupied && listener.owned == Some(true))
            {
                return probe_check(
                    "proxy-https",
                    "经 mihomo 的 HTTPS",
                    Err(ProbeError::NotChecked),
                    "",
                );
            }
            let client = reqwest::Proxy::all(format!("http://127.0.0.1:{}", settings.mixed_port))
                .and_then(|proxy| client_builder(timeout).proxy(proxy).build());
            internet_probe("proxy-https", "经 mihomo 的 HTTPS", client, INTERNET_URL).await
        };
        let (dns, ipv4, ipv6, proxy) = tokio::join!(
            dns,
            internet_probe(
                "ipv4-https",
                "IPv4 HTTPS",
                client_builder(timeout)
                    .resolve("one.one.one.one", SocketAddr::from(([1, 1, 1, 1], 443)))
                    .build(),
                INTERNET_URL
            ),
            internet_probe(
                "ipv6-https",
                "IPv6 HTTPS",
                client_builder(timeout)
                    .resolve(
                        "one.one.one.one",
                        SocketAddr::from(([0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111], 443))
                    )
                    .build(),
                INTERNET_URL
            ),
            proxy,
        );
        checks.extend([dns, ipv4, ipv6, proxy]);
    } else {
        for (id, title) in [
            ("dns-query", "内核 DNS 查询"),
            ("ipv4-https", "IPv4 HTTPS"),
            ("ipv6-https", "IPv6 HTTPS"),
            ("proxy-https", "经 mihomo 的 HTTPS"),
        ] {
            checks.push(check(
                id,
                title,
                Status::Skipped,
                "未选择外网探测，本项没有发送请求。",
                "勾选外网探测后重新诊断。",
            ));
        }
    }
    let final_pid = tokio::time::timeout(Duration::from_secs(3), crate::core::diagnostic_pid(app))
        .await
        .ok()
        .flatten();
    if settings != app.state::<AppState>().settings_snapshot() || pid != final_pid {
        checks.push(check(
            "snapshot",
            "诊断期间状态变化",
            Status::Warn,
            "诊断期间应用设置或内核进程发生变化，结果可能已过时。",
            "等待配置操作或内核启动结束后重新诊断。",
        ));
    }
    DiagnosticReport {
        schema_version: 1,
        source: "native",
        app_version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        generated_at: crate::state::now_millis(),
        duration_ms: started.elapsed().as_millis() as u64,
        include_internet,
        checks,
    }
}

#[tauri::command]
pub async fn diagnostics_run(
    app: AppHandle,
    include_internet: bool,
) -> Result<DiagnosticReport, String> {
    let diagnostics = app.state::<Diagnostics>();
    let _active = diagnostics
        .0
        .try_lock()
        .map_err(|_| "已有网络诊断正在进行，请稍后重试")?;
    tokio::time::timeout(Duration::from_secs(25), collect(&app, include_internet))
        .await
        .map_err(|_| "网络诊断超时，未生成完整报告；系统设置未被诊断修改".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn server(response: String, delay: Duration) -> (SocketAddr, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let task = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") && bytes.len() < 8192 {
                let mut byte = [0];
                if stream.read(&mut byte).unwrap_or(0) == 0 {
                    break;
                }
                bytes.push(byte[0]);
            }
            std::thread::sleep(delay);
            let _ = stream.write_all(response.as_bytes());
            String::from_utf8(bytes).unwrap()
        });
        (address, task)
    }

    fn json_response(body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
    }

    #[test]
    fn only_loopback_or_wildcard_endpoints_can_receive_api_credentials() {
        for value in [
            "example.com:9090",
            "192.0.2.1:9090",
            "https://127.0.0.1:9090",
            "user:password@127.0.0.1:9090",
            "127.0.0.1:0",
            "[::1]:0",
            "::1:9090",
            "127.0.0.1:9090/private",
        ] {
            assert!(loopback_endpoint(value).is_none());
        }
        assert_eq!(
            loopback_endpoint("localhost:9090"),
            Some("127.0.0.1:9090".parse().unwrap())
        );
        assert_eq!(
            loopback_endpoint("0.0.0.0:9090"),
            Some("127.0.0.1:9090".parse().unwrap())
        );
        assert_eq!(
            loopback_endpoint("[::]:9090"),
            Some("[::1]:9090".parse().unwrap())
        );
    }

    #[test]
    fn listeners_distinguish_owned_foreign_absent_and_unknown() {
        assert_eq!(
            listener_check(
                "port",
                "Port",
                Some(Listener {
                    occupied: true,
                    owned: Some(true)
                }),
                true
            )
            .status,
            Status::Pass
        );
        assert_eq!(
            listener_check(
                "port",
                "Port",
                Some(Listener {
                    occupied: true,
                    owned: Some(false)
                }),
                true
            )
            .status,
            Status::Fail
        );
        assert_eq!(
            listener_check(
                "port",
                "Port",
                Some(Listener {
                    occupied: true,
                    owned: None
                }),
                false
            )
            .status,
            Status::Warn
        );
        assert_eq!(
            listener_check(
                "port",
                "Port",
                Some(Listener {
                    occupied: false,
                    owned: Some(false)
                }),
                true
            )
            .status,
            Status::Fail
        );
        assert_eq!(
            listener_check(
                "port",
                "Port",
                Some(Listener {
                    occupied: false,
                    owned: None
                }),
                false
            )
            .status,
            Status::Skipped
        );
        assert_eq!(
            listener_check("port", "Port", None, true).status,
            Status::Unknown
        );
    }

    #[test]
    fn disabled_tun_ipv6_and_missing_optional_service_are_not_failures() {
        let mut settings = AppSettings::default();
        let runtime = RuntimeConfig {
            mixed_port: settings.mixed_port,
            ipv6: false,
            tun: RuntimeTun { enable: false },
        };
        assert_eq!(
            tun_check(&settings, Some(&runtime), None).status,
            Status::Skipped
        );
        assert_eq!(
            ipv6_check(&settings, Some(&runtime)).status,
            Status::Skipped
        );
        assert_eq!(
            service_check(
                &WindowsSnapshot {
                    service: Some("missing".into()),
                    ..Default::default()
                },
                false
            )
            .status,
            Status::Skipped
        );
        settings.tun = true;
        assert_eq!(
            tun_check(&settings, Some(&runtime), Some(true)).status,
            Status::Fail
        );
        assert_eq!(tun_check(&settings, None, None).status, Status::Unknown);
        assert_eq!(
            service_check(
                &WindowsSnapshot {
                    service: Some("missing".into()),
                    ..Default::default()
                },
                true
            )
            .status,
            Status::Fail
        );
    }

    #[test]
    fn dns_success_requires_a_valid_answer_not_merely_http_success() {
        assert!(valid_dns_answer(
            &serde_json::json!({"Status":0,"Answer":[{"type":1,"data":"192.0.2.1"}]})
        ));
        for value in [
            serde_json::json!({"Status":0,"Answer":[]}),
            serde_json::json!({"Status":2,"Answer":[{"type":1,"data":"192.0.2.1"}]}),
            serde_json::json!({"Status":0,"TC":true,"Answer":[{"type":1,"data":"192.0.2.1"}]}),
            serde_json::json!({"Status":0,"Answer":[{"type":5,"data":"private.example"}]}),
            serde_json::json!({"Status":0,"Answer":[{"type":1,"data":"private-error"}]}),
        ] {
            assert!(!valid_dns_answer(&value));
        }
    }

    #[test]
    fn single_flight_guard_releases_after_a_dropped_diagnostic() {
        let diagnostics = Diagnostics::default();
        let active = diagnostics.0.try_lock().unwrap();
        assert!(diagnostics.0.try_lock().is_err());
        drop(active);
        assert!(diagnostics.0.try_lock().is_ok());
    }

    #[test]
    fn certificate_failure_is_not_reported_as_an_entire_network_outage() {
        let result = probe_check("ipv4-https", "IPv4 HTTPS", Err(ProbeError::Certificate), "");
        assert_eq!(result.status, Status::Warn);
        assert!(result.detail.contains("TLS 证书验证失败"));
        assert!(result.suggestion.contains("不代表整个"));
    }

    #[tokio::test]
    async fn authenticated_reads_are_bounded_and_raw_response_values_never_enter_report() {
        let body = r#"{"mixed-port":7897,"ipv6":false,"tun":{"enable":false},"secret":"private-response-secret","device":"private-adapter","path":"C:/private-user"}"#;
        let (address, server) = server(json_response(body), Duration::ZERO);
        let client = client_builder(Duration::from_secs(2)).build().unwrap();
        let value = local_json(&client, address, "/configs", "fixture-secret")
            .await
            .unwrap();
        let runtime: RuntimeConfig = serde_json::from_value(value).unwrap();
        let settings = AppSettings::default();
        let checks = vec![
            tun_check(&settings, Some(&runtime), None),
            ipv6_check(&settings, Some(&runtime)),
            probe_check("api", "API", Ok(()), "读取成功"),
        ];
        let report = DiagnosticReport {
            schema_version: 1,
            source: "native",
            app_version: env!("CARGO_PKG_VERSION"),
            platform: std::env::consts::OS,
            generated_at: 1,
            duration_ms: 1,
            include_internet: false,
            checks,
        };
        let output = serde_json::to_string(&report).unwrap();
        for sensitive in [
            "fixture-secret",
            "private-response-secret",
            "private-adapter",
            "private-user",
            "7897",
            "127.0.0.1",
        ] {
            assert!(!output.contains(sensitive));
        }
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /configs HTTP/1.1"));
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer fixture-secret"));

        let oversized = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            JSON_LIMIT + 1
        );
        let (address, task) = self::server(oversized, Duration::ZERO);
        assert_eq!(
            local_json(&client, address, "/configs", "fixture-secret")
                .await
                .unwrap_err(),
            ProbeError::Invalid
        );
        task.join().unwrap();
    }

    #[tokio::test]
    async fn controller_redirects_never_forward_credentials_and_failures_are_classified() {
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let redirect = format!(
            "HTTP/1.1 302 Found\r\nLocation: http://{}/private\r\nContent-Length: 0\r\n\r\n",
            destination.local_addr().unwrap()
        );
        let (address, task) = server(redirect, Duration::ZERO);
        let client = client_builder(Duration::from_secs(2)).build().unwrap();
        assert_eq!(
            local_json(&client, address, "/configs", "fixture-secret")
                .await
                .unwrap_err(),
            ProbeError::Http
        );
        task.join().unwrap();
        assert_eq!(
            destination.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        let (address, task) = server(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n".into(),
            Duration::ZERO,
        );
        assert_eq!(
            local_json(&client, address, "/configs", "fixture-secret")
                .await
                .unwrap_err(),
            ProbeError::Auth
        );
        task.join().unwrap();
        let (address, task) = server(json_response("{}"), Duration::from_millis(200));
        let client = client_builder(Duration::from_millis(50)).build().unwrap();
        assert_eq!(
            local_json(&client, address, "/configs", "fixture-secret")
                .await
                .unwrap_err(),
            ProbeError::Timeout
        );
        task.join().unwrap();
    }

    #[tokio::test]
    async fn internet_probe_does_not_read_sensitive_body_or_fallback_from_proxy() {
        let (address, task) = server(
            json_response(r#"{"ip":"192.0.2.123","secret":"private-remote-body"}"#),
            Duration::ZERO,
        );
        let result = internet_probe(
            "net",
            "Network",
            client_builder(Duration::from_secs(2)).build(),
            &format!("http://{address}/"),
        )
        .await;
        assert_eq!(result.status, Status::Pass);
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("private-remote-body"));
        assert!(!task
            .join()
            .unwrap()
            .to_lowercase()
            .contains("authorization:"));
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let (proxy, task) = server(
            "HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n".into(),
            Duration::ZERO,
        );
        let client = client_builder(Duration::from_secs(2))
            .proxy(reqwest::Proxy::all(format!("http://{proxy}")).unwrap())
            .build();
        let result = internet_probe(
            "proxy",
            "Proxy",
            client,
            &format!("http://{}/", destination.local_addr().unwrap()),
        )
        .await;
        assert_eq!(result.status, Status::Warn);
        assert!(task.join().unwrap().starts_with("GET http://"));
        assert_eq!(
            destination.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}
