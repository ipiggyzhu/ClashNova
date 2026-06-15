use crate::types::*;
use anyhow::{Context, Result};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::fs::OpenOptions;
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
#[cfg(windows)]
use windows::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
#[cfg(windows)]
use windows::Win32::System::Pipes::{
    CreateNamedPipeW, ConnectNamedPipe, DisconnectNamedPipe, PIPE_READMODE_BYTE,
    PIPE_TYPE_BYTE, PIPE_WAIT, PIPE_UNLIMITED_INSTANCES,
};

/// 内核管理器
struct CoreManager {
    /// 当前运行的内核进程
    process: Option<Child>,
    /// 进程启动时间
    start_time: Option<i64>,
    /// 内核配置
    config: Option<CoreConfig>,
    /// 日志缓冲区（最多保留 1000 行）
    logs: VecDeque<String>,
}

impl CoreManager {
    fn new() -> Self {
        Self {
            process: None,
            start_time: None,
            config: None,
            logs: VecDeque::with_capacity(1000),
        }
    }

    /// 启动内核
    fn start(&mut self, config: CoreConfig) -> Result<()> {
        // 如果已经在运行，先停止
        if self.is_running() {
            self.stop()?;
        }

        log::info!("启动内核: {}", config.core_path);
        log::info!("配置文件: {}", config.config_path);
        log::info!("外部控制器: {}", config.external_controller);

        // 启动 mihomo 进程
        let child = Command::new(&config.core_path)
            .args(["-f", &config.config_path])
            .args(["-d", &config.config_dir])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("启动内核进程失败")?;

        let start_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        self.process = Some(child);
        self.start_time = Some(start_time);
        self.config = Some(config);

        log::info!("内核进程已启动");
        Ok(())
    }

    /// 停止内核
    fn stop(&mut self) -> Result<()> {
        if let Some(mut process) = self.process.take() {
            log::info!("停止内核进程 PID: {:?}", process.id());

            // 尝试优雅停止
            if let Err(e) = process.kill() {
                log::warn!("终止进程失败: {}", e);
            }

            // 等待进程退出
            if let Err(e) = process.wait() {
                log::warn!("等待进程退出失败: {}", e);
            }

            log::info!("内核进程已停止");
        }

        self.start_time = None;
        Ok(())
    }

    /// 检查内核是否正在运行
    fn is_running(&mut self) -> bool {
        if let Some(process) = &mut self.process {
            // 检查进程是否还活着
            match process.try_wait() {
                Ok(Some(status)) => {
                    log::warn!("内核进程已退出: {:?}", status);
                    self.process = None;
                    self.start_time = None;
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
        }
    }

    /// 添加日志
    fn add_log(&mut self, line: String) {
        if self.logs.len() >= 1000 {
            self.logs.pop_front();
        }
        self.logs.push_back(line);
    }

    /// 获取日志
    fn get_logs(&self, lines: usize) -> Vec<String> {
        let count = lines.min(self.logs.len());
        self.logs.iter().rev().take(count).rev().cloned().collect()
    }
}

/// IPC 服务端
pub struct IpcServer {
    core_manager: Arc<Mutex<CoreManager>>,
}

impl IpcServer {
    pub fn new() -> Self {
        Self {
            core_manager: Arc::new(Mutex::new(CoreManager::new())),
        }
    }

    /// 处理客户端请求
    fn handle_request(&self, request: ServiceRequest) -> ServiceResponse<serde_json::Value> {
        match request.command.as_str() {
            "ping" => ServiceResponse::success(serde_json::json!({})),

            "start" => {
                let config: CoreConfig = match request.data {
                    Some(data) => match serde_json::from_str(&data) {
                        Ok(c) => c,
                        Err(e) => return ServiceResponse::error(1, format!("解析配置失败: {}", e)),
                    },
                    None => return ServiceResponse::error(1, "缺少内核配置".to_string()),
                };

                let mut manager = self.core_manager.lock().unwrap();
                match manager.start(config) {
                    Ok(_) => ServiceResponse::success(serde_json::json!({})),
                    Err(e) => ServiceResponse::error(2, format!("启动内核失败: {}", e)),
                }
            }

            "stop" => {
                let mut manager = self.core_manager.lock().unwrap();
                match manager.stop() {
                    Ok(_) => ServiceResponse::success(serde_json::json!({})),
                    Err(e) => ServiceResponse::error(3, format!("停止内核失败: {}", e)),
                }
            }

            "status" => {
                let mut manager = self.core_manager.lock().unwrap();
                let status = manager.get_status();
                ServiceResponse::success(serde_json::to_value(status).unwrap())
            }

            "logs" => {
                let lines: usize = request
                    .data
                    .and_then(|d| d.parse().ok())
                    .unwrap_or(100);

                let manager = self.core_manager.lock().unwrap();
                let logs = manager.get_logs(lines);
                ServiceResponse::success(serde_json::to_value(logs).unwrap())
            }

            "version" => {
                let version = ServiceVersion {
                    version: env!("CARGO_PKG_VERSION").to_string(),
                };
                ServiceResponse::success(serde_json::to_value(version).unwrap())
            }

            _ => ServiceResponse::error(404, format!("未知命令: {}", request.command)),
        }
    }

    /// 启动 IPC 服务（Windows 命名管道）
    #[cfg(windows)]
    pub fn run(&self) -> Result<()> {
        use windows::core::PCWSTR;

        log::info!("启动 IPC 服务: {}", IPC_PATH);

        let pipe_name: Vec<u16> = IPC_PATH.encode_utf16().chain(std::iter::once(0)).collect();

        loop {
            // 创建命名管道
            let h_pipe = unsafe {
                CreateNamedPipeW(
                    PCWSTR(pipe_name.as_ptr()),
                    PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                    PIPE_UNLIMITED_INSTANCES,
                    8192, // 输出缓冲区大小
                    8192, // 输入缓冲区大小
                    0,    // 默认超时
                    None, // 默认安全属性
                )
            };

            if h_pipe.is_invalid() {
                log::error!("创建命名管道失败");
                std::thread::sleep(std::time::Duration::from_secs(1));
                continue;
            }

            log::info!("等待客户端连接...");

            // 等待客户端连接
            let connected = unsafe { ConnectNamedPipe(h_pipe, None) };
            if connected.is_err() {
                log::warn!("客户端连接失败");
                unsafe { windows::Win32::Foundation::CloseHandle(h_pipe).ok(); }
                continue;
            }

            log::info!("客户端已连接");

            // 使用标准库的文件 API 包装句柄
            let pipe_file = unsafe {
                use std::os::windows::io::FromRawHandle;
                std::fs::File::from_raw_handle(h_pipe.0 as *mut _)
            };

            let mut reader = BufReader::new(&pipe_file);
            let mut writer = BufWriter::new(&pipe_file);

            // 读取请求
            let mut request_line = String::new();
            match reader.read_line(&mut request_line) {
                Ok(0) => {
                    log::warn!("客户端断开连接");
                    continue;
                }
                Err(e) => {
                    log::error!("读取请求失败: {}", e);
                    continue;
                }
                _ => {}
            }

            // 解析请求
            let request: ServiceRequest = match serde_json::from_str(&request_line) {
                Ok(r) => r,
                Err(e) => {
                    log::error!("解析请求失败: {}", e);
                    continue;
                }
            };

            log::info!("收到命令: {}", request.command);

            // 处理请求
            let response = self.handle_request(request);

            // 发送响应
            let response_json = match serde_json::to_string(&response) {
                Ok(j) => j,
                Err(e) => {
                    log::error!("序列化响应失败: {}", e);
                    continue;
                }
            };

            if let Err(e) = writeln!(writer, "{}", response_json) {
                log::error!("发送响应失败: {}", e);
            }

            if let Err(e) = writer.flush() {
                log::error!("刷新管道失败: {}", e);
            }

            log::info!("响应已发送");

            // 断开连接
            unsafe {
                DisconnectNamedPipe(h_pipe).ok();
            }
        }
    }

    #[cfg(not(windows))]
    pub fn run(&self) -> Result<()> {
        anyhow::bail!("IPC 服务仅支持 Windows 平台")
    }
}

/// 启动 IPC 服务器
pub fn start_server() -> Result<()> {
    let server = IpcServer::new();
    server.run()
}
