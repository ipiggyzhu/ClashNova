//! nova-core — ClashNova v2 纯逻辑层(Linux 可测)。
//!
//! 公共 API(锁定契约 D):
//! - [`parse_subscription`]:订阅内容 → Clash proxy mapping 列表
//! - [`deep_merge`]:YAML 对象递归合并(支持 `prepend-X` / `append-X` 数组插入)
//! - [`build_runtime_config`]:profile YAML + 运行时覆写 → 可下发 mihomo 的 YAML

pub mod config_gen;
pub mod merge;
pub mod subscription;

pub use config_gen::{build_runtime_config, RuntimeOverrides};
pub use merge::deep_merge;
pub use subscription::parse_subscription;

/// nova-core 统一错误类型。
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    /// YAML 解析/序列化失败。
    #[error("YAML 解析失败: {0}")]
    Yaml(#[from] serde_yaml::Error),
    /// Base64 解码失败。
    #[error("Base64 解码失败: {0}")]
    Base64(#[from] base64::DecodeError),
    /// 单条代理 URI 不合法(缺字段/端口非法等)。
    #[error("无效的代理 URI: {0}")]
    InvalidUri(String),
    /// 内容既不是 Clash YAML、也不是(base64 的)URI 列表。
    #[error("无法识别的订阅格式")]
    UnrecognizedFormat,
    /// 订阅内容为空或不含任何可用节点。
    #[error("订阅内容为空或不含可用节点")]
    Empty,
}
