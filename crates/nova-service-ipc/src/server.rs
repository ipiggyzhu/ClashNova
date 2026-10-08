use crate::policy::ServicePolicy;
use crate::types::*;
use anyhow::{Context, Result};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
#[cfg(windows)]
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// 内核管理器
struct CoreManager {
    /// 当前运行的内核进程
    process: Option<Child>,
    /// 进程启动时间
    start_time: Option<i64>,
    /// 内核配置
    config: Option<CoreConfig>,
    /// mihomo 版本
    core_version: Option<String>,
    /// 日志缓冲区（最多保留 1000 行）
    logs: Arc<Mutex<VecDeque<String>>>,
    /// 是否启用自动重启
    auto_restart: bool,
    /// 崩溃次数（用于防止无限重启）
    crash_count: u32,
    /// 最后一次崩溃时间
    last_crash_time: Option<i64>,
    restart_at: Option<i64>,
}

impl Drop for CoreManager {
    fn drop(&mut self) {
        if let Err(err) = self.stop() {
            log::error!("关闭服务内核管理器失败: {err}");
        }
    }
}

impl CoreManager {
    fn new() -> Self {
        Self {
            process: None,
            start_time: None,
            config: None,
            core_version: None,
            logs: Arc::new(Mutex::new(VecDeque::with_capacity(1000))),
            auto_restart: true,
            crash_count: 0,
            last_crash_time: None,
            restart_at: None,
        }
    }

    fn push_log(&self, line: String) {
        if let Ok(mut logs) = self.logs.lock() {
            if logs.len() >= 1000 {
                logs.pop_front();
            }
            logs.push_back(line);
        }
    }

    fn drain_pipe<R>(label: &'static str, pipe: R, lines: Arc<Mutex<VecDeque<String>>>)
    where
        R: Read + Send + 'static,
    {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(pipe);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let text = line.trim_end_matches(['\r', '\n']).to_string();
                        if text.is_empty() {
                            continue;
                        }
                        log::info!("[mihomo {label}] {text}");
                        if let Ok(mut logs) = lines.lock() {
                            if logs.len() >= 1000 {
                                logs.pop_front();
                            }
                            logs.push_back(format!("[{label}] {text}"));
                        }
                    }
                    Err(err) => {
                        log::warn!("读取 mihomo {label} 失败: {err}");
                        break;
                    }
                }
            }
        });
    }

    fn attach_output_logs(
        stdout: Option<ChildStdout>,
        stderr: Option<ChildStderr>,
        logs: Arc<Mutex<VecDeque<String>>>,
    ) {
        if let Some(stdout) = stdout {
            Self::drain_pipe("stdout", stdout, logs.clone());
        }
        if let Some(stderr) = stderr {
            Self::drain_pipe("stderr", stderr, logs);
        }
    }

    fn read_core_version(core_path: &str) -> Option<String> {
        use std::time::{Duration, Instant};
        let mut child = Command::new(core_path)
            .arg("-v")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let Some(mut stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        };
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 1024];
            while let Ok(count) = stdout.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                bytes
                    .extend_from_slice(&buffer[..count.min(4096usize.saturating_sub(bytes.len()))]);
            }
            let _ = tx.send(bytes);
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => break,
                Ok(Some(_)) => return None,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
        let bytes = rx.recv_timeout(Duration::from_millis(250)).ok()?;
        let text = String::from_utf8_lossy(&bytes);
        let first_line = text.lines().next()?.trim();
        if first_line.is_empty() {
            return None;
        }

        first_line
            .split_whitespace()
            .find(|part| {
                part.starts_with('v')
                    && part[1..]
                        .chars()
                        .next()
                        .is_some_and(|ch| ch.is_ascii_digit())
            })
            .map(|part| part.to_string())
            .or_else(|| Some(first_line.to_string()))
    }

    /// 启动内核
    fn start(&mut self, config: CoreConfig) -> Result<()> {
        self.reset_crash_count();
        self.start_process(config)
    }

    fn start_process(&mut self, config: CoreConfig) -> Result<()> {
        self.stop()?;
        self.config = Some(config.clone());

        log::info!("启动内核: {}", config.core_path);
        log::info!("配置文件: {}", config.config_path);
        log::info!("外部控制器: {}", config.external_controller);
        let core_version = Self::read_core_version(&config.core_path);
        if let Some(version) = &core_version {
            log::info!("mihomo 版本: {}", version);
        }

        // 启动 mihomo 进程
        let mut child = Command::new(&config.core_path)
            .args(["-f", &config.config_path])
            .args(["-d", &config.config_dir])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("启动内核进程失败")?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let start_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        self.process = Some(child);
        self.start_time = Some(start_time);
        self.config = Some(config);
        self.core_version = core_version;
        self.restart_at = None;
        self.push_log("内核进程已启动".into());
        Self::attach_output_logs(stdout, stderr, self.logs.clone());

        log::info!("内核进程已启动");
        Ok(())
    }

    /// 停止内核
    fn stop(&mut self) -> Result<()> {
        self.restart_at = None;
        if let Some(process) = self.process.as_mut() {
            log::info!("停止内核进程 PID: {:?}", process.id());

            // 尝试优雅停止
            if process
                .try_wait()
                .context("检查内核退出状态失败")?
                .is_none()
            {
                process.kill().context("终止内核进程失败")?;
            }
            process.wait().context("等待内核退出失败")?;

            log::info!("内核进程已停止");
        }
        self.process = None;
        self.start_time = None;
        self.core_version = None;
        Ok(())
    }

    /// 检查内核是否正在运行
    fn is_running(&mut self) -> bool {
        if let Some(process) = &mut self.process {
            // 检查进程是否还活着
            match process.try_wait() {
                Ok(Some(status)) => {
                    let message = format!("内核进程已退出: {:?}", status);
                    log::warn!("{message}");
                    self.push_log(message);
                    self.process = None;
                    self.start_time = None;
                    self.core_version = None;
                    self.record_crash(Self::now());
                    false
                }
                Ok(None) => true,
                Err(e) => {
                    log::error!("检查进程状态失败: {}", e);
                    false
                }
            }
        } else {
            false
        }
    }

    /// 获取内核状态
    fn get_status(&mut self) -> CoreStatus {
        let running = self.is_running();
        let pid = if running {
            self.process.as_ref().map(|p| p.id())
        } else {
            None
        };

        CoreStatus {
            running,
            pid,
            start_time: if running { self.start_time } else { None },
            version: if running {
                self.core_version.clone()
            } else {
                None
            },
        }
    }

    /// 添加日志
    #[allow(dead_code)]
    fn add_log(&mut self, line: String) {
        self.push_log(line);
    }

    /// 获取日志
    fn get_logs(&self, lines: usize) -> Vec<String> {
        let Ok(logs) = self.logs.lock() else {
            return Vec::new();
        };
        let count = lines.min(logs.len());
        logs.iter().rev().take(count).rev().cloned().collect()
    }

    /// 检查进程是否崩溃并决定是否重启
    fn check_and_restart(&mut self) -> bool {
        if self.is_running() {
            return true;
        }
        let now = Self::now();
        if !self.should_auto_restart(now) {
            return false;
        }
        if let Some(config) = self.config.clone() {
            if let Err(err) = self.start_process(config) {
                log::error!("自动重启失败: {err}");
                self.record_crash(now);
                return false;
            }
            log::info!("内核已自动重启");
            return true;
        }
        false
    }

    fn now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64
    }

    /// 记录崩溃
    fn record_crash(&mut self, now: i64) {
        // 如果距离上次崩溃超过 5 分钟，重置计数
        if let Some(last_crash) = self.last_crash_time {
            if now - last_crash > 300 {
                self.crash_count = 0;
            }
        }

        self.crash_count += 1;
        self.last_crash_time = Some(now);
        self.restart_at = (self.auto_restart && self.crash_count <= 5).then_some(now + 10);
    }

    /// 判断是否应该自动重启
    fn should_auto_restart(&self, now: i64) -> bool {
        self.auto_restart
            && self.config.is_some()
            && self.crash_count <= 5
            && self.restart_at.is_some_and(|deadline| now >= deadline)
    }

    /// 启用/禁用自动重启
    #[allow(dead_code)]
    fn set_auto_restart(&mut self, enabled: bool) {
        self.auto_restart = enabled;
        log::info!("自动重启已{}", if enabled { "启用" } else { "禁用" });
    }

    /// 重置崩溃计数
    #[allow(dead_code)]
    fn reset_crash_count(&mut self) {
        self.crash_count = 0;
        self.last_crash_time = None;
        self.restart_at = None;
        log::info!("崩溃计数已重置");
    }
}

/// IPC 服务端
pub struct IpcServer {
    core_manager: Arc<Mutex<CoreManager>>,
    policy: Arc<ServicePolicy>,
}

impl IpcServer {
    pub fn new(policy: ServicePolicy) -> Self {
        Self {
            core_manager: Arc::new(Mutex::new(CoreManager::new())),
            policy: Arc::new(policy),
        }
    }

    pub fn run(&self) -> Result<()> {
        self.run_with_ready_signal(None)
    }

    #[cfg(windows)]
    pub fn run_with_ready_signal(
        &self,
        mut ready_tx: Option<mpsc::Sender<Result<()>>>,
    ) -> Result<()> {
        use std::time::Duration;
        use tokio::net::windows::named_pipe::ServerOptions;
        use tokio::sync::Semaphore;

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let result: Result<()> = runtime.block_on(async {
            let security = self.policy.pipe_security()?;
            let mut attributes = security.attributes();
            let mut options = ServerOptions::new();
            options
                .max_instances(8)
                .reject_remote_clients(true)
                .first_pipe_instance(true);
            let mut listener = unsafe {
                options.create_with_security_attributes_raw(
                    IPC_PATH,
                    (&mut attributes as *mut windows::Win32::Security::SECURITY_ATTRIBUTES).cast(),
                )
            }
            .context("创建受保护的服务管道失败")?;
            options.first_pipe_instance(false);
            if let Some(tx) = ready_tx.take() {
                let _ = tx.send(Ok(()));
            }

            let manager = self.core_manager.clone();
            let policy = self.policy.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(1));
                loop {
                    interval.tick().await;
                    let manager = manager.clone();
                    let policy = policy.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        if let Ok(mut manager) = manager.lock() {
                            // 配置目录可能在运行期间被替换, 自动重启前重新检查边界。
                            if let Some(config) = manager.config.as_ref() {
                                if policy.validate(config).is_err() {
                                    manager.restart_at = None;
                                    return;
                                }
                            }
                            manager.check_and_restart();
                        }
                    })
                    .await;
                }
            });

            // 七个活动请求加一个监听实例, 不为每次连接无限创建线程。
            let slots = Arc::new(Semaphore::new(7));
            loop {
                listener.connect().await.context("等待服务客户端失败")?;
                let permit = slots.clone().acquire_owned().await?;
                let next = unsafe {
                    options.create_with_security_attributes_raw(
                        IPC_PATH,
                        (&mut attributes as *mut windows::Win32::Security::SECURITY_ATTRIBUTES)
                            .cast(),
                    )
                }
                .context("创建下一个管道实例失败")?;
                let pipe = std::mem::replace(&mut listener, next);
                let manager = self.core_manager.clone();
                let policy = self.policy.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Err(err) = Self::handle_client(pipe, manager, policy).await {
                        log::warn!("服务请求失败: {err}");
                    }
                });
            }
            #[allow(unreachable_code)]
            Ok(())
        });
        if let (Err(err), Some(tx)) = (&result, ready_tx.take()) {
            let _ = tx.send(Err(anyhow::anyhow!(err.to_string())));
        }
        result
    }

    #[cfg(windows)]
    async fn handle_client(
        pipe: tokio::net::windows::named_pipe::NamedPipeServer,
        core_manager: Arc<Mutex<CoreManager>>,
        policy: Arc<ServicePolicy>,
    ) -> Result<()> {
        use std::time::Duration;
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        let mut reader = BufReader::new(pipe);
        let mut bytes = Vec::new();
        {
            let mut limited = (&mut reader).take((MAX_REQUEST_BYTES + 1) as u64);
            tokio::time::timeout(
                Duration::from_secs(5),
                limited.read_until(b'\n', &mut bytes),
            )
            .await
            .context("读取请求超时")??;
        }
        if bytes.len() > MAX_REQUEST_BYTES || bytes.last() != Some(&b'\n') {
            anyhow::bail!("请求过长或未完整结束");
        }
        let request: ServiceRequest =
            serde_json::from_slice(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes))
                .context("请求不是有效 JSON")?;
        let response = tokio::task::spawn_blocking(move || {
            Self::handle_request_static(request, core_manager, &policy)
        })
        .await
        .context("服务请求执行失败")?;
        let mut response = serde_json::to_vec(&response)?;
        response.push(b'\n');
        if response.len() > MAX_RESPONSE_BYTES {
            anyhow::bail!("服务响应过长");
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            reader.get_mut().write_all(&response).await?;
            reader.get_mut().flush().await
        })
        .await
        .context("写入响应超时")??;
        // 保持管道直到客户端读完并关闭, 避免 DisconnectNamedPipe 丢弃未读响应。
        // 恶意客户端不关闭也只占用有界时间, 不调用会无限阻塞的 FlushFileBuffers。
        let mut tail = [0u8; 1];
        let _ = tokio::time::timeout(Duration::from_secs(2), reader.read(&mut tail)).await;
        Ok(())
    }

    fn handle_request_static(
        request: ServiceRequest,
        core_manager: Arc<Mutex<CoreManager>>,
        policy: &ServicePolicy,
    ) -> ServiceResponse<serde_json::Value> {
        match request.command.as_str() {
            "ping" => ServiceResponse::ok(),
            "start" => {
                let config: CoreConfig = match request.data.as_deref().map(serde_json::from_str) {
                    Some(Ok(config)) => config,
                    _ => return ServiceResponse::error(400, "内核配置无效".into()),
                };
                if let Err(err) = policy.validate(&config) {
                    return ServiceResponse::error(403, err.to_string());
                }
                let Ok(mut manager) = core_manager.lock() else {
                    return ServiceResponse::error(500, "内核管理器不可用".into());
                };
                match manager.start(config) {
                    Ok(()) => ServiceResponse::ok(),
                    Err(err) => ServiceResponse::error(2, format!("启动内核失败: {err}")),
                }
            }
            "stop" => {
                let Ok(mut manager) = core_manager.lock() else {
                    return ServiceResponse::error(500, "内核管理器不可用".into());
                };
                match manager.stop() {
                    Ok(()) => ServiceResponse::ok(),
                    Err(err) => ServiceResponse::error(3, format!("停止内核失败: {err}")),
                }
            }
            "status" => {
                let Ok(mut manager) = core_manager.lock() else {
                    return ServiceResponse::error(500, "内核管理器不可用".into());
                };
                ServiceResponse::success(serde_json::to_value(manager.get_status()).unwrap())
            }
            "logs" => {
                let lines: usize = request.data.and_then(|d| d.parse().ok()).unwrap_or(100);
                let Ok(manager) = core_manager.lock() else {
                    return ServiceResponse::error(500, "内核管理器不可用".into());
                };
                ServiceResponse::success(
                    serde_json::to_value(manager.get_logs(lines.min(1000))).unwrap(),
                )
            }
            "version" => ServiceResponse::success(serde_json::json!({
                "version": env!("CARGO_PKG_VERSION"),
                "build_id": option_env!("CLASHNOVA_BUILD_ID").unwrap_or(env!("CARGO_PKG_VERSION")),
            })),
            _ => ServiceResponse::error(404, "未知服务命令".into()),
        }
    }

    #[cfg(not(windows))]
    pub fn run_with_ready_signal(
        &self,
        _ready_tx: Option<std::sync::mpsc::Sender<Result<()>>>,
    ) -> Result<()> {
        anyhow::bail!("IPC 服务仅支持 Windows 平台")
    }
}

pub fn start_server(policy: ServicePolicy) -> Result<()> {
    IpcServer::new(policy).run()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured_manager() -> CoreManager {
        let mut manager = CoreManager::new();
        manager.config = Some(CoreConfig {
            core_path: String::new(),
            config_path: String::new(),
            config_dir: String::new(),
            external_controller: String::new(),
        });
        manager
    }

    #[test]
    fn crash_schedules_a_retry_after_backoff() {
        let mut manager = configured_manager();
        manager.record_crash(100);
        assert!(!manager.should_auto_restart(100));
        assert!(!manager.should_auto_restart(109));
        assert!(manager.should_auto_restart(110));
    }

    #[test]
    fn status_does_not_consume_a_pending_retry() {
        let mut manager = configured_manager();
        manager.record_crash(100);
        assert!(!manager.get_status().running);
        assert!(manager.should_auto_restart(110));
        manager.stop().unwrap();
        assert!(!manager.should_auto_restart(120));
    }

    #[test]
    fn repeated_crashes_exhaust_the_budget() {
        let mut manager = configured_manager();
        for now in [100, 110, 120, 130, 140, 150] {
            manager.record_crash(now);
        }
        assert!(!manager.should_auto_restart(200));
        manager.record_crash(500);
        assert!(manager.should_auto_restart(510));
    }
}
