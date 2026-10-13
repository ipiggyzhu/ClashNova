use std::collections::HashSet;
use std::time::Duration;

use quick_xml::events::Event;
use quick_xml::name::{Namespace, ResolveResult};
use quick_xml::reader::NsReader;
use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};

use super::{
    atomic_write, checked_file, decode_snapshot, encode_snapshot, read_limited, validate_id,
    BackupEntry, Dirs, Snapshot, EXTENSION, MAX_ARCHIVE_BYTES, MAX_FILES,
};

const MAX_XML_BYTES: usize = 2 * 1024 * 1024;
const CONFIG_NAME: &str = "backup-webdav.json";

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfig {
    pub url: String,
    pub username: String,
    pub password_saved: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebDavConfigInput {
    pub url: String,
    pub username: String,
    pub password: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredConfig {
    url: String,
    username: String,
    /// Windows 当前用户的 DPAPI 密文；从不进入备份或 IPC 返回值。
    protected_password: Vec<u8>,
}

fn load_config(dirs: &Dirs) -> Result<StoredConfig, String> {
    let path = dirs.config.join(CONFIG_NAME);
    checked_file(&path, true)?;
    if !path.exists() {
        return Ok(StoredConfig::default());
    }
    serde_json::from_str(&read_limited(&path, 32 * 1024)?)
        .map_err(|_| "WebDAV 本机设置损坏，请重新保存".into())
}

pub(super) fn get_config(dirs: &Dirs) -> Result<WebDavConfig, String> {
    let config = load_config(dirs)?;
    Ok(WebDavConfig {
        url: config.url,
        username: config.username,
        password_saved: !config.protected_password.is_empty(),
    })
}

pub(super) fn save_config(dirs: &Dirs, input: WebDavConfigInput) -> Result<(), String> {
    let next = if input.url.trim().is_empty() {
        StoredConfig::default()
    } else {
        let url = collection_url(input.url.trim())?;
        if input.username.len() > 1024
            || input.username.chars().any(char::is_control)
            || input.username.contains(':')
            || input.password.as_ref().is_some_and(|p| p.len() > 4096)
        {
            return Err("WebDAV 账号字段无效或超长".into());
        }
        let protected_password = match input.password {
            Some(password) => protect(password.as_bytes())?,
            None if input.username.is_empty() => Vec::new(),
            None => {
                let old = load_config(dirs)?;
                if old.username != input.username
                    || !collection_url(&old.url)
                        .is_ok_and(|old_url| old_url.origin() == url.origin())
                {
                    return Err("WebDAV 服务器或账号变更后，请重新输入密码".into());
                }
                old.protected_password
            }
        };
        StoredConfig {
            url: url.to_string(),
            username: input.username,
            protected_password,
        }
    };
    let path = dirs.config.join(CONFIG_NAME);
    checked_file(&path, true)?;
    let content = serde_json::to_vec_pretty(&next).map_err(|_| "保存 WebDAV 设置失败")?;
    atomic_write(&path, &content).map_err(|_| "保存 WebDAV 设置失败".into())
}

#[cfg(windows)]
fn crypt(data: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len().try_into().map_err(|_| "凭据过长")?,
        pbData: data.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // API 分配输出使用 LocalAlloc，必须使用 LocalFree；不启用 LOCAL_MACHINE，隔离到当前用户。
    unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
        .map_err(|_| "Windows 凭据保护失败，请重新输入 WebDAV 密码")?;
        let bytes = if output.cbData == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
        };
        if !output.pbData.is_null() {
            let _ = LocalFree(HLOCAL(output.pbData.cast()));
        }
        Ok(bytes)
    }
}

fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        crypt(data, true)
    }
    #[cfg(not(windows))]
    {
        let _ = data;
        Err("WebDAV 凭据保存目前仅支持 Windows".into())
    }
}

fn unprotect(data: &[u8]) -> Result<String, String> {
    if data.is_empty() {
        return Ok(String::new());
    }
    #[cfg(windows)]
    {
        String::from_utf8(crypt(data, false)?).map_err(|_| "WebDAV 凭据无效，请重新输入".into())
    }
    #[cfg(not(windows))]
    {
        Err("WebDAV 凭据读取目前仅支持 Windows".into())
    }
}

fn collection_url(value: &str) -> Result<Url, String> {
    let mut url = Url::parse(value).map_err(|_| "WebDAV 地址格式无效")?;
    let local_http = url.scheme() == "http"
        && url.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
    if url.scheme() != "https" && !local_http {
        return Err("WebDAV 必须使用 HTTPS（本机回环地址除外）".into());
    }
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("WebDAV 地址不得包含账号、查询参数或片段".into());
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}

pub(super) struct Client {
    http: reqwest::Client,
    base: Url,
    username: String,
    password: String,
}

impl Client {
    pub(super) fn load(dirs: &Dirs) -> Result<Self, String> {
        let config = load_config(dirs)?;
        Self::new(
            &config.url,
            config.username,
            unprotect(&config.protected_password)?,
        )
    }

    fn new(url: &str, username: String, password: String) -> Result<Self, String> {
        let base = collection_url(url)?;
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(45))
            .connect_timeout(Duration::from_secs(10))
            .user_agent(concat!("ClashNova/", env!("CARGO_PKG_VERSION")))
            .no_proxy()
            .build()
            .map_err(|_| "创建 WebDAV 客户端失败")?;
        Ok(Self {
            http,
            base,
            username,
            password,
        })
    }

    fn request(&self, method: Method, url: Url) -> reqwest::RequestBuilder {
        let builder = self.http.request(method, url);
        if self.username.is_empty() && self.password.is_empty() {
            builder
        } else {
            builder.basic_auth(&self.username, Some(&self.password))
        }
    }

    fn file_url(&self, id: &str) -> Result<Url, String> {
        validate_id(id)?;
        self.base
            .join(&format!("{id}{EXTENSION}"))
            .map_err(|_| "WebDAV 文件地址无效".into())
    }

    pub(super) async fn list(&self) -> Result<Vec<BackupEntry>, String> {
        let method = Method::from_bytes(b"PROPFIND").map_err(|_| "WebDAV 方法无效")?;
        let response = self.request(method, self.base.clone()).header("Depth", "1")
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>"#)
            .send().await.map_err(request_error)?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        if response.status() != StatusCode::MULTI_STATUS {
            return Err(status_error(response.status()));
        }
        parse_listing(&self.base, &response_text(response, MAX_XML_BYTES).await?)
    }

    pub(super) async fn upload(&self, snapshot: &Snapshot) -> Result<(), String> {
        let method = Method::from_bytes(b"MKCOL").map_err(|_| "WebDAV 方法无效")?;
        let response = self
            .request(method, self.base.clone())
            .send()
            .await
            .map_err(request_error)?;
        if !matches!(
            response.status(),
            StatusCode::CREATED | StatusCode::METHOD_NOT_ALLOWED
        ) {
            return Err(status_error(response.status()));
        }
        let content = encode_snapshot(snapshot)?;
        let response = self
            .request(Method::PUT, self.file_url(&snapshot.id)?)
            .header("Content-Type", "application/json; charset=utf-8")
            .header("If-None-Match", "*")
            .body(content.clone())
            .send()
            .await
            .map_err(request_error)?;
        if !matches!(
            response.status(),
            StatusCode::OK
                | StatusCode::CREATED
                | StatusCode::NO_CONTENT
                | StatusCode::PRECONDITION_FAILED
        ) {
            return Err(status_error(response.status()));
        }
        // 上传后回读并校验完整内容；412 也只能接受字节一致的既有备份，绝不静默覆盖。
        let stored = self.download(&snapshot.id).await?;
        if encode_snapshot(&stored)? != content {
            return Err("WebDAV 回读校验失败或同名文件内容不同，未覆盖".into());
        }
        Ok(())
    }

    pub(super) async fn download(&self, id: &str) -> Result<Snapshot, String> {
        let response = self
            .request(Method::GET, self.file_url(id)?)
            .send()
            .await
            .map_err(request_error)?;
        if response.status() != StatusCode::OK {
            return Err(status_error(response.status()));
        }
        let snapshot = decode_snapshot(&response_text(response, MAX_ARCHIVE_BYTES).await?)?;
        if snapshot.id != id {
            return Err("WebDAV 文件标识与备份内容不一致".into());
        }
        Ok(snapshot)
    }

    pub(super) async fn delete(&self, id: &str) -> Result<(), String> {
        let response = self
            .request(Method::DELETE, self.file_url(id)?)
            .send()
            .await
            .map_err(request_error)?;
        if !matches!(
            response.status(),
            StatusCode::OK | StatusCode::NO_CONTENT | StatusCode::NOT_FOUND
        ) {
            return Err(status_error(response.status()));
        }
        Ok(())
    }
}

fn request_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "WebDAV 请求超时".into()
    } else if error.is_connect() {
        "WebDAV 连接失败，请检查地址、网络和证书".into()
    } else {
        "WebDAV 请求失败".into()
    }
}

fn status_error(status: StatusCode) -> String {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => "WebDAV 认证失败或没有访问权限".into(),
        StatusCode::CONFLICT => "WebDAV 父目录不存在，请先创建父目录".into(),
        _ if status.is_redirection() => "WebDAV 不跟随重定向，请使用最终目录地址".into(),
        _ => format!("WebDAV 返回 HTTP {}", status.as_u16()),
    }
}

async fn response_text(mut response: reqwest::Response, limit: usize) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("WebDAV 响应超过大小限制".into());
    }
    let mut content = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if chunk.len() > limit.saturating_sub(content.len()) {
            return Err("WebDAV 响应超过大小限制".into());
        }
        content.extend_from_slice(&chunk);
    }
    String::from_utf8(content).map_err(|_| "WebDAV 响应不是 UTF-8 文本".into())
}

#[derive(Default)]
struct Properties {
    status: String,
    size: String,
    collection: bool,
}
#[derive(Default)]
struct DavResponse {
    href: String,
    status: String,
    size: Option<u64>,
    collection: bool,
    success: bool,
}

fn success_status(value: &str) -> bool {
    value
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .is_some_and(|code| (200..300).contains(&code))
}

fn listed_id(base: &Url, href: &str) -> Option<String> {
    let href = href.trim();
    if href.contains('\\') {
        return None;
    }
    let url = base.join(href).ok()?;
    if url.origin() != base.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let filename = url.path().strip_prefix(base.path())?;
    let id = filename.strip_suffix(EXTENSION)?;
    validate_id(id).ok()?;
    // 限定为当前目录直属文件；编码斜杠、遍历、ADS、嵌套目录均不能形成有效 ID。
    if url != base.join(&format!("{id}{EXTENSION}")).ok()? {
        return None;
    }
    Some(id.into())
}

fn parse_listing(base: &Url, xml: &str) -> Result<Vec<BackupEntry>, String> {
    if xml.len() > MAX_XML_BYTES {
        return Err("WebDAV XML 超过大小限制".into());
    }
    let mut reader = NsReader::from_str(xml);
    let mut stack: Vec<String> = Vec::new();
    let mut root_seen = false;
    let mut response = DavResponse::default();
    let mut properties = Properties::default();
    let mut entries = Vec::new();
    let mut ids = HashSet::new();
    loop {
        let (namespace, event) = reader
            .read_resolved_event()
            .map_err(|_| "WebDAV XML 格式无效")?;
        let empty = matches!(&event, Event::Empty(_));
        match event {
            Event::Start(tag) | Event::Empty(tag) => {
                let dav = namespace == ResolveResult::Bound(Namespace(b"DAV:"));
                let name = if dav {
                    String::from_utf8_lossy(tag.local_name().as_ref()).into_owned()
                } else {
                    String::new()
                };
                if stack.is_empty() {
                    if root_seen || name != "multistatus" {
                        return Err("WebDAV 响应不是 DAV multistatus".into());
                    }
                    root_seen = true;
                }
                stack.push(name);
                if stack.len() > 24 {
                    return Err("WebDAV XML 嵌套超过限制".into());
                }
                match stack_path(&stack).as_str() {
                    "multistatus/response" => response = DavResponse::default(),
                    "multistatus/response/propstat" => properties = Properties::default(),
                    "multistatus/response/propstat/prop/resourcetype/collection" => {
                        properties.collection = true
                    }
                    _ => {}
                }
                if empty {
                    finish_element(
                        base,
                        &mut stack,
                        &mut response,
                        &mut properties,
                        &mut entries,
                        &mut ids,
                    )?;
                }
            }
            Event::End(_) => finish_element(
                base,
                &mut stack,
                &mut response,
                &mut properties,
                &mut entries,
                &mut ids,
            )?,
            Event::Text(text) => append_text(
                &stack,
                &mut response,
                &mut properties,
                &text.decode().map_err(|_| "WebDAV XML 编码无效")?,
            ),
            Event::CData(text) => append_text(
                &stack,
                &mut response,
                &mut properties,
                &text.decode().map_err(|_| "WebDAV XML 编码无效")?,
            ),
            Event::GeneralRef(reference) => {
                let decoded = reference.decode().map_err(|_| "WebDAV XML 实体无效")?;
                let text = if let Some(value) = reference
                    .resolve_char_ref()
                    .map_err(|_| "WebDAV XML 字符引用无效")?
                {
                    value.to_string()
                } else {
                    match decoded.as_ref() {
                        "amp" => "&",
                        "lt" => "<",
                        "gt" => ">",
                        "quot" => "\"",
                        "apos" => "'",
                        _ => return Err("WebDAV XML 不允许自定义实体".into()),
                    }
                    .into()
                };
                append_text(&stack, &mut response, &mut properties, &text);
            }
            Event::DocType(_) => return Err("WebDAV XML 不允许 DTD".into()),
            Event::Eof => {
                if !root_seen || !stack.is_empty() {
                    return Err("WebDAV XML 不完整".into());
                }
                break;
            }
            _ => {}
        }
    }
    entries.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(entries)
}

fn stack_path(stack: &[String]) -> String {
    stack.join("/")
}

fn append_text(
    stack: &[String],
    response: &mut DavResponse,
    properties: &mut Properties,
    text: &str,
) {
    match stack_path(stack).as_str() {
        "multistatus/response/href" => response.href.push_str(text),
        "multistatus/response/status" => response.status.push_str(text),
        "multistatus/response/propstat/status" => properties.status.push_str(text),
        "multistatus/response/propstat/prop/getcontentlength" => properties.size.push_str(text),
        _ => {}
    }
}

fn finish_element(
    base: &Url,
    stack: &mut Vec<String>,
    response: &mut DavResponse,
    properties: &mut Properties,
    entries: &mut Vec<BackupEntry>,
    ids: &mut HashSet<String>,
) -> Result<(), String> {
    match stack_path(stack).as_str() {
        "multistatus/response/propstat" if success_status(&properties.status) => {
            response.success = true;
            response.collection |= properties.collection;
            response.size = properties.size.trim().parse().ok().or(response.size);
        }
        "multistatus/response"
            if !response.collection
                && response.success
                && (response.status.is_empty() || success_status(&response.status)) =>
        {
            if let Some(id) = listed_id(base, &response.href) {
                if ids.insert(id.clone()) {
                    let created_at = id
                        .split('-')
                        .nth(1)
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(0);
                    entries.push(BackupEntry {
                        id,
                        label: "远程备份".into(),
                        created_at,
                        app_version: String::new(),
                        size_bytes: response.size.unwrap_or(0),
                        source: "webdav".into(),
                        error: None,
                    });
                    if entries.len() > MAX_FILES {
                        return Err("WebDAV 备份数量超过限制".into());
                    }
                }
            }
        }
        _ => {}
    }
    stack.pop().ok_or("WebDAV XML 结束标签无效")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::tests::Fixture;
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::Instant;

    const ID: &str = "backup-1234567890123-0123456789abcdef";

    fn response_xml(href: &str, size: usize) -> String {
        format!(
            r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>{href}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>{size}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#
        )
    }

    struct Reply {
        method: &'static str,
        status: u16,
        body: String,
        headers: String,
    }
    impl Reply {
        fn new(method: &'static str, status: u16, body: impl Into<String>) -> Self {
            Self {
                method,
                status,
                body: body.into(),
                headers: String::new(),
            }
        }
        fn header(mut self, value: &str) -> Self {
            self.headers = value.into();
            self
        }
    }

    struct Server {
        url: String,
        worker: thread::JoinHandle<()>,
    }
    impl Server {
        fn start(replies: Vec<Reply>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/backups/", listener.local_addr().unwrap());
            listener.set_nonblocking(true).unwrap();
            let worker = thread::spawn(move || {
                for reply in replies {
                    let started = Instant::now();
                    let (mut stream, _) = loop {
                        match listener.accept() {
                            Ok(stream) => break stream,
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                assert!(
                                    started.elapsed() < Duration::from_secs(10),
                                    "fixture request was not received"
                                );
                                thread::sleep(Duration::from_millis(5));
                            }
                            Err(_) => panic!("fixture accept failed"),
                        }
                    };
                    // Windows accept 继承监听器的 nonblocking 属性；正文读取需要显式切回阻塞。
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    let mut buffer = [0u8; 4096];
                    let header_end = loop {
                        let count = stream.read(&mut buffer).unwrap();
                        assert!(count > 0, "request headers incomplete");
                        bytes.extend_from_slice(&buffer[..count]);
                        if let Some(index) = bytes.windows(4).position(|value| value == b"\r\n\r\n")
                        {
                            break index + 4;
                        }
                        assert!(bytes.len() < 16 * 1024, "fixture headers too large");
                    };
                    let headers = String::from_utf8(bytes[..header_end].to_vec())
                        .unwrap()
                        .to_ascii_lowercase();
                    let first_line = headers.lines().next().unwrap();
                    assert_eq!(
                        first_line.split_whitespace().next().unwrap(),
                        reply.method.to_ascii_lowercase()
                    );
                    assert!(first_line
                        .split_whitespace()
                        .nth(1)
                        .unwrap()
                        .starts_with("/backups/"));
                    assert!(
                        headers.contains("authorization: basic "),
                        "missing fixture auth header"
                    );
                    if reply.method == "PROPFIND" {
                        assert!(headers.contains("depth: 1"));
                    }
                    if reply.method == "PUT" {
                        assert!(headers.contains("if-none-match: *"));
                    }
                    let content_length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .map(|value| value.trim().parse().unwrap())
                        .unwrap_or(0);
                    assert!(content_length < 1024 * 1024, "fixture body too large");
                    while bytes.len() < header_end + content_length {
                        let count = stream.read(&mut buffer).unwrap();
                        assert!(count > 0, "request body incomplete");
                        bytes.extend_from_slice(&buffer[..count]);
                    }
                    let response = format!("HTTP/1.1 {} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{}",
                        reply.status, reply.body.len(), reply.headers, reply.body);
                    stream.write_all(response.as_bytes()).unwrap();
                }
            });
            Self { url, worker }
        }
        fn finish(self) {
            self.worker.join().unwrap();
        }
        fn client(&self) -> Client {
            Client::new(&self.url, "fixture-user".into(), "FIXTURE_DAV_ONLY".into()).unwrap()
        }
    }

    #[test]
    fn parses_namespaces_and_char_references_but_rejects_cross_origin_and_nested_hrefs() {
        let base = collection_url("https://dav.example.invalid/backups/").unwrap();
        let xml = response_xml(&format!("/backups/{ID}{EXTENSION}"), 42);
        let entries = parse_listing(&base, &xml).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, ID);
        assert_eq!(entries[0].size_bytes, 42);
        let default_ns = xml
            .replace("<d:", "<")
            .replace("</d:", "</")
            .replace("xmlns:d=", "xmlns=");
        assert_eq!(parse_listing(&base, &default_ns).unwrap().len(), 1);
        let escaped = xml.replace("backup-123", "backup-&#49;23");
        assert_eq!(parse_listing(&base, &escaped).unwrap()[0].id, ID);
        for href in [
            format!("https://other.example.invalid/backups/{ID}{EXTENSION}"),
            format!("//other.example.invalid/backups/{ID}{EXTENSION}"),
            format!("../{ID}{EXTENSION}"),
            format!("nested/{ID}{EXTENSION}"),
            format!("{ID}{EXTENSION}?token=FIXTURE_ONLY"),
            format!("%2f{ID}{EXTENSION}"),
            format!("https://user:FIXTURE_ONLY@dav.example.invalid/backups/{ID}{EXTENSION}"),
        ] {
            assert!(parse_listing(&base, &response_xml(&href, 1))
                .unwrap()
                .is_empty());
        }
        let wrong_namespace = xml.replace("DAV:", "urn:wrong");
        assert!(parse_listing(&base, &wrong_namespace).is_err());
    }

    #[test]
    fn propstat_failures_collections_doctypes_invalid_xml_and_xml_limits_are_checked() {
        let base = collection_url("https://dav.example.invalid/backups/").unwrap();
        let xml = response_xml(&format!("{ID}{EXTENSION}"), 1);
        assert!(
            parse_listing(&base, &xml.replace("200 OK", "404 Not Found"))
                .unwrap()
                .is_empty()
        );
        assert!(parse_listing(
            &base,
            &xml.replace(
                "<d:resourcetype/>",
                "<d:resourcetype><d:collection/></d:resourcetype>"
            )
        )
        .unwrap()
        .is_empty());
        for content in [
            "<!DOCTYPE x [<!ENTITY local SYSTEM 'file:///fixture'>]><x/>".into(),
            "<d:multistatus xmlns:d='DAV:'>".into(),
            format!("{xml}{xml}"),
            xml.replace(ID, "&unknown;"),
            " ".repeat(MAX_XML_BYTES + 1),
            format!(
                "<multistatus xmlns='DAV:'>{}{}</multistatus>",
                "<x>".repeat(25),
                "</x>".repeat(25)
            ),
        ] {
            assert!(parse_listing(&base, &content).is_err());
        }
    }

    #[test]
    fn only_https_or_literal_loopback_http_is_accepted_and_credentials_are_separate() {
        for value in [
            "http://dav.example.invalid/backups",
            "ftp://127.0.0.1/backups",
            "https://user:FIXTURE_ONLY@dav.example.invalid/",
            "https://dav.example.invalid/?token=FIXTURE_ONLY",
            "https://dav.example.invalid/#fragment",
        ] {
            assert!(collection_url(value).is_err());
        }
        for value in [
            "http://127.0.0.1:1234/backups",
            "http://[::1]:1234/backups",
            "https://dav.example.invalid/backups",
        ] {
            assert!(collection_url(value).unwrap().path().ends_with('/'));
        }
    }

    #[tokio::test]
    async fn real_http_fixture_exercises_mkcol_put_propfind_get_delete_and_upload_readback() {
        let fixture = Fixture::new();
        let snapshot = fixture.snapshot();
        let content = encode_snapshot(&snapshot).unwrap();
        let listing = response_xml(
            &format!("/backups/{}{EXTENSION}", snapshot.id),
            content.len(),
        );
        let server = Server::start(vec![
            Reply::new("MKCOL", 201, ""),
            Reply::new("PUT", 201, ""),
            Reply::new("GET", 200, &content),
            Reply::new("PROPFIND", 207, listing),
            Reply::new("GET", 200, &content),
            Reply::new("DELETE", 204, ""),
        ]);
        let client = server.client();
        client.upload(&snapshot).await.unwrap();
        let entries = client.list().await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, snapshot.id);
        assert_eq!(
            encode_snapshot(&client.download(&snapshot.id).await.unwrap()).unwrap(),
            content
        );
        client.delete(&snapshot.id).await.unwrap();
        server.finish();
    }

    #[tokio::test]
    async fn redirects_are_not_followed_and_server_errors_do_not_leak_credentials() {
        let server = Server::start(vec![Reply::new("PROPFIND", 302, "FIXTURE_SERVER_BODY")
            .header("Location: https://other.example.invalid/private?token=FIXTURE_ONLY\r\n")]);
        let error = server.client().list().await.err().unwrap();
        assert!(error.contains("重定向"));
        assert!(!error.contains("FIXTURE"));
        server.finish();
        let server = Server::start(vec![Reply::new("PROPFIND", 401, "FIXTURE_SERVER_BODY")]);
        let error = server.client().list().await.err().unwrap();
        assert!(error.contains("认证失败"));
        assert!(!error.contains("FIXTURE"));
        server.finish();
    }

    #[tokio::test]
    async fn upload_conflict_corrupted_download_and_missing_collection_are_explicit() {
        let fixture = Fixture::new();
        let snapshot = fixture.snapshot();
        let mut different = snapshot.clone();
        different.label = "different fixture".into();
        let server = Server::start(vec![
            Reply::new("MKCOL", 405, ""),
            Reply::new("PUT", 412, ""),
            Reply::new("GET", 200, encode_snapshot(&different).unwrap()),
        ]);
        assert!(server
            .client()
            .upload(&snapshot)
            .await
            .unwrap_err()
            .contains("未覆盖"));
        server.finish();
        let mut corrupted = snapshot.clone();
        corrupted
            .files
            .get_mut("settings.json")
            .unwrap()
            .content
            .push(' ');
        let server = Server::start(vec![Reply::new(
            "GET",
            200,
            encode_snapshot(&corrupted).unwrap(),
        )]);
        assert!(server
            .client()
            .download(&snapshot.id)
            .await
            .err()
            .unwrap()
            .contains("SHA-256"));
        server.finish();
        let server = Server::start(vec![Reply::new("PROPFIND", 404, "")]);
        assert!(server.client().list().await.unwrap().is_empty());
        server.finish();
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_credentials_roundtrip_never_return_plaintext_or_reuse_it_for_other_accounts() {
        let fixture = Fixture::new();
        std::fs::remove_file(fixture.dirs.config.join(CONFIG_NAME)).unwrap();
        save_config(
            &fixture.dirs,
            WebDavConfigInput {
                url: "https://dav.example.invalid/backups/".into(),
                username: "fixture-user".into(),
                password: Some("FIXTURE_DAV_ONLY".into()),
            },
        )
        .unwrap();
        let stored = load_config(&fixture.dirs).unwrap();
        assert_ne!(stored.protected_password, b"FIXTURE_DAV_ONLY");
        assert_eq!(
            unprotect(&stored.protected_password).unwrap(),
            "FIXTURE_DAV_ONLY"
        );
        let public = serde_json::to_string(&get_config(&fixture.dirs).unwrap()).unwrap();
        assert!(!public.contains("FIXTURE_DAV_ONLY"));
        assert!(get_config(&fixture.dirs).unwrap().password_saved);
        save_config(
            &fixture.dirs,
            WebDavConfigInput {
                url: stored.url.clone(),
                username: stored.username.clone(),
                password: None,
            },
        )
        .unwrap();
        for (url, username) in [
            ("https://other.example.invalid/backups/", "fixture-user"),
            ("https://dav.example.invalid/backups/", "other-user"),
        ] {
            assert!(save_config(
                &fixture.dirs,
                WebDavConfigInput {
                    url: url.into(),
                    username: username.into(),
                    password: None
                }
            )
            .is_err());
        }
        assert_eq!(
            unprotect(&load_config(&fixture.dirs).unwrap().protected_password).unwrap(),
            "FIXTURE_DAV_ONLY"
        );
        save_config(
            &fixture.dirs,
            WebDavConfigInput {
                url: String::new(),
                username: String::new(),
                password: None,
            },
        )
        .unwrap();
        assert!(!get_config(&fixture.dirs).unwrap().password_saved);
    }

    #[cfg(windows)]
    #[test]
    fn damaged_webdav_config_can_be_replaced_by_explicit_credentials_or_cleared() {
        let fixture = Fixture::new();
        assert!(load_config(&fixture.dirs).is_err());
        save_config(
            &fixture.dirs,
            WebDavConfigInput {
                url: "https://dav.example.invalid/backups/".into(),
                username: "fixture-user".into(),
                password: Some("FIXTURE_REPLACEMENT_ONLY".into()),
            },
        )
        .unwrap();
        assert_eq!(
            unprotect(&load_config(&fixture.dirs).unwrap().protected_password).unwrap(),
            "FIXTURE_REPLACEMENT_ONLY"
        );
        std::fs::write(fixture.dirs.config.join(CONFIG_NAME), "broken-json").unwrap();
        save_config(
            &fixture.dirs,
            WebDavConfigInput {
                url: String::new(),
                username: String::new(),
                password: None,
            },
        )
        .unwrap();
        assert!(!get_config(&fixture.dirs).unwrap().password_saved);
    }
}
