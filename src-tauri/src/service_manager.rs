use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};

use crate::service;
use crate::state::AppState;

/// 服务状态
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceStatus {
    /// 服务就绪，可以使用
    Ready,
    /// 需要重装（版本不匹配）
    NeedsReinstall,
    /// 需要安装
    InstallRequired,
    /// 需要卸载
    UninstallRequired,
    /// 需要重装（用户请求）
    ReinstallRequired,
    /// 强制重装（修复）
    ForceReinstallRequired,
    /// 不可用（附带原因）
    Unavailable(String),
}

impl ServiceStatus {
    pub fn is_ready(&self) -> bool {
        matches!(self, ServiceStatus::Ready)
    }

    pub fn is_unavailable(&self) -> bool {
        matches!(self, ServiceStatus::Unavailable(_))
    }
}

/// 服务管理器
pub struct ServiceManager {
    /// 当前服务状态
    status: Arc<Mutex<ServiceStatus>>,
    /// 是否有操作正在进行
    operation_running: Arc<AtomicBool>,
    /// 操作完成通知
    operation_done: Arc<Notify>,
}

impl ServiceManager {
    /// 创建新的服务管理器
    pub fn new() -> Self {
        Self {
            status: Arc::new(Mutex::new(ServiceStatus::Unavailable("未初始化".into()))),
            operation_running: Arc::new(AtomicBool::new(false)),
            operation_done: Arc::new(Notify::new()),
        }
    }

    /// 获取当前状态
    pub async fn current_status(&self) -> ServiceStatus {
        loop {
            let notified = self.operation_done.notified();
            if !self.operation_running.load(Ordering::Acquire) {
                let status = self.status.lock().await.clone();
                // 双重检查，确保状态读取期间没有新操作开始
                if !self.operation_running.load(Ordering::Acquire) {
                    return status;
                }
            }
            // 等待操作完成
            notified.await;
        }
    }

    /// 设置状态（内部使用）
    async fn set_status(&self, status: ServiceStatus) {
        let mut s = self.status.lock().await;
        log::info!("服务状态变更: {:?} -> {:?}", *s, status);
        *s = status;
    }

    /// 检查 IPC 是否可用
    async fn is_ipc_available(&self) -> bool {
        nova_service_ipc::is_ipc_available()
    }

    /// 等待 IPC 就绪（带重试）
    async fn wait_for_ipc(&self, max_retries: usize, retry_delay: std::time::Duration) -> Result<(), String> {
        for i in 0..max_retries {
            if self.is_ipc_available().await {
                match nova_service_ipc::connect() {
                    Ok(_) => {
                        log::info!("IPC 连接成功");
                        return Ok(());
                    }
                    Err(e) => {
                        log::warn!("IPC 连接失败 ({}/{}): {}", i + 1, max_retries, e);
                    }
                }
            } else {
                log::warn!("IPC 管道不存在 ({}/{})", i + 1, max_retries);
            }

            if i < max_retries - 1 {
                tokio::time::sleep(retry_delay).await;
            }
        }

        Err(format!("等待 IPC 就绪超时（{}次重试）", max_retries))
    }

    /// 初始化服务管理器
    pub async fn init(&self) -> Result<(), String> {
        log::info!("初始化服务管理器");

        // 检查服务是否已安装
        let service_status = crate::service::status();
        log::info!("服务状态: {}", service_status);

        if service_status != "installed" {
            self.set_status(ServiceStatus::InstallRequired).await;
            return Err("服务未安装".into());
        }

        // 检查服务是否正在运行
        if !crate::service::is_running() {
            log::warn!("服务已安装但未运行");
            self.set_status(ServiceStatus::Unavailable("服务未运行".into())).await;
            return Err("服务未运行".into());
        }

        // 检查 IPC 连接
        if let Err(e) = nova_service_ipc::connect() {
            log::warn!("IPC 连接失败: {}", e);
            self.set_status(ServiceStatus::Unavailable(format!("IPC 连接失败: {}", e))).await;
            return Err(format!("IPC 连接失败: {}", e));
        }

        // 检查版本
        if nova_service_ipc::is_reinstall_needed() {
            log::warn!("服务版本不匹配，需要重装");
            self.set_status(ServiceStatus::NeedsReinstall).await;
            return Ok(());
        }

        // 一切正常
        self.set_status(ServiceStatus::Ready).await;
        log::info!("服务管理器初始化成功");
        Ok(())
    }

    /// 刷新服务状态
    pub async fn refresh(&self) -> Result<(), String> {
        let self_ref = self;
        self.run_operation(async move {
            log::info!("刷新服务状态");

            // 检查服务是否已安装
            let service_status = crate::service::status();
            if service_status != "installed" {
                self_ref.set_status(ServiceStatus::InstallRequired).await;
                return Err("服务未安装".into());
            }

            // 检查服务是否正在运行
            if !crate::service::is_running() {
                self_ref.set_status(ServiceStatus::Unavailable("服务未运行".into())).await;
                return Err("服务未运行".into());
            }

            // 检查 IPC 连接
            if let Err(e) = nova_service_ipc::connect() {
                self_ref.set_status(ServiceStatus::Unavailable(format!("IPC 连接失败: {}", e))).await;
                return Err(format!("IPC 连接失败: {}", e));
            }

            // 检查版本
            if nova_service_ipc::is_reinstall_needed() {
                self_ref.set_status(ServiceStatus::NeedsReinstall).await;
            } else {
                self_ref.set_status(ServiceStatus::Ready).await;
            }

            Ok(())
        })
        .await
    }

    /// 处理服务状态转换
    pub async fn handle_service_status(&self, status: ServiceStatus) -> Result<(), String> {
        let self_ref = self;
        self.run_operation(async move {
            self_ref.apply_service_status(status).await
        })
        .await
    }

    /// 应用服务状态（状态机核心逻辑）
    async fn apply_service_status(&self, status: ServiceStatus) -> Result<(), String> {
        self.set_status(status.clone()).await;

        match status {
            ServiceStatus::Ready => {
                log::info!("服务就绪，无需操作");
                Ok(())
            }

            ServiceStatus::InstallRequired => {
                log::info!("开始安装服务");

                // 安装服务
                tokio::task::spawn_blocking(|| {
                    let config_dir = crate::state::AppState::init()
                        .map_err(|e| format!("获取配置目录失败: {}", e))?
                        .dirs
                        .app_home;
                    crate::service::install(&config_dir)
                })
                .await
                .map_err(|e| format!("安装服务任务失败: {}", e))??;

                log::info!("服务安装成功，等待 IPC 就绪");

                // 等待 IPC 就绪
                self.wait_for_ipc(20, std::time::Duration::from_millis(250)).await?;

                // 检查版本
                if nova_service_ipc::is_reinstall_needed() {
                    log::warn!("服务版本不匹配，需要重装");
                    self.set_status(ServiceStatus::NeedsReinstall).await;
                    return self.apply_service_status(ServiceStatus::ReinstallRequired).await;
                }

                self.set_status(ServiceStatus::Ready).await;
                Ok(())
            }

            ServiceStatus::NeedsReinstall | ServiceStatus::ReinstallRequired => {
                log::info!("开始重装服务");

                // 先卸载
                log::info!("卸载旧服务");
                if let Err(e) = tokio::task::spawn_blocking(crate::service::uninstall)
                    .await
                    .map_err(|e| format!("卸载任务失败: {}", e))?
                {
                    log::warn!("卸载服务失败（可能不存在）: {}", e);
                }

                // 等待一下，确保服务完全停止
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                // 再安装
                log::info!("安装新服务");
                tokio::task::spawn_blocking(|| {
                    let config_dir = crate::state::AppState::init()
                        .map_err(|e| format!("获取配置目录失败: {}", e))?
                        .dirs
                        .app_home;
                    crate::service::install(&config_dir)
                })
                .await
                .map_err(|e| format!("安装服务任务失败: {}", e))??;

                log::info!("服务重装成功，等待 IPC 就绪");

                // 等待 IPC 就绪
                self.wait_for_ipc(20, std::time::Duration::from_millis(250)).await?;

                self.set_status(ServiceStatus::Ready).await;
                Ok(())
            }

            ServiceStatus::ForceReinstallRequired => {
                log::info!("用户请求强制重装服务");
                self.apply_service_status(ServiceStatus::ReinstallRequired).await
            }

            ServiceStatus::UninstallRequired => {
                log::info!("开始卸载服务");

                tokio::task::spawn_blocking(crate::service::uninstall)
                    .await
                    .map_err(|e| format!("卸载任务失败: {}", e))??;

                self.set_status(ServiceStatus::Unavailable("服务已卸载".into())).await;
                log::info!("服务卸载成功");
                Ok(())
            }

            ServiceStatus::Unavailable(reason) => {
                log::info!("服务不可用: {}", reason);
                Err(format!("服务不可用: {}", reason))
            }
        }
    }

    /// 执行操作（防止并发）
    async fn run_operation<Fut>(&self, operation: Fut) -> Result<(), String>
    where
        Fut: std::future::Future<Output = Result<(), String>>,
    {
        // 尝试获取操作锁
        if self.operation_running.swap(true, Ordering::AcqRel) {
            return Err("已有操作正在进行".into());
        }

        // 确保操作完成后释放锁
        let operation_running = self.operation_running.clone();
        let operation_done = self.operation_done.clone();

        let result = operation.await;

        operation_running.store(false, Ordering::Release);
        operation_done.notify_waiters();

        result
    }
}

impl Default for ServiceManager {
    fn default() -> Self {
        Self::new()
    }
}

/// 全局服务管理器实例
static SERVICE_MANAGER: once_cell::sync::Lazy<ServiceManager> =
    once_cell::sync::Lazy::new(ServiceManager::new);

/// 获取全局服务管理器
pub fn get_service_manager() -> &'static ServiceManager {
    &SERVICE_MANAGER
}
