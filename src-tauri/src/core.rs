//! mihomo 内核生命周期:sidecar 启动/停止/崩溃自动重启、状态查询。

use std::collections::VecDeque;
use std::io::Write;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::state::AppState;

/// 崩溃重启退避窗口与上限:30 秒窗口内最多 3 次。
const RESTART_WINDOW: Duration = Duration::from_secs(30);
const RESTART_MAX: usize = 3;

/// 内核句柄(挂在 `AppState.core` 的 Mutex 内, 只做短临界区读写)。
#[derive(Default)]
pub struct CoreHandle {
    child: Option<CommandChild>,
    started_at: Option<Instant>,
    restarts: VecDeque<Instant>,
    /// 手动停止标志:置位后事件循环不再自动重启。
    manual_stop: bool,
    /// GET /version 的缓存(运行中异步刷新)。
    version: Option<String>,
}

/// 契约 A 的 `CoreStatus` 镜像。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub running: bool,
    pub version: String,
    pub uptime_sec: u64,
    pub memory_bytes: u64,
}

/// 读取当前内核状态(短临界区, 不做网络 IO)。
pub fn status(app: &AppHandle) -> CoreStatus {
    let state = app.state::<AppState>();
    let guard = state.core.lock().expect("core 锁中毒");
    CoreStatus {
        running: guard.child.is_some(),
        version: guard.version.clone().unwrap_or_else(|| "—".into()),
        uptime_sec: guard
            .started_at
            .map(|t| t.elapsed().as_secs())
            .unwrap_or(0),
        // M1: 内存占用经 WS /memory 提供(M2 接入), 此处先返回 0
        memory_bytes: 0,
    }
}

/// 启动内核(已运行则幂等返回)。
pub fn start(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let guard = state.core.lock().expect("core 锁中毒");
        if guard.child.is_some() {
            return Ok(());
        }
    }
    // 无运行时配置时先用当前 profile 生成(无 profile 则写最小配置)
    if !state.dirs.runtime_config().exists() {
        crate::profiles::regenerate_runtime(app)?;
    }
    // 服务模式托管内核 → 不再拉起 sidecar, 仅经外部控制器对接
    if crate::service::is_running() {
        log::info!("内核由服务 {} 托管, 跳过 sidecar 启动", crate::service::SERVICE_NAME);
        refresh_version_async(app.clone());
        return Ok(());
    }
    spawn_core(app)?;
    {
        let mut guard = state.core.lock().expect("core 锁中毒");
        guard.manual_stop = false;
        guard.restarts.clear();
    }
    refresh_version_async(app.clone());
    Ok(())
}

/// 停止内核(置 manual_stop, 杀进程)。
pub fn stop(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut guard = state.core.lock().expect("core 锁中毒");
    guard.manual_stop = true;
    guard.started_at = None;
    if let Some(child) = guard.child.take() {
        child.kill().map_err(|e| format!("停止内核失败: {e}"))?;
    }
    Ok(())
}

/// 重启内核。
pub fn restart(app: &AppHandle) -> Result<(), String> {
    stop(app)?;
    start(app)
}

/// 实际拉起 sidecar 进程并挂事件循环。
fn spawn_core(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let config_dir = state.dirs.config.to_string_lossy().to_string();
    let (mut rx, child) = app
        .shell()
        .sidecar("mihomo")
        .map_err(|e| format!("定位 mihomo sidecar 失败: {e}"))?
        .args(["-d", &config_dir, "-f", "runtime.yaml"])
        .spawn()
        .map_err(|e| format!("启动 mihomo 失败: {e}"))?;

    {
        let mut guard = state.core.lock().expect("core 锁中毒");
        guard.child = Some(child);
        guard.started_at = Some(Instant::now());
    }
    log::info!("mihomo 已启动 (配置目录: {config_dir})");

    // 事件循环:stdout/stderr 落日志文件; Terminated 时按退避策略自动重启
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let log_path = app_handle
            .state::<AppState>()
            .dirs
            .core_log_file();
        let mut log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    if let Some(f) = log_file.as_mut() {
                        let _ = f.write_all(&line);
                        let _ = f.write_all(b"\n");
                    }
                }
                CommandEvent::Error(err) => log::error!("mihomo 进程错误: {err}"),
                CommandEvent::Terminated(payload) => {
                    on_terminated(&app_handle, payload.code);
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

/// 进程退出处理:非手动停止时在退避窗口内自动重启。
fn on_terminated(app: &AppHandle, code: Option<i32>) {
    let state = app.state::<AppState>();
    let should_restart = {
        let mut guard = state.core.lock().expect("core 锁中毒");
        guard.child = None;
        guard.started_at = None;
        if guard.manual_stop {
            false
        } else {
            let now = Instant::now();
            while let Some(front) = guard.restarts.front() {
                if now.duration_since(*front) > RESTART_WINDOW {
                    guard.restarts.pop_front();
                } else {
                    break;
                }
            }
            if guard.restarts.len() >= RESTART_MAX {
                log::error!("mihomo 在 30 秒内崩溃超过 {RESTART_MAX} 次, 停止自动重启");
                false
            } else {
                guard.restarts.push_back(now);
                true
            }
        }
    };
    if should_restart {
        log::warn!("mihomo 意外退出(code={code:?}), 自动重启…");
        if let Err(e) = spawn_core(app) {
            log::error!("自动重启失败: {e}");
        } else {
            refresh_version_async(app.clone());
        }
    } else {
        log::info!("mihomo 已退出(code={code:?})");
    }
}

#[derive(Deserialize)]
struct VersionPayload {
    version: String,
}

/// 异步刷新版本缓存(GET /version, 失败静默)。
fn refresh_version_async(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // 等内核就绪
        tokio::time::sleep(Duration::from_millis(800)).await;
        let (controller, secret) = {
            let state = app.state::<AppState>();
            let s = state.settings_snapshot();
            (s.external_controller, s.secret)
        };
        let url = format!("http://{controller}/version");
        let client = reqwest::Client::new();
        let resp = client
            .get(&url)
            .bearer_auth(&secret)
            .timeout(Duration::from_secs(3))
            .send()
            .await;
        if let Ok(resp) = resp {
            if let Ok(v) = resp.json::<VersionPayload>().await {
                let state = app.state::<AppState>();
                if let Ok(mut guard) = state.core.lock() {
                    guard.version = Some(v.version);
                };
            }
        }
    });
}

/// 通知 mihomo 热加载运行时配置(PUT /configs?force=true); 未运行时为 no-op。
pub async fn reload_runtime(app: &AppHandle) -> Result<(), String> {
    let (running, controller, secret, path) = {
        let state = app.state::<AppState>();
        let running = state
            .core
            .lock()
            .map(|g| g.child.is_some())
            .unwrap_or(false);
        let s = state.settings_snapshot();
        (
            running,
            s.external_controller,
            s.secret,
            state.dirs.runtime_config().to_string_lossy().to_string(),
        )
    };
    if !running {
        return Ok(());
    }
    let url = format!("http://{controller}/configs?force=true");
    let client = reqwest::Client::new();
    let resp = client
        .put(&url)
        .bearer_auth(&secret)
        .json(&serde_json::json!({ "path": path }))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| format!("热加载请求失败: {e}"))?;
    if !resp.status().is_success() {
        // 热加载失败 → 退回重启内核
        log::warn!("热加载返回 HTTP {}, 改为重启内核", resp.status());
        restart(app)?;
    }
    Ok(())
}
