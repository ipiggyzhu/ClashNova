pub mod types;

#[cfg(feature = "client")]
pub mod client;

#[cfg(feature = "client")]
pub mod health;

#[cfg(feature = "server")]
pub mod server;

// 重新导出常用类型和函数
pub use types::*;

#[cfg(feature = "client")]
pub use client::{
    connect, get_logs, get_status, get_version, is_ipc_available, is_reinstall_needed,
    start_core, stop_core, IpcClient,
};

#[cfg(feature = "client")]
pub use health::{is_health_check_running, start_health_check, stop_health_check, HealthChecker};

#[cfg(feature = "server")]
pub use server::{start_server, IpcServer};
