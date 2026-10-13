//! 更新器共用的固定来源下载与摘要校验；不接收前端提供的 URL。
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use reqwest::{Client, Url};
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const APP_REPO: &str = "ipiggyzhu/ClashNova";
pub const CORE_REPO: &str = "MetaCubeX/mihomo";
pub const MAX_BINARY: u64 = 256 * 1024 * 1024;
pub const MAX_METADATA: u64 = 4 * 1024 * 1024;

#[derive(Clone, Default)]
pub struct Cancellation(Arc<(AtomicBool, tokio::sync::Notify)>);

impl Cancellation {
    pub fn cancel(&self) {
        self.0 .0.store(true, Ordering::Release);
        self.0 .1.notify_waiters();
    }

    pub fn check(&self) -> Result<(), String> {
        if self.0 .0.load(Ordering::Acquire) {
            Err("更新下载已取消".into())
        } else {
            Ok(())
        }
    }

    async fn cancelled(&self) {
        loop {
            let wake = self.0 .1.notified();
            if self.0 .0.load(Ordering::Acquire) {
                return;
            }
            wake.await;
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Asset {
    pub name: String,
    pub size: u64,
    pub digest: Option<String>,
    pub browser_download_url: String,
    pub state: String,
}

#[derive(Debug, Deserialize)]
pub struct Release {
    pub tag_name: String,
    pub draft: bool,
    pub prerelease: bool,
    pub assets: Vec<Asset>,
}

pub fn version_tuple(version: &str) -> Result<[u64; 3], String> {
    let bare = version.strip_prefix('v').unwrap_or(version);
    let parts: Vec<_> = bare.split('.').collect();
    if parts.len() != 3
        || parts.iter().any(|part| {
            part.is_empty()
                || part.len() > 6
                || !part.bytes().all(|byte| byte.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
        })
    {
        return Err("更新版本号不是稳定版 x.y.z".into());
    }
    Ok([
        parts[0].parse().map_err(|_| "版本号超出范围")?,
        parts[1].parse().map_err(|_| "版本号超出范围")?,
        parts[2].parse().map_err(|_| "版本号超出范围")?,
    ])
}

pub fn valid_hash(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn asset_hash(asset: &Asset) -> Result<String, String> {
    let hash = asset
        .digest
        .as_deref()
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .filter(|hash| valid_hash(hash, 64))
        .ok_or("发布资产缺少有效的 GitHub SHA256 摘要，已停止下载")?;
    Ok(hash.to_ascii_lowercase())
}

fn https_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.fragment().is_none()
}

fn allowed_redirect(url: &Url) -> bool {
    https_url(url)
        && matches!(
            url.host_str(),
            Some(
                "github.com"
                    | "api.github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        )
}

pub fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!("ClashNova/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(15 * 60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !allowed_redirect(attempt.url()) {
                attempt.error("更新下载重定向来源不受信任")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| "创建更新网络客户端失败".into())
}

pub fn validate_asset(
    asset: &Asset,
    repo: &str,
    tag: &str,
    name: &str,
    limit: u64,
) -> Result<(), String> {
    if !matches!(repo, APP_REPO | CORE_REPO)
        || asset.state != "uploaded"
        || asset.name != name
        || asset.size == 0
        || asset.size > limit
    {
        return Err("发布资产名称、状态或大小不符合预期".into());
    }
    version_tuple(tag)?;
    let expected = format!("https://github.com/{repo}/releases/download/{tag}/{name}");
    if asset.browser_download_url != expected {
        return Err("发布资产不是预期仓库的 HTTPS 下载地址".into());
    }
    asset_hash(asset)?;
    Ok(())
}

pub async fn api<T: serde::de::DeserializeOwned>(
    client: &Client,
    repo: &str,
    suffix: &str,
) -> Result<T, String> {
    if !matches!(repo, APP_REPO | CORE_REPO)
        || suffix.contains(['?', '#', '\\'])
        || suffix.contains("..") && !suffix.starts_with("compare/")
    {
        return Err("无效的更新元数据地址".into());
    }
    let response = client
        .get(format!("https://api.github.com/repos/{repo}/{suffix}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "读取 GitHub 更新信息失败，请检查网络后重试")?;
    let data = read_limited(response, MAX_METADATA, &Cancellation::default()).await?;
    serde_json::from_slice(&data).map_err(|_| "GitHub 更新元数据格式错误".into())
}

pub async fn read_limited(
    mut response: reqwest::Response,
    limit: u64,
    cancel: &Cancellation,
) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!(
            "更新服务器返回 HTTP {}",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err("更新响应超过大小上限".into());
    }
    let mut bytes = Vec::new();
    loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => return Err("更新下载已取消".into()),
            result = response.chunk() => result.map_err(|_| "读取更新响应失败，原版本未改动")?,
        };
        let Some(chunk) = chunk else { break };
        if bytes.len() as u64 + chunk.len() as u64 > limit {
            return Err("更新响应超过大小上限".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    cancel.check()?;
    Ok(bytes)
}

pub async fn asset_bytes(
    client: &Client,
    asset: &Asset,
    cancel: &Cancellation,
) -> Result<Vec<u8>, String> {
    let response = client
        .get(&asset.browser_download_url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "下载更新元数据失败")?;
    let bytes = read_limited(response, asset.size.min(MAX_METADATA), cancel).await?;
    if bytes.len() as u64 != asset.size
        || format!("{:x}", Sha256::digest(&bytes)) != asset_hash(asset)?
    {
        return Err("更新元数据长度或 SHA256 不匹配".into());
    }
    Ok(bytes)
}

pub async fn download(
    client: &Client,
    asset: &Asset,
    destination: &Path,
    cancel: &Cancellation,
    progress: impl Fn(u64) + Send,
) -> Result<(), String> {
    cancel.check()?;
    let response = tokio::select! {
        _ = cancel.cancelled() => return Err("更新下载已取消".into()),
        result = client.get(&asset.browser_download_url).send() => result.map_err(|_| "连接更新下载服务器失败")?,
    };
    write_response(
        response,
        destination,
        asset.size,
        &asset_hash(asset)?,
        cancel,
        progress,
    )
    .await
}

async fn write_response(
    mut response: reqwest::Response,
    destination: &Path,
    size: u64,
    hash: &str,
    cancel: &Cancellation,
    progress: impl Fn(u64) + Send,
) -> Result<(), String> {
    if !response.status().is_success() {
        return Err(format!("更新下载返回 HTTP {}", response.status().as_u16()));
    }
    if size == 0
        || size > MAX_BINARY
        || response
            .content_length()
            .is_some_and(|length| length != size)
    {
        return Err("更新下载长度与发布信息不一致".into());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| "创建更新暂存文件失败")?;
    let result = async {
        let mut digest = Sha256::new();
        let mut received = 0u64;
        loop {
            let chunk = tokio::select! {
                _ = cancel.cancelled() => return Err("更新下载已取消".into()),
                result = response.chunk() => result.map_err(|_| "更新下载中断，原版本未改动")?,
            };
            let Some(chunk) = chunk else { break };
            received += chunk.len() as u64;
            if received > size {
                return Err("更新下载超过声明大小".into());
            }
            file.write_all(&chunk).map_err(|_| "写入更新暂存文件失败")?;
            digest.update(&chunk);
            progress(received);
        }
        cancel.check()?;
        if received != size || format!("{:x}", digest.finalize()) != hash {
            return Err("更新包长度或 SHA256 不匹配，已丢弃下载".into());
        }
        file.sync_all()
            .map_err(|_| "同步更新暂存文件失败".to_string())
    }
    .await;
    drop(file);
    if result.is_err() {
        let _ = std::fs::remove_file(destination);
    }
    result
}

pub fn checked_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("更新路径必须为绝对路径".into());
    }
    for ancestor in path.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor).map_err(|_| "检查更新路径失败")?;
        if metadata.file_type().is_symlink() {
            return Err("更新路径不接受符号链接".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("更新路径不接受重解析点".into());
            }
        }
    }
    std::fs::canonicalize(path).map_err(|_| "规范化更新路径失败".into())
}

pub fn hash_file(path: &Path, limit: u64) -> Result<String, String> {
    checked_path(path)?;
    let mut file = File::open(path).map_err(|_| "读取更新文件失败")?;
    if !file
        .metadata()
        .map_err(|_| "读取更新文件信息失败")?
        .is_file()
    {
        return Err("更新目标不是普通文件".into());
    }
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    let mut size = 0;
    loop {
        let count = file.read(&mut buffer).map_err(|_| "读取更新文件失败")?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > limit {
            return Err("更新文件超过大小上限".into());
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub fn verify_file(path: &Path, size: u64, hash: &str) -> Result<(), String> {
    if std::fs::metadata(path).map_err(|_| "更新文件不存在")?.len() != size
        || hash_file(path, size)? != hash
    {
        return Err("更新文件已改变，长度或 SHA256 校验失败".into());
    }
    Ok(())
}

pub struct Staging(pub PathBuf);

impl Staging {
    pub fn create(parent: &Path) -> Result<Self, String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::fs::create_dir_all(parent).map_err(|_| "创建更新目录失败")?;
        checked_path(parent)?;
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "系统时间错误")?
            .as_nanos();
        let path = parent.join(format!(
            "stage-{}-{nonce}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).map_err(|_| "创建隔离更新暂存目录失败")?;
        Ok(Self(path))
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        // 本实例独占创建、只写固定文件名；不递归跟随目录/重解析点。
        if checked_path(&self.0).is_err() {
            return;
        }
        if let Ok(entries) = std::fs::read_dir(&self.0) {
            for entry in entries.flatten() {
                if entry.file_type().is_ok_and(|kind| kind.is_file()) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        let _ = std::fs::remove_dir(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn fixture(response: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(&response);
        });
        (url, server)
    }

    #[test]
    fn source_policy_rejects_changed_repo_scheme_name_and_digest() {
        let mut asset = Asset { name: "ClashNova_2.4.8_x64-setup.exe".into(), size: 3,
            digest: Some(format!("sha256:{}", "a".repeat(64))), state: "uploaded".into(),
            browser_download_url: "https://github.com/ipiggyzhu/ClashNova/releases/download/v2.4.8/ClashNova_2.4.8_x64-setup.exe".into() };
        let name = asset.name.clone();
        assert!(validate_asset(&asset, APP_REPO, "v2.4.8", &name, 100).is_ok());
        asset.browser_download_url = asset.browser_download_url.replace("https:", "http:");
        assert!(validate_asset(&asset, APP_REPO, "v2.4.8", &name, 100).is_err());
        asset.browser_download_url = asset
            .browser_download_url
            .replace("http:", "https:")
            .replace("ipiggyzhu", "other");
        assert!(validate_asset(&asset, APP_REPO, "v2.4.8", &name, 100).is_err());
        asset.digest = None;
        assert!(asset_hash(&asset).is_err());
        for url in [
            "https://github.com.evil.invalid/x",
            "http://github.com/x",
            "https://user@github.com/x",
            "https://github.com:444/x",
        ] {
            assert!(!allowed_redirect(&Url::parse(url).unwrap()));
        }
    }

    #[test]
    fn version_parser_rejects_traversal_and_prerelease() {
        for bad in [
            "../../x",
            "v1.2.3/b",
            "v1.2.3-alpha",
            "01.2.3",
            "v1.2",
            "v1.2.9999999",
        ] {
            assert!(version_tuple(bad).is_err(), "{bad}");
        }
        assert!(version_tuple("v1.10.0").unwrap() > version_tuple("v1.9.9").unwrap());
    }

    #[tokio::test]
    async fn download_verifies_and_cleans_hash_mismatch_truncation_oversize_and_cancel() {
        let root = std::env::temp_dir();
        let dir = Staging::create(&root).unwrap();
        for (name, response, hash, cancel, succeeds) in [
            (
                "ok",
                b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc".to_vec(),
                format!("{:x}", Sha256::digest(b"abc")),
                false,
                true,
            ),
            (
                "hash",
                b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc".to_vec(),
                "0".repeat(64),
                false,
                false,
            ),
            (
                "short",
                b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\na".to_vec(),
                "0".repeat(64),
                false,
                false,
            ),
            (
                "long",
                b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nabcd".to_vec(),
                "0".repeat(64),
                false,
                false,
            ),
            (
                "cancel",
                b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc".to_vec(),
                "0".repeat(64),
                true,
                false,
            ),
        ] {
            let (url, server) = fixture(response);
            let response = Client::new().get(url).send().await.unwrap();
            let token = Cancellation::default();
            if cancel {
                token.cancel();
            }
            let path = dir.0.join(name);
            let result = write_response(response, &path, 3, &hash, &token, |_| {}).await;
            assert_eq!(result.is_ok(), succeeds, "{name}: {result:?}");
            assert_eq!(path.exists(), succeeds, "{name}");
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_stalled_response() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n")
                .unwrap();
            std::thread::sleep(Duration::from_millis(500));
        });
        let response = Client::new().get(url).send().await.unwrap();
        let token = Cancellation::default();
        let to_cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            to_cancel.cancel();
        });
        let dir = Staging::create(&std::env::temp_dir()).unwrap();
        let result = tokio::time::timeout(
            Duration::from_millis(250),
            write_response(
                response,
                &dir.0.join("cancel"),
                3,
                &"0".repeat(64),
                &token,
                |_| {},
            ),
        )
        .await;
        assert!(result.unwrap().unwrap_err().contains("取消"));
        assert!(!dir.0.join("cancel").exists());
        server.join().unwrap();
    }
}
