pub mod types;

#[cfg(feature = "client")]
pub mod client;

#[cfg(feature = "server")]
pub mod server;

// 重新导出常用类型和函数
pub use types::*;

#[cfg(feature = "client")]
pub use client::{
    connect, get_logs, get_status, get_version, is_reinstall_needed, start_core, stop_core,
    IpcClient,
};

#[cfg(feature = "server")]
pub use server::{start_server, IpcServer};
