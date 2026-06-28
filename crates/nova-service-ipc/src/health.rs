use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// 健康检查器
pub struct HealthChecker {
    /// 是否正在运行
    running: Arc<AtomicBool>,
    /// 检查间隔（秒）
    interval: Duration,
}

impl HealthChecker {
    /// 创建健康检查器
    pub fn new(interval_secs: u64) -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            interval: Duration::from_secs(interval_secs),
        }
    }

    /// 启动健康检查
    pub fn start<F>(&self, on_unhealthy: F)
    where
        F: Fn() + Send + 'static,
    {
        if self.running.swap(true, Ordering::AcqRel) {
            log::warn!("健康检查已在运行");
            return;
        }

        let running = self.running.clone();
        let interval = self.interval;

        std::thread::spawn(move || {
            log::info!("健康检查线程已启动，间隔: {:?}", interval);

            while running.load(Ordering::Acquire) {
                std::thread::sleep(interval);

                // 执行健康检查
                match crate::client::connect() {
                    Ok(_) => {
                        // IPC 连接正常
                        log::debug!("健康检查通过");
                    }
                    Err(e) => {
                        // IPC 连接失败
                        log::error!("健康检查失败: {}", e);

                        // 调用回调
                        on_unhealthy();
                    }
                }
            }

            log::info!("健康检查线程已停止");
        });
    }

    /// 停止健康检查
    pub fn stop(&self) {
        self.running.store(false, Ordering::Release);
    }

    /// 检查是否正在运行
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }
}

impl Drop for HealthChecker {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 全局健康检查器实例
static HEALTH_CHECKER: once_cell::sync::Lazy<HealthChecker> =
    once_cell::sync::Lazy::new(|| HealthChecker::new(30)); // 默认 30 秒

/// 启动全局健康检查
pub fn start_health_check<F>(on_unhealthy: F)
where
    F: Fn() + Send + 'static,
{
    HEALTH_CHECKER.start(on_unhealthy);
}

/// 停止全局健康检查
pub fn stop_health_check() {
    HEALTH_CHECKER.stop();
}

/// 检查健康检查是否正在运行
pub fn is_health_check_running() -> bool {
    HEALTH_CHECKER.is_running()
}
