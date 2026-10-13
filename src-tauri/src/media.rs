//! 匿名官方页面探测，不承诺播放、片库或账号可用性；禁止绕过 mihomo 直连兜底。
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::{Client, StatusCode, Url};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

use crate::state::AppState;

const BODY_LIMIT: usize = 512 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaService {
    Youtube,
    Netflix,
    Disney,
}

impl MediaService {
    fn url(self) -> &'static str {
        match self {
            Self::Youtube => "https://www.youtube.com/",
            Self::Netflix => "https://www.netflix.com/",
            Self::Disney => "https://www.disneyplus.com/",
        }
    }

    fn accepts_host(self, host: &str) -> bool {
        match self {
            Self::Youtube => matches!(host, "www.youtube.com" | "youtube.com"),
            Self::Netflix => matches!(host, "www.netflix.com" | "netflix.com"),
            Self::Disney => matches!(host, "www.disneyplus.com" | "disneyplus.com"),
        }
    }

    fn brand(self) -> &'static str {
        match self {
            Self::Youtube => "youtube",
            Self::Netflix => "netflix",
            Self::Disney => "disney",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaStatus {
    Reachable,
    Restricted,
    Unknown,
    Error,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaResult {
    service: MediaService,
    status: MediaStatus,
    elapsed_ms: u64,
    http_status: Option<u16>,
    detail: String,
}

impl MediaResult {
    fn new(
        service: MediaService,
        status: MediaStatus,
        http_status: Option<u16>,
        detail: &str,
    ) -> Self {
        Self {
            service,
            status,
            http_status,
            elapsed_ms: 0,
            detail: detail.into(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaReport {
    proxy_port: u16,
    results: Vec<MediaResult>,
}

struct ActiveProbe {
    id: String,
    cancel: watch::Sender<bool>,
}

#[derive(Default)]
pub struct MediaProbes {
    active: Mutex<Option<ActiveProbe>>,
}

struct ProbeGuard<'a>(&'a MediaProbes);

impl Drop for ProbeGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.active.lock() {
            active.take();
        }
    }
}

impl MediaProbes {
    fn begin(&self, id: &str) -> Result<(ProbeGuard<'_>, watch::Receiver<bool>), String> {
        if id.is_empty()
            || id.len() > 80
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err("媒体检测请求标识无效".into());
        }
        let mut active = self.active.lock().map_err(|_| "媒体检测状态锁错误")?;
        if active.is_some() {
            return Err("已有一批媒体检测正在进行，请等待或取消".into());
        }
        let (cancel, receiver) = watch::channel(false);
        *active = Some(ActiveProbe {
            id: id.into(),
            cancel,
        });
        Ok((ProbeGuard(self), receiver))
    }

    fn cancel(&self, id: &str) -> Result<(), String> {
        let active = self.active.lock().map_err(|_| "媒体检测状态锁错误")?;
        if let Some(request) = active.as_ref().filter(|request| request.id == id) {
            let _ = request.cancel.send(true);
        }
        Ok(())
    }
}

#[tauri::command]
pub fn media_cancel(app: AppHandle, request_id: String) -> Result<(), String> {
    app.state::<MediaProbes>().cancel(&request_id)
}

#[tauri::command]
pub async fn media_probe(app: AppHandle, request_id: String) -> Result<MediaReport, String> {
    let probes = app.state::<MediaProbes>();
    let (_guard, mut cancelled) = probes.begin(&request_id)?;
    tokio::select! {
        biased;
        _ = cancelled.changed() => Err("媒体检测已取消".into()),
        result = async {
            let running = tokio::time::timeout(Duration::from_secs(3), crate::core::is_running(&app)).await
                .map_err(|_| "内核状态检查超时，未发送媒体请求")?;
            require_running(running)?;
            let port = app.state::<AppState>().settings_snapshot().mixed_port;
            let client = proxy_client(port)?;
            // 每个请求独立限时，固定三站同时探测；同一时刻最多一批/三个连接。
            let (youtube, netflix, disney) = tokio::join!(
                timed_probe(&client, MediaService::Youtube),
                timed_probe(&client, MediaService::Netflix),
                timed_probe(&client, MediaService::Disney),
            );
            Ok(MediaReport { proxy_port: port, results: vec![youtube, netflix, disney] })
        } => result,
    }
}

fn require_running(running: bool) -> Result<(), String> {
    if running {
        Ok(())
    } else {
        Err("内核已停止，请先启动 mihomo；媒体检测不会直连兜底".into())
    }
}

fn proxy_client(port: u16) -> Result<Client, String> {
    if port == 0 {
        return Err("mihomo 混合端口无效".into());
    }
    let proxy =
        reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|_| "媒体代理地址无效")?;
    Client::builder()
        .no_proxy()
        .proxy(proxy)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(4))
        .timeout(PROBE_TIMEOUT)
        .user_agent(concat!(
            "ClashNova/",
            env!("CARGO_PKG_VERSION"),
            " (media availability check)"
        ))
        .build()
        .map_err(|_| "创建媒体代理检测客户端失败".into())
}

async fn timed_probe(client: &Client, service: MediaService) -> MediaResult {
    let started = Instant::now();
    let result = tokio::time::timeout(PROBE_TIMEOUT, probe(client, service, service.url())).await;
    let mut result = result.unwrap_or_else(|_| {
        MediaResult::new(
            service,
            MediaStatus::Error,
            None,
            "经 mihomo 的检测超时；未直连重试",
        )
    });
    result.elapsed_ms = started.elapsed().as_millis().max(1).min(u64::MAX as u128) as u64;
    result
}

fn redirect_allowed(service: MediaService, url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url
            .host_str()
            .is_some_and(|host| service.accepts_host(host))
        && !["/login", "/signin", "/consent", "/sorry", "/challenge"]
            .iter()
            .any(|path| url.path().to_ascii_lowercase().starts_with(path))
}

async fn probe(client: &Client, service: MediaService, initial: &str) -> MediaResult {
    let Ok(mut url) = Url::parse(initial) else {
        return MediaResult::new(service, MediaStatus::Error, None, "检测地址无效");
    };
    for hop in 0..=3 {
        let response = client
            .get(url.clone())
            .header("Accept-Language", "en-US,en;q=0.8")
            .header("Accept-Encoding", "identity")
            .send()
            .await;
        let mut response = match response {
            Ok(response) => response,
            Err(error) => {
                return MediaResult::new(
                    service,
                    MediaStatus::Error,
                    None,
                    if error.is_timeout() {
                        "经 mihomo 的请求超时；未直连重试"
                    } else {
                        "经 mihomo 的连接或 TLS 请求失败；未直连重试"
                    },
                )
            }
        };
        let status = response.status();
        if status.is_redirection() {
            let next = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|location| location.to_str().ok())
                .and_then(|location| url.join(location).ok());
            match next {
                Some(next) if hop < 3 && redirect_allowed(service, &next) => {
                    url = next;
                    continue;
                }
                _ => {
                    return MediaResult::new(
                        service,
                        MediaStatus::Unknown,
                        Some(status.as_u16()),
                        "响应要求站外、登录、验证或过多重定向；未继续请求",
                    )
                }
            }
        }
        if matches!(status.as_u16(), 401 | 403 | 407 | 429 | 451) {
            return classify(service, status, &[], false);
        }
        let mut body = Vec::new();
        let mut truncated = false;
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    let remaining = BODY_LIMIT.saturating_sub(body.len());
                    body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
                    if chunk.len() > remaining {
                        truncated = true;
                        break;
                    }
                }
                Ok(None) => break,
                Err(_) => {
                    return MediaResult::new(
                        service,
                        MediaStatus::Error,
                        Some(status.as_u16()),
                        "响应体读取中断；未判断播放可用性",
                    )
                }
            }
        }
        return classify(service, status, &body, truncated);
    }
    MediaResult::new(service, MediaStatus::Unknown, None, "重定向次数超限")
}

fn classify(
    service: MediaService,
    status: StatusCode,
    body: &[u8],
    truncated: bool,
) -> MediaResult {
    let result = |state, text| MediaResult::new(service, state, Some(status.as_u16()), text);
    // RFC 7725 的明确法律限制信号，不据此猜测出口国家或账号区域。
    if status.as_u16() == 451 {
        return result(
            MediaStatus::Restricted,
            "服务明确返回 HTTP 451 法律访问限制；未推断地区或账号状态",
        );
    }
    if status.as_u16() == 407 {
        return result(
            MediaStatus::Error,
            "本地代理要求认证；未发送登录凭据或直连重试",
        );
    }
    if matches!(status.as_u16(), 401 | 403 | 429) {
        return result(
            MediaStatus::Unknown,
            "服务拒绝、要求认证或限流；不能据此认定地区限制",
        );
    }
    if truncated {
        return result(
            MediaStatus::Unknown,
            "响应超过 512 KiB 检查上限；已停止读取，播放可用性未验证",
        );
    }
    let Ok(html) = std::str::from_utf8(body) else {
        return result(
            MediaStatus::Unknown,
            "响应编码或压缩格式未识别；播放可用性未验证",
        );
    };
    let headings = document_headings(html);
    let normalized = headings.join(" ").to_lowercase();
    if [
        "just a moment",
        "access denied",
        "verify you are human",
        "unusual traffic",
        "captcha",
        "robot",
        "enable javascript",
        "javascript is disabled",
    ]
    .iter()
    .any(|phrase| normalized.contains(phrase))
    {
        return result(
            MediaStatus::Unknown,
            "返回人机验证、访问拦截或脚本提示；未绕过验证，也未认定地区限制",
        );
    }
    if status.is_server_error() {
        return result(
            MediaStatus::Error,
            "服务或代理返回服务器错误；播放可用性未验证",
        );
    }
    // 只检查可见标题/主标题，忽略 script/style/template 和页面内置翻译字典。
    // 官方来源：help.disneyplus.com/article/disneyplus-error-73；help.netflix.com/en/node/113539。
    let restricted = headings.iter().any(|heading| {
        let text = heading.to_lowercase();
        match service {
            MediaService::Disney => {
                text.starts_with("error code 73")
                    && text
                        .contains("this content isn't available to watch in your current location")
            }
            MediaService::Netflix => {
                text.trim_end_matches(['.', '!']) == "sorry netflix is not available in your region"
            }
            MediaService::Youtube => false,
        }
    });
    if restricted {
        return result(
            MediaStatus::Restricted,
            "服务标题明确返回访问限制提示；可能涉及地区、设备或代理，未推断具体原因",
        );
    }
    if status.is_success()
        && headings
            .iter()
            .any(|title| title.to_lowercase().contains(service.brand()))
    {
        result(
            MediaStatus::Reachable,
            "官方页面可达；未登录、未播放，不能证明内容解锁或片库可用",
        )
    } else {
        result(
            MediaStatus::Unknown,
            "已收到响应，但页面或状态不足以判断媒体可用性",
        )
    }
}

fn document_headings(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    let mut headings = Vec::new();
    while let Some(start) = lower[cursor..].find('<').map(|offset| cursor + offset) {
        if lower[start..].starts_with("<!--") {
            let Some(end) = lower[start + 4..].find("-->") else {
                break;
            };
            cursor = start + 4 + end + 3;
            continue;
        }
        let Some(end) = lower[start..].find('>').map(|offset| start + offset) else {
            break;
        };
        let tag = lower[start + 1..end]
            .split_ascii_whitespace()
            .next()
            .unwrap_or("")
            .trim_end_matches('/');
        cursor = end + 1;
        if matches!(tag, "script" | "style" | "template") {
            let close = format!("</{tag}>");
            let Some(close_start) = lower[cursor..].find(&close) else {
                break;
            };
            cursor += close_start + close.len();
            continue;
        }
        if !matches!(tag, "title" | "h1") {
            continue;
        }
        let close = format!("</{tag}>");
        let Some(close_start) = lower[cursor..].find(&close) else {
            break;
        };
        let end = cursor + close_start;
        if end - cursor <= 4096 {
            let mut text = String::new();
            let mut in_tag = false;
            for character in html[cursor..end].chars() {
                match character {
                    '<' => {
                        in_tag = true;
                        text.push(' ');
                    }
                    '>' => in_tag = false,
                    _ if !in_tag => text.push(character),
                    _ => {}
                }
            }
            let text = text
                .replace("&#39;", "'")
                .replace("&apos;", "'")
                .replace('’', "'")
                .replace("&quot;", "\"")
                .replace("&amp;", "&");
            headings.push(text.split_whitespace().collect::<Vec<_>>().join(" "));
        }
        cursor = end + close.len();
    }
    headings
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn http_success_is_not_a_playback_claim_and_blocks_are_ambiguous() {
        let success = classify(
            MediaService::Netflix,
            StatusCode::OK,
            b"<title>Netflix - Watch TV Shows Online</title>",
            false,
        );
        assert_eq!(success.status, MediaStatus::Reachable);
        assert!(success.detail.contains("未播放"));
        for status in [
            StatusCode::FORBIDDEN,
            StatusCode::UNAUTHORIZED,
            StatusCode::TOO_MANY_REQUESTS,
        ] {
            assert_eq!(
                classify(MediaService::Netflix, status, b"", false).status,
                MediaStatus::Unknown
            );
        }
        assert_eq!(
            classify(
                MediaService::Youtube,
                StatusCode::OK,
                b"<title>YouTube - Unusual traffic</title>",
                false
            )
            .status,
            MediaStatus::Unknown
        );
        assert_eq!(
            classify(
                MediaService::Disney,
                StatusCode::OK,
                b"<title>Disney+</title>",
                true
            )
            .status,
            MediaStatus::Unknown
        );
        assert_eq!(
            classify(
                MediaService::Netflix,
                StatusCode::SERVICE_UNAVAILABLE,
                b"<title>Just a moment...</title>",
                false
            )
            .status,
            MediaStatus::Unknown
        );
    }

    #[test]
    fn restriction_requires_explicit_signal_not_embedded_translation() {
        let message =
            "Error Code 73: This content isn't available to watch in your current location";
        assert_eq!(
            classify(
                MediaService::Disney,
                StatusCode::OK,
                format!("<h1>{message}</h1>").as_bytes(),
                false
            )
            .status,
            MediaStatus::Restricted
        );
        let embedded = format!(
            "<title>Disney+</title><script>const translations=\"<h1>{message}</h1>\";</script>"
        );
        assert_eq!(
            classify(
                MediaService::Disney,
                StatusCode::OK,
                embedded.as_bytes(),
                false
            )
            .status,
            MediaStatus::Reachable
        );
        assert_eq!(
            classify(
                MediaService::Netflix,
                StatusCode::OK,
                b"<h1>Sorry Netflix is not available in your region.</h1>",
                false
            )
            .status,
            MediaStatus::Restricted
        );
        assert_eq!(
            classify(
                MediaService::Youtube,
                StatusCode::UNAVAILABLE_FOR_LEGAL_REASONS,
                b"",
                false
            )
            .status,
            MediaStatus::Restricted
        );
    }

    #[test]
    fn redirects_and_stopped_core_never_trigger_direct_fallback() {
        assert!(require_running(false).is_err());
        assert!(proxy_client(0).is_err());
        for location in [
            "http://www.netflix.com/",
            "https://www.netflix.com.evil.invalid/",
            "https://www.netflix.com/login",
            "https://user@www.netflix.com/",
        ] {
            assert!(!redirect_allowed(
                MediaService::Netflix,
                &Url::parse(location).unwrap()
            ));
        }
        assert!(redirect_allowed(
            MediaService::Netflix,
            &Url::parse("https://www.netflix.com/us/").unwrap()
        ));
    }

    #[tokio::test]
    async fn request_goes_through_explicit_loopback_proxy_not_target() {
        let origin = TcpListener::bind("127.0.0.1:0").unwrap();
        origin.set_nonblocking(true).unwrap();
        let target = format!("http://{}/", origin.local_addr().unwrap());
        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = proxy.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = proxy.accept().unwrap();
            let mut request = [0; 4096];
            let count = stream.read(&mut request).unwrap();
            tx.send(String::from_utf8_lossy(&request[..count]).into_owned())
                .unwrap();
            let body = "<title>Netflix</title>";
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        });
        let result = probe(&proxy_client(port).unwrap(), MediaService::Netflix, &target).await;
        assert_eq!(result.status, MediaStatus::Reachable);
        assert!(rx
            .recv()
            .unwrap()
            .starts_with(&format!("GET {target} HTTP/1.1")));
        assert_eq!(
            origin.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn https_uses_connect_and_login_redirects_are_not_followed() {
        for tunnel in [true, false] {
            let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = proxy.local_addr().unwrap().port();
            let (tx, rx) = std::sync::mpsc::channel();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = proxy.accept().unwrap();
                let mut buffer = [0; 4096];
                let count = stream.read(&mut buffer).unwrap();
                tx.send(String::from_utf8_lossy(&buffer[..count]).into_owned())
                    .unwrap();
                let response: &[u8] = if tunnel {
                    b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                } else {
                    b"HTTP/1.1 302 Found\r\nLocation: https://www.netflix.com/login\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                };
                stream.write_all(response).unwrap();
            });
            let client = proxy_client(port).unwrap();
            let result = probe(
                &client,
                MediaService::Netflix,
                if tunnel {
                    "https://www.netflix.com/"
                } else {
                    "http://fixture.invalid/"
                },
            )
            .await;
            let request = rx.recv().unwrap();
            if tunnel {
                assert!(request.starts_with("CONNECT www.netflix.com:443 HTTP/1.1"));
                assert_eq!(result.status, MediaStatus::Error);
            } else {
                assert_eq!(result.status, MediaStatus::Unknown);
            }
            assert!(!request.to_ascii_lowercase().contains("authorization:"));
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn failed_proxy_does_not_connect_to_origin_and_cancellation_releases_batch() {
        let origin = TcpListener::bind("127.0.0.1:0").unwrap();
        origin.set_nonblocking(true).unwrap();
        let target = format!("http://{}/", origin.local_addr().unwrap());
        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = proxy.local_addr().unwrap().port();
        drop(proxy);
        let result = probe(&proxy_client(port).unwrap(), MediaService::Netflix, &target).await;
        assert_eq!(result.status, MediaStatus::Error);
        assert_eq!(
            origin.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        let state = MediaProbes::default();
        let (guard, mut cancelled) = state.begin("request-1").unwrap();
        assert!(state.begin("request-2").is_err());
        state.cancel("old-request").unwrap();
        assert!(!*cancelled.borrow());
        state.cancel("request-1").unwrap();
        cancelled.changed().await.unwrap();
        assert!(*cancelled.borrow());
        drop(guard);
        assert!(state.begin("request-2").is_ok());
    }

    #[tokio::test]
    async fn proxy_http_fixture_limits_body_and_stalled_response() {
        for oversized in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                let _ = stream.read(&mut request);
                let length = if oversized { BODY_LIMIT + 1 } else { 100 };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
                );
                if oversized {
                    let _ = stream.write_all(&vec![b'x'; length]);
                } else {
                    std::thread::sleep(Duration::from_millis(300));
                }
            });
            let client = proxy_client(port).unwrap();
            let result = tokio::time::timeout(
                Duration::from_millis(150),
                probe(&client, MediaService::Netflix, "http://fixture.invalid/"),
            )
            .await;
            if oversized {
                assert_eq!(result.unwrap().status, MediaStatus::Unknown);
            } else {
                assert!(result.is_err());
            }
            server.join().unwrap();
        }
    }
}
