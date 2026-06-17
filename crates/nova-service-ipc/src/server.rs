use crate::types::*;
use anyhow::{Context, Result};
use std::collections::VecDeque;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::io::{BufRead, BufReader, BufWriter, Write};

#[cfg(windows)]
use windows::Win32::Storage::FileSystem::{PIPE_ACCESS_DUPLEX};
#[cfg(windows)]
use windows::Win32::System::Pipes::{
    CreateNamedPipeW, ConnectNamedPipe, DisconnectNamedPipe, PIPE_READMODE_BYTE,
    PIPE_TYPE_BYTE, PIPE_WAIT, PIPE_UNLIMITED_INSTANCES,
};
#[cfg(windows)]
use windows::Win32::Security::{
    InitializeSecurityDescriptor, SetSecurityDescriptorDacl,
    PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
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
    /// 是否启用自动重启
    auto_restart: bool,
    /// 崩溃次数（用于防止无限重启）
    crash_count: u32,
    /// 最后一次崩溃时间
    last_crash_time: Option<i64>,
}

impl CoreManager {
    fn new() -> Self {
        Self {
            process: None,
            start_time: None,
            config: None,
            logs: VecDeque::with_capacity(1000),
            auto_restart: true,
            crash_count: 0,
            last_crash_time: None,
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
    #[allow(dead_code)]
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

    /// 检查进程是否崩溃并决定是否重启
    fn check_and_restart(&mut self) -> bool {
        // 检查进程是否退出
        if let Some(process) = &mut self.process {
            match process.try_wait() {
                Ok(Some(status)) => {
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_secs() as i64;

                    log::warn!("内核进程已退出: {:?}", status);
                    self.process = None;
                    self.start_time = None;

                    // 记录崩溃
                    self.record_crash(now);

                    // 判断是否应该重启
                    if self.should_auto_restart(now) {
                        log::info!("尝试自动重启内核（崩溃次数: {}）", self.crash_count);
                        if let Some(config) = self.config.clone() {
                            if let Err(e) = self.start(config) {
                                log::error!("自动重启失败: {}", e);
                                return false;
                            }
                            log::info!("自动重启成功");
                            return true;
                        }
                    } else {
                        log::error!("崩溃次数过多，停止自动重启");
                    }

                    return false;
                }
                Ok(None) => {
                    // 进程仍在运行
                    return true;
                }
                Err(e) => {
                    log::error!("检查进程状态失败: {}", e);
                    return false;
                }
            }
        }

        false
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
    }

    /// 判断是否应该自动重启
    fn should_auto_restart(&self, now: i64) -> bool {
        if !self.auto_restart {
            return false;
        }

        // 如果没有配置，不重启
        if self.config.is_none() {
            return false;
        }

        // 如果崩溃次数超过 5 次，不重启
        if self.crash_count > 5 {
            return false;
        }

        // 如果上次崩溃距离现在少于 10 秒，不重启（防止快速崩溃循环）
        if let Some(last_crash) = self.last_crash_time {
            if now - last_crash < 10 {
                return false;
            }
        }

        true
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
        log::info!("崩溃计数已重置");
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

    /// 启动后台监控线程
    #[cfg(windows)]
    fn start_monitor_thread(&self) {
        let manager = self.core_manager.clone();

        std::thread::spawn(move || {
            log::info!("内核监控线程已启动");

            loop {
                // 每 5 秒检查一次
                std::thread::sleep(std::time::Duration::from_secs(5));

                let mut mgr = manager.lock().unwrap();
                mgr.check_and_restart();
            }
        });
    }


    /// 启动 IPC 服务（Windows 命名管道）
    #[cfg(windows)]
    pub fn run(&self) -> Result<()> {
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::CloseHandle;

        log::info!("启动 IPC 服务: {}", IPC_PATH);

        // 启动后台监控线程
        self.start_monitor_thread();

        let pipe_name: Vec<u16> = IPC_PATH.encode_utf16().chain(std::iter::once(0)).collect();

        // 创建允许所有用户访问的安全描述符
        let mut sd_buffer = vec![0u8; 1024]; // 足够大的缓冲区
        let psd = PSECURITY_DESCRIPTOR(sd_buffer.as_mut_ptr() as *mut _);

        let sa = unsafe {
            // 初始化安全描述符 (SECURITY_DESCRIPTOR_REVISION = 1)
            if InitializeSecurityDescriptor(psd, 1).is_err() {
                log::error!("初始化安全描述符失败");
                return Err(anyhow::anyhow!("初始化安全描述符失败"));
            }

            // 设置 NULL DACL (允许所有人访问)
            if SetSecurityDescriptorDacl(psd, true, None, false).is_err() {
                log::error!("设置 DACL 失败");
                return Err(anyhow::anyhow!("设置 DACL 失败"));
            }

            SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: psd.0,
                bInheritHandle: false.into(),
            }
        };

        loop {
            // 创建命名管道 - 使用自定义安全描述符允许所有用户访问
            let h_pipe = unsafe {
                CreateNamedPipeW(
                    PCWSTR(pipe_name.as_ptr()),
                    PIPE_ACCESS_DUPLEX,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                    PIPE_UNLIMITED_INSTANCES,
                    8192, // 输出缓冲区大小
                    8192, // 输入缓冲区大小
                    0,    // 默认超时
                    Some(&sa as *const _ as *const _), // 自定义安全属性
                )
            };

            if h_pipe.is_invalid() {
                let error = std::io::Error::last_os_error();
                log::error!("创建命名管道失败: {}", error);
                std::thread::sleep(std::time::Duration::from_secs(1));
                continue;
            }

            log::debug!("等待客户端连接...");

            // 等待客户端连接
            let connected = unsafe { ConnectNamedPipe(h_pipe, None) };
            if let Err(e) = connected {
                let error_code = e.code().0;
                // ERROR_PIPE_CONNECTED (535) 表示客户端已经连接
                if error_code != 535 {
                    log::warn!("客户端连接失败: {:?}", e);
                    unsafe { CloseHandle(h_pipe).ok(); }
                    continue;
                }
            }

            log::debug!("客户端已连接");

            // 在新线程中处理客户端请求
            let core_manager = self.core_manager.clone();
            // 将 HANDLE 转换为 raw pointer 以便跨线程传递
            let h_pipe_raw = h_pipe.0 as usize;
            std::thread::spawn(move || {
                use windows::Win32::Foundation::HANDLE;
                // 在新线程中重建 HANDLE
                let h_pipe = HANDLE(h_pipe_raw as *mut _);

                if let Err(e) = Self::handle_client(h_pipe, core_manager) {
                    log::error!("处理客户端请求失败: {}", e);
                }

                // 断开连接并关闭句柄
                unsafe {
                    DisconnectNamedPipe(h_pipe).ok();
                    CloseHandle(h_pipe).ok();
                }
            });
        }
    }

    /// 在独立线程中处理单个客户端
    #[cfg(windows)]
    fn handle_client(h_pipe: windows::Win32::Foundation::HANDLE, core_manager: Arc<Mutex<CoreManager>>) -> Result<()> {
        use std::os::windows::io::{FromRawHandle, IntoRawHandle};

        // 使用标准库的文件 API 包装句柄
        let pipe_file = unsafe {
            std::fs::File::from_raw_handle(h_pipe.0 as *mut _)
        };

        // 读取请求
        let mut request_line = String::new();
        {
            let mut reader = BufReader::new(&pipe_file);
            reader.read_line(&mut request_line)
                .context("读取请求失败")?;
        }

        if request_line.is_empty() {
            log::warn!("客户端发送空请求");
            // 释放 pipe_file 但不关闭句柄
            let _ = pipe_file.into_raw_handle();
            return Ok(());
        }

        // 解析请求
        let request_line = request_line
            .trim_start_matches('\u{feff}')
            .trim_matches(char::from(0))
            .to_string();
        log::debug!("收到原始请求: {}", request_line);
        let request: ServiceRequest = match serde_json::from_str(&request_line) {
            Ok(request) => request,
            Err(err) => {
                log::warn!("解析请求失败: {}", err);
                let response = ServiceResponse::error(400, format!("解析请求失败: {}", err));
                Self::write_response(&pipe_file, &response)?;
                let _ = pipe_file.into_raw_handle();
                return Ok(());
            }
        };

        log::debug!("收到命令: {}", request.command);

        // 处理请求
        let response = Self::handle_request_static(request, core_manager);

        // 发送响应
        Self::write_response(&pipe_file, &response)?;

        log::debug!("响应已发送");

        // 释放 pipe_file 但不关闭句柄（外部会关闭）
        let _ = pipe_file.into_raw_handle();

        Ok(())
    }

    #[cfg(windows)]
    fn write_response(
        pipe_file: &std::fs::File,
        response: &ServiceResponse<serde_json::Value>,
    ) -> Result<()> {
        let response_json = serde_json::to_string(response)
            .context("序列化响应失败")?;

        let mut writer = BufWriter::new(pipe_file);
        writeln!(writer, "{}", response_json)
            .context("发送响应失败")?;
        writer.flush()
            .context("刷新管道失败")?;
        Ok(())
    }

    /// 静态方法处理请求（用于多线程）
    #[cfg(windows)]
    fn handle_request_static(request: ServiceRequest, core_manager: Arc<Mutex<CoreManager>>) -> ServiceResponse<serde_json::Value> {
        match request.command.as_str() {
            "ping" => ServiceResponse::ok(),

            "start" => {
                let config: CoreConfig = match request.data {
                    Some(data) => match serde_json::from_str(&data) {
                        Ok(c) => c,
                        Err(e) => return ServiceResponse::error(1, format!("解析配置失败: {}", e)),
                    },
                    None => return ServiceResponse::error(1, "缺少内核配置".to_string()),
                };

                let mut manager = core_manager.lock().unwrap();
                match manager.start(config) {
                    Ok(_) => ServiceResponse::ok(),
                    Err(e) => ServiceResponse::error(2, format!("启动内核失败: {}", e)),
                }
            }

            "stop" => {
                let mut manager = core_manager.lock().unwrap();
                match manager.stop() {
                    Ok(_) => ServiceResponse::ok(),
                    Err(e) => ServiceResponse::error(3, format!("停止内核失败: {}", e)),
                }
            }

            "status" => {
                let mut manager = core_manager.lock().unwrap();
                let status = manager.get_status();
                ServiceResponse::success(serde_json::to_value(status).unwrap())
            }

            "logs" => {
                let lines: usize = request
                    .data
                    .and_then(|d| d.parse().ok())
                    .unwrap_or(100);

                let manager = core_manager.lock().unwrap();
                let logs = manager.get_logs(lines);
                ServiceResponse::success(serde_json::to_value(logs).unwrap())
            }

            "version" => {
                let version = ServiceVersion {
                    version: env!("CARGO_PKG_VERSION").to_string(),
                    build_id: option_env!("CLASHNOVA_BUILD_ID").unwrap_or(env!("CARGO_PKG_VERSION")).to_string(),
                };
                ServiceResponse::success(serde_json::to_value(version).unwrap())
            }

            _ => ServiceResponse::error(404, format!("未知命令: {}", request.command)),
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
