use crate::types::*;
use anyhow::{Context, Result};
use serde::de::DeserializeOwned;

#[cfg(windows)]
use std::fs::File;
#[cfg(windows)]
use std::io::{BufRead, BufReader, BufWriter, Write};
#[cfg(windows)]
use std::path::Path;

/// IPC 客户端
pub struct IpcClient {
    _config: IpcConfig,
}

impl IpcClient {
    fn current_build_id() -> &'static str {
        option_env!("CLASHNOVA_BUILD_ID").unwrap_or(env!("CARGO_PKG_VERSION"))
    }

    fn parse_response<T: DeserializeOwned>(&self, response_data: &[u8], action: &str) -> Result<ServiceResponse<T>> {
        let raw = String::from_utf8_lossy(response_data);
        if raw.trim().is_empty() {
            anyhow::bail!("{action}响应为空");
        }

        if let Ok(response) = serde_json::from_slice::<ServiceResponse<T>>(response_data) {
            return Ok(response);
        }

        let fallback: ServiceResponse<serde_json::Value> = serde_json::from_slice(response_data)
            .with_context(|| format!("解析{action}响应失败: {raw}"))?;

        if fallback.code != 0 {
            anyhow::bail!("{}", fallback.message);
        }

        let data = match fallback.data {
            Some(value) if value.is_null() || value == serde_json::json!({}) => None,
            Some(value) => Some(
                serde_json::from_value(value)
                    .with_context(|| format!("解析{action}响应数据失败"))?,
            ),
            None => None,
        };

        Ok(ServiceResponse {
            code: fallback.code,
            message: fallback.message,
            data,
        })
    }

    pub fn new(config: IpcConfig) -> Self {
        Self { _config: config }
    }

    /// 发送请求并接收响应
    #[cfg(windows)]
    fn send_request(&self, request: &ServiceRequest) -> Result<Vec<u8>> {
        // 尝试多次连接（最多重试 3 次）
        let mut last_error = None;
        for attempt in 1..=3 {
            match self.try_send_request(request) {
                Ok(response) => return Ok(response),
                Err(e) => {
                    last_error = Some(e);
                    if attempt < 3 {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                }
            }
        }

        Err(last_error.unwrap())
    }

    /// 尝试发送单次请求
    #[cfg(windows)]
    fn try_send_request(&self, request: &ServiceRequest) -> Result<Vec<u8>> {
        use std::io::ErrorKind;

        // 打开命名管道
        let pipe = match File::options()
            .read(true)
            .write(true)
            .open(IPC_PATH) {
            Ok(p) => p,
            Err(e) => {
                return match e.kind() {
                    ErrorKind::NotFound => {
                        Err(anyhow::anyhow!("服务未运行（命名管道不存在）"))
                    }
                    ErrorKind::PermissionDenied => {
                        Err(anyhow::anyhow!("权限不足，无法访问服务"))
                    }
                    _ => {
                        Err(anyhow::anyhow!("无法连接到服务（命名管道打开失败）: {}", e))
                    }
                };
            }
        };

        // 注意：Windows 命名管道不支持 set_read_timeout/set_write_timeout
        // 超时由服务端的管道创建参数控制

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

        if response_line.is_empty() {
            anyhow::bail!("服务返回空响应");
        }

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
        let response: ServiceResponse<serde_json::Value> = self.parse_response(&response_data, "连接")?;

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
        let response: ServiceResponse<()> = self.parse_response(&response_data, "启动")?;

        Ok(response)
    }

    /// 停止内核
    pub fn stop_core(&self) -> Result<ServiceResponse<()>> {
        let request = ServiceRequest {
            command: "stop".to_string(),
            data: None,
        };

        let response_data = self.send_request(&request)?;
        let response: ServiceResponse<()> = self.parse_response(&response_data, "停止")?;

        Ok(response)
    }

    /// 获取内核状态
    pub fn get_status(&self) -> Result<ServiceResponse<CoreStatus>> {
        let request = ServiceRequest {
            command: "status".to_string(),
            data: None,
        };

        let response_data = self.send_request(&request)?;
        let response: ServiceResponse<CoreStatus> = self.parse_response(&response_data, "状态")?;

        Ok(response)
    }

    /// 获取内核日志
    pub fn get_logs(&self, lines: usize) -> Result<ServiceResponse<Vec<String>>> {
        let request = ServiceRequest {
            command: "logs".to_string(),
            data: Some(lines.to_string()),
        };

        let response_data = self.send_request(&request)?;
        let response: ServiceResponse<Vec<String>> = self.parse_response(&response_data, "日志")?;

        Ok(response)
    }

    /// 获取服务版本
    pub fn get_version(&self) -> Result<ServiceResponse<ServiceVersion>> {
        let request = ServiceRequest {
            command: "version".to_string(),
            data: None,
        };

        let response_data = self.send_request(&request)?;
        let response: ServiceResponse<ServiceVersion> = self.parse_response(&response_data, "版本")?;

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
                let current_version = env!("CARGO_PKG_VERSION");
                let current_build_id = IpcClient::current_build_id();
                version_info.version != current_version
                    || version_info.build_id.is_empty()
                    || version_info.build_id != current_build_id
            } else {
                true
            }
        }
        _ => true,
    }
}
