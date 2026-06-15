use serde::{Deserialize, Serialize};
use std::time::Duration;

/// IPC 命名管道路径
#[cfg(windows)]
pub const IPC_PATH: &str = r"\\.\pipe\clashnova-service";

#[cfg(not(windows))]
pub const IPC_PATH: &str = "/tmp/clashnova-service.sock";

/// IPC 配置
#[derive(Debug, Clone)]
pub struct IpcConfig {
    /// 默认超时时间
    pub default_timeout: Duration,
    /// 重试延迟
    pub retry_delay: Duration,
    /// 最大重试次数
    pub max_retries: usize,
}

impl Default for IpcConfig {
    fn default() -> Self {
        Self {
            default_timeout: Duration::from_millis(150),
            retry_delay: Duration::from_millis(250),
            max_retries: 20,
        }
    }
}

/// 内核配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreConfig {
    /// mihomo 配置文件路径
    pub config_path: String,
    /// mihomo 可执行文件路径
    pub core_path: String,
    /// 外部控制器地址
    pub external_controller: String,
    /// 配置目录
    pub config_dir: String,
}

/// 服务请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceRequest {
    /// 命令类型: start, stop, status, logs, version
    pub command: String,
    /// 请求数据 (JSON)
    pub data: Option<String>,
}

/// 服务响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceResponse<T> {
    /// 响应码: 0 = 成功, >0 = 错误
    pub code: i32,
    /// 响应消息
    pub message: String,
    /// 响应数据
    pub data: Option<T>,
}

impl<T> ServiceResponse<T> {
    pub fn success(data: T) -> Self {
        Self {
            code: 0,
            message: String::new(),
            data: Some(data),
        }
    }

    pub fn error(code: i32, message: String) -> Self {
        Self {
            code,
            message,
            data: None,
        }
    }
}

/// 内核状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreStatus {
    /// 是否正在运行
    pub running: bool,
    /// 进程 ID
    pub pid: Option<u32>,
    /// 启动时间 (Unix 时间戳)
    pub start_time: Option<i64>,
}

/// 服务版本信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceVersion {
    /// 服务版本
    pub version: String,
}
