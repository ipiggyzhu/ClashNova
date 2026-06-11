//! 系统代理设置与守卫:经 `sysproxy` crate 读写 Windows Internet 设置,
//! 守卫任务按世代号(guard_gen)自然换代退出。

use std::sync::atomic::Ordering;
use std::time::Duration;

use sysproxy::Sysproxy;
use tauri::{AppHandle, Manager};

use crate::state::{AppSettings, AppState};

fn expected(settings: &AppSettings) -> Sysproxy {
    Sysproxy {
        enable: settings.sys_proxy,
        host: "127.0.0.1".into(),
        port: settings.mixed_port,
        bypass: settings.bypass.clone(),
    }
}

/// 按设置应用(或清除)系统代理。
pub fn apply(settings: &AppSettings) -> Result<(), String> {
    expected(settings)
        .set_system_proxy()
        .map_err(|e| format!("设置系统代理失败: {e}"))
}

/// 退出前清理:关闭系统代理(仅当我们开启过)。
pub fn clear_on_exit(settings: &AppSettings) {
    if settings.sys_proxy {
        let off = Sysproxy {
            enable: false,
            host: "127.0.0.1".into(),
            port: settings.mixed_port,
            bypass: settings.bypass.clone(),
        };
        if let Err(e) = off.set_system_proxy() {
            log::warn!("退出时清除系统代理失败: {e}");
        }
    }
}

/// 重启守卫任务:递增世代号令旧循环退出;
/// 仅当 `guard && sys_proxy` 时拉起新循环。
pub fn restart_guard(app: &AppHandle) {
    let state = app.state::<AppState>();
    let generation = state.guard_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let settings = state.settings_snapshot();
    if !(settings.guard && settings.sys_proxy) {
        return;
    }
    let interval = Duration::from_secs(settings.guard_interval_sec.max(5));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        log::info!("系统代理守卫已启动(间隔 {}s)", interval.as_secs());
        loop {
            tokio::time::sleep(interval).await;
            let state = app.state::<AppState>();
            if state.guard_gen.load(Ordering::SeqCst) != generation {
                log::info!("系统代理守卫已换代退出");
                return;
            }
            let settings = state.settings_snapshot();
            if !(settings.guard && settings.sys_proxy) {
                return;
            }
            let want = expected(&settings);
            let actual = Sysproxy::get_system_proxy().ok();
            let drifted = actual
                .map(|a| a.enable != want.enable || a.host != want.host || a.port != want.port)
                .unwrap_or(true);
            if drifted {
                log::warn!("检测到系统代理被外部修改, 恢复中…");
                if let Err(e) = want.set_system_proxy() {
                    log::error!("守卫恢复系统代理失败: {e}");
                }
            }
        }
    });
}
