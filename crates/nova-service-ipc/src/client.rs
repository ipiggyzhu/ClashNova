use crate::types::*;
use anyhow::{Context, Result};
use std::path::Path;

#[cfg(windows)]
use std::fs::File;
#[cfg(windows)]
use std::io::{BufRead, BufReader, BufWriter, Write};

/// IPC 客户端
pub struct IpcClient {
    _config: IpcConfig,
}

impl IpcClient {
    pub fn new(config: IpcConfig) -> Self {
        Self { _config: config }
    }

    /// 发送请求并接收响应
    #[cfg(windows)]
    fn send_request(&self, request: &ServiceRequest) -> Result<Vec<u8>> {
        // 检查管道是否存在
        if !Path::new(IPC_PATH).exists() {
            anyhow::bail!("服务未运行（IPC 管道不存在）");
        }

        // 打开命名管道（阻塞直到服务端准备好）
        let pipe = File::options()
            .read(true)
            .write(true)
            .open(IPC_PATH)
            .context("无法连接到服务（命名管道打开失败）")?;

        let mut writer = BufWriter::new(&pipe);
        let mut reader = BufReader::new(&pipe);

        // 序列化请求并发送
        let request_json = serde_json::to_string(request)
            .context("序列化请求失败")?;

        writeln!(writer, "{}", request_json)
            .context("发送请求失败")?;
        writer.flush()
            .context("刷新管道失败")?;

        // 读取响应（单行 JSON）
        let mut response_line = String::new();
        reader.read_line(&mut response_line)
            .context("读取响应失败")?;

        Ok(response_line.into_bytes())
    }

    #[cfg(not(windows))]
    fn send_request(&self, _request: &ServiceRequest) -> Result<Vec<u8>> {
        anyhow::bail!("IPC 仅支持 Windows 平台")
    }

    /// 连接检测（心跳）
    pub fn connect(&self) -> Result<()> {
        let request = ServiceRequest {
            command: "ping".to_string(),
            data: None,
        };

        let response_data = self.send_request(&request)?;
        let response: ServiceResponse<()> = serde_json::from_slice(&response_data)
            .context("解析响应失败")?;

        if response.code != 0 {
            anyhow::bail!("连接失败: {}", response.message);
        }

        Ok(())
    }

    /// 启动内核
    pub fn start_core(&self, config: &CoreConfig) -> Result<ServiceResponse<()>> {
        let config_json = serde_json::to_string(config)
            .context("序列化内核配置失败")?;

        let request = ServiceRequest {
            command: "start".to_string(),
            data: Some(config_json),
        };

        let response_data = self.send_request(&request)?;
        let response: ServiceResponse<()> = serde_json::from_slice(&response_data)
            .context("解析启动响应失败")?;

        Ok(response)
    }

    /// 停止内核
    pub fn stop_core(&self) -> Result<ServiceResponse<()>> {
        let request = ServiceRequest {
            command: "stop".to_string(),
            data: None,
        };

        let response_data = self.send_request(&request)?;
        let response: ServiceResponse<()> = serde_json::from_slice(&response_data)
            .context("解析停止响应失败")?;

        Ok(response)
    }

    /// 获取内核状态
    pub fn get_status(&self) -> Result<ServiceResponse<CoreStatus>> {
        let request = ServiceRequest {
            command: "status".to_string(),
            data: None,
        };

        let response_data = self.send_request(&request)?;
        let response: ServiceResponse<CoreStatus> = serde_json::from_slice(&response_data)
            .context("解析状态响应失败")?;

        Ok(response)
    }

    /// 获取内核日志
    pub fn get_logs(&self, lines: usize) -> Result<ServiceResponse<Vec<String>>> {
        let request = ServiceRequest {
            command: "logs".to_string(),
            data: Some(lines.to_string()),
        };

        let response_data = self.send_request(&request)?;
        let response: ServiceResponse<Vec<String>> = serde_json::from_slice(&response_data)
            .context("解析日志响应失败")?;

        Ok(response)
    }

    /// 获取服务版本
    pub fn get_version(&self) -> Result<ServiceResponse<ServiceVersion>> {
        let request = ServiceRequest {
            command: "version".to_string(),
            data: None,
        };

        let response_data = self.send_request(&request)?;
        let response: ServiceResponse<ServiceVersion> = serde_json::from_slice(&response_data)
            .context("解析版本响应失败")?;

        Ok(response)
    }
}

/// 全局客户端实例
static CLIENT: once_cell::sync::Lazy<IpcClient> = once_cell::sync::Lazy::new(|| {
    IpcClient::new(IpcConfig::default())
});

/// 检查 IPC 管道是否存在
#[cfg(windows)]
pub fn is_ipc_available() -> bool {
    Path::new(IPC_PATH).exists()
}

#[cfg(not(windows))]
pub fn is_ipc_available() -> bool {
    false
}

/// 连接检测
pub fn connect() -> Result<()> {
    CLIENT.connect()
}

/// 启动内核
pub fn start_core(config: &CoreConfig) -> Result<ServiceResponse<()>> {
    CLIENT.start_core(config)
}

/// 停止内核
pub fn stop_core() -> Result<ServiceResponse<()>> {
    CLIENT.stop_core()
}

/// 获取内核状态
pub fn get_status() -> Result<ServiceResponse<CoreStatus>> {
    CLIENT.get_status()
}

/// 获取内核日志
pub fn get_logs(lines: usize) -> Result<ServiceResponse<Vec<String>>> {
    CLIENT.get_logs(lines)
}

/// 获取服务版本
pub fn get_version() -> Result<ServiceResponse<ServiceVersion>> {
    CLIENT.get_version()
}

/// 检查是否需要重装服务（版本不匹配）
pub fn is_reinstall_needed() -> bool {
    match get_version() {
        Ok(response) if response.code == 0 => {
            if let Some(version_info) = response.data {
                // 比对版本号
                let current_version = env!("CARGO_PKG_VERSION");
                version_info.version != current_version
            } else {
                true
            }
        }
        _ => true,
    }
}
