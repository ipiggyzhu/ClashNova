use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// 健康检查器
pub struct HealthChecker {
    /// 奇数表示运行, 偶数表示停止; 换代避免旧线程在重启后再次进入循环。
    generation: Arc<AtomicU64>,
    /// 检查间隔（秒）
    interval: Duration,
}

impl HealthChecker {
    /// 创建健康检查器
    pub fn new(interval_secs: u64) -> Self {
        Self {
            generation: Arc::new(AtomicU64::new(0)),
            interval: Duration::from_secs(interval_secs),
        }
    }

    fn begin_generation(&self) -> Option<u64> {
        let mut generation = self.generation.load(Ordering::Acquire);
        while generation % 2 == 0 {
            let next = generation.wrapping_add(1);
            match self.generation.compare_exchange_weak(
                generation,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(next),
                Err(current) => generation = current,
            }
        }
        None
    }

    /// 启动健康检查
    pub fn start<F>(&self, on_unhealthy: F)
    where
        F: Fn() + Send + 'static,
    {
        let Some(expected_generation) = self.begin_generation() else {
            log::warn!("健康检查已在运行");
            return;
        };

        let generation = self.generation.clone();
        let interval = self.interval;

        std::thread::spawn(move || {
            log::info!("健康检查线程已启动，间隔: {:?}", interval);

            while generation.load(Ordering::Acquire) == expected_generation {
                std::thread::sleep(interval);
                if generation.load(Ordering::Acquire) != expected_generation {
                    break;
                }

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
                        if generation.load(Ordering::Acquire) == expected_generation {
                            on_unhealthy();
                        }
                    }
                }
            }

            log::info!("健康检查线程已停止");
        });
    }

    /// 停止健康检查
    pub fn stop(&self) {
        let mut generation = self.generation.load(Ordering::Acquire);
        while generation % 2 == 1 {
            match self.generation.compare_exchange_weak(
                generation,
                generation.wrapping_add(1),
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return,
                Err(current) => generation = current,
            }
        }
    }

    /// 检查是否正在运行
    pub fn is_running(&self) -> bool {
        self.generation.load(Ordering::Acquire) % 2 == 1
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restarting_health_checks_invalidates_the_old_thread_generation() {
        let checker = HealthChecker::new(30);
        let old = checker.begin_generation().unwrap();
        assert!(checker.is_running());
        assert!(checker.begin_generation().is_none());
        checker.stop();
        assert!(!checker.is_running());
        let new = checker.begin_generation().unwrap();
        assert_ne!(old, new);
        assert_eq!(checker.generation.load(Ordering::Acquire), new);
    }
}
