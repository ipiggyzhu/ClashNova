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

pub(crate) fn is_sidecar_running(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    state
        .core
        .lock()
        .map(|g| g.child.is_some())
        .unwrap_or(false)
}

pub(crate) async fn is_running(app: &AppHandle) -> bool {
    if is_sidecar_running(app) {
        true
    } else {
        tauri::async_runtime::spawn_blocking(crate::service::is_running)
            .await
            .unwrap_or(false)
    }
}

/// 读取当前内核状态(锁内只读内存状态; 服务状态查询移到阻塞线程池)。
pub async fn status(app: &AppHandle) -> CoreStatus {
    let state = app.state::<AppState>();
    let (sidecar_running, version, uptime_sec) = {
        let guard = state.core.lock().expect("core 锁中毒");
        (
            guard.child.is_some(),
            guard.version.clone().unwrap_or_else(|| "—".into()),
            guard
                .started_at
                .map(|t| t.elapsed().as_secs())
                .unwrap_or(0),
        )
    };
    let service_running = !sidecar_running && is_running(app).await;
    CoreStatus {
        running: sidecar_running || service_running,
        version,
        uptime_sec,
        // M1: 内存占用经 WS /memory 提供(M2 接入), 此处先返回 0
        memory_bytes: 0,
    }
}

/// 启动内核(已运行则幂等返回)。
pub fn start(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    // 无运行时配置时先用当前 profile 生成(无 profile 则写最小配置)
    if !state.dirs.runtime_config().exists() {
        crate::profiles::regenerate_runtime(app)?;
    }
    let settings = state.settings_snapshot();
    let sidecar_running = {
        let guard = state.core.lock().expect("core 锁中毒");
        guard.child.is_some()
    };
    if sidecar_running {
        if settings.tun {
            log::info!("TUN 模式已启用, 停止普通 sidecar 并切换到服务托管");
            stop_sidecar(app)?;
        } else {
            return Ok(());
        }
    }
    if settings.tun {
        if crate::service::status() != "installed" {
            return Err("TUN 模式需要服务模式支持，请先在设置中安装服务".into());
        }
        if !crate::service::is_running() {
            stop_orphan_sidecars(app);
            crate::service::start_or_elevate()
                .map_err(|err| format!("TUN 模式需要服务运行，但服务启动失败: {err}"))?;
        }
        log::info!(
            "TUN 模式由服务 {} 托管, 跳过 sidecar 启动",
            crate::service::SERVICE_NAME
        );
        refresh_version_async(app.clone());
        return Ok(());
    }
    // 服务模式托管内核 → 不再拉起 sidecar, 仅经外部控制器对接
    if crate::service::is_running() {
        log::info!("内核由服务 {} 托管, 跳过 sidecar 启动", crate::service::SERVICE_NAME);
        refresh_version_async(app.clone());
        return Ok(());
    }
    if crate::service::status() == "installed" {
        match crate::service::start() {
            Ok(()) => {
                log::info!(
                    "内核由服务 {} 托管, 跳过 sidecar 启动",
                    crate::service::SERVICE_NAME
                );
                refresh_version_async(app.clone());
                return Ok(());
            }
            Err(err) => {
                log::warn!("服务模式启动失败, 回退普通 sidecar: {err}");
            }
        }
    }
    start_sidecar(app)?;
    Ok(())
}

pub(crate) fn start_sidecar(app: &AppHandle) -> Result<(), String> {
    spawn_core(app)?;
    {
        let state = app.state::<AppState>();
        let mut guard = state.core.lock().expect("core 锁中毒");
        guard.manual_stop = false;
        guard.restarts.clear();
    }
    refresh_version_async(app.clone());
    Ok(())
}

/// 停止 sidecar(置 manual_stop, 杀进程)。
pub(crate) fn stop_sidecar(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut guard = state.core.lock().expect("core 锁中毒");
    guard.manual_stop = true;
    guard.started_at = None;
    guard.version = None;
    if let Some(child) = guard.child.take() {
        child.kill().map_err(|e| format!("停止内核失败: {e}"))?;
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn stop_orphan_sidecars(app: &AppHandle) {
    let state = app.state::<AppState>();
    let config_dir = state
        .dirs
        .config
        .to_string_lossy()
        .replace('\'', "''");
    let runtime_config = state
        .dirs
        .runtime_config()
        .to_string_lossy()
        .replace('\'', "''");
    let script = format!(
        "$dir = '{config_dir}'; \
         $runtime = '{runtime_config}'; \
         Get-CimInstance Win32_Process -Filter \"Name = 'mihomo.exe'\" | \
         Where-Object {{ $cmd = $_.CommandLine; $cmd -and ($cmd.Contains($dir) -or $cmd.Contains($runtime)) }} | \
         ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Output $_.ProcessId }}"
    );
    match std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .output()
    {
        Ok(output) if output.status.success() => {
            let killed = String::from_utf8_lossy(&output.stdout);
            if !killed.trim().is_empty() {
                log::info!("已清理旧 mihomo sidecar 进程: {}", killed.trim());
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            log::warn!("清理旧 mihomo sidecar 进程失败: {}", stderr.trim());
        }
        Err(err) => log::warn!("清理旧 mihomo sidecar 进程失败: {err}"),
    }
}

#[cfg(not(windows))]
pub(crate) fn stop_orphan_sidecars(_app: &AppHandle) {}

/// 停止内核(同时处理 sidecar 与服务模式)。
pub fn stop(app: &AppHandle) -> Result<(), String> {
    stop_sidecar(app)?;
    if crate::service::is_running() {
        crate::service::stop()?;
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
    let runtime_config = state.dirs.runtime_config().to_string_lossy().to_string();
    let (mut rx, child) = app
        .shell()
        .sidecar("mihomo")
        .map_err(|e| format!("定位 mihomo sidecar 失败: {e}"))?
        // mihomo resolves a relative -f against the process cwd, not -d.
        // Installed builds therefore must pass the absolute runtime path.
        .args(["-d", &config_dir, "-f", &runtime_config])
        .spawn()
        .map_err(|e| format!("启动 mihomo 失败: {e}"))?;

    {
        let mut guard = state.core.lock().expect("core 锁中毒");
        guard.child = Some(child);
        guard.started_at = Some(Instant::now());
        guard.version = None;
    }
    log::info!("mihomo 已启动 (配置目录: {config_dir}, 配置文件: {runtime_config})");

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
        guard.version = None;
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

/// 异步刷新版本缓存(GET /version)。
/// 内核冷启动耗时不定(首启建缓存可达数秒), 持续重试直到拿到版本(~2 分钟上限)。
fn refresh_version_async(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        for attempt in 0u32..30 {
            let wait = if attempt == 0 { 800 } else { 4000 };
            tokio::time::sleep(Duration::from_millis(wait)).await;
            // 内核已被手动停止则不再轮询(sc.exe 查询是阻塞调用, 移到阻塞线程池)
            let mut running = {
                let state = app.state::<AppState>();
                state.core.lock().map(|g| g.child.is_some()).unwrap_or(false)
            };
            if !running {
                running = tauri::async_runtime::spawn_blocking(crate::service::is_running)
                    .await
                    .unwrap_or(false);
            }
            if !running {
                return;
            }
            let (controller, secret) = {
                let state = app.state::<AppState>();
                let s = state.settings_snapshot();
                (s.external_controller, s.secret)
            };
            let url = format!("http://{controller}/version");
            let resp = client
                .get(&url)
                .bearer_auth(&secret)
                .timeout(Duration::from_secs(3))
                .send()
                .await;
            let Ok(resp) = resp else { continue };
            let Ok(v) = resp.json::<VersionPayload>().await else { continue };
            let state = app.state::<AppState>();
            if let Ok(mut guard) = state.core.lock() {
                guard.version = Some(v.version);
            };
            return;
        }
    });
}

/// 通知 mihomo 热加载运行时配置(PUT /configs?force=true); 未运行时为 no-op。
pub async fn reload_runtime(app: &AppHandle) -> Result<(), String> {
    let (controller, secret) = {
        let state = app.state::<AppState>();
        let s = state.settings_snapshot();
        (s.external_controller, s.secret)
    };
    reload_runtime_with_auth(app, controller, secret).await
}

pub async fn reload_runtime_with_auth(
    app: &AppHandle,
    controller: String,
    secret: String,
) -> Result<(), String> {
    let (sidecar_running, controller, secret, path) = {
        let state = app.state::<AppState>();
        let sidecar_running = state
            .core
            .lock()
            .map(|g| g.child.is_some())
            .unwrap_or(false);
        (
            sidecar_running,
            controller,
            secret,
            state.dirs.runtime_config().to_string_lossy().to_string(),
        )
    };
    let running = sidecar_running
        || tauri::async_runtime::spawn_blocking(crate::service::is_running)
            .await
            .unwrap_or(false);
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
        .await;
    let resp = match resp {
        Ok(resp) => resp,
        Err(err) if sidecar_running => {
            log::warn!("热加载请求失败({err}), 改为重启内核");
            restart(app)?;
            return Ok(());
        }
        Err(err) => return Err(format!("热加载请求失败: {err}")),
    };
    if !resp.status().is_success() {
        if sidecar_running {
            // 热加载失败 → 退回重启内核
            log::warn!("热加载返回 HTTP {}, 改为重启内核", resp.status());
            restart(app)?;
        } else {
            return Err(format!("服务模式热加载失败: HTTP {}", resp.status()));
        }
    }
    Ok(())
}

pub async fn wait_runtime_tun(
    app: &AppHandle,
    expected: bool,
    timeout: Duration,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let started = Instant::now();
    let mut last = String::from("控制器未返回配置");

    loop {
        let (controller, secret) = {
            let state = app.state::<AppState>();
            let settings = state.settings_snapshot();
            (settings.external_controller, settings.secret)
        };
        let url = format!("http://{controller}/configs");
        match client
            .get(&url)
            .bearer_auth(&secret)
            .timeout(Duration::from_secs(2))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<serde_json::Value>().await {
                    Ok(json) => {
                        let actual = json
                            .get("tun")
                            .and_then(|tun| tun.get("enable"))
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false);
                        if actual == expected {
                            return Ok(());
                        }
                        last = format!(
                            "内核 TUN 实际状态为 {}",
                            if actual { "开启" } else { "关闭" }
                        );
                    }
                    Err(err) => {
                        last = format!("解析 /configs 响应失败: {err}");
                    }
                }
            }
            Ok(resp) => {
                last = format!("控制器返回 HTTP {}", resp.status());
            }
            Err(err) => {
                last = format!("控制器未就绪: {err}");
            }
        }

        if started.elapsed() >= timeout {
            return Err(format!(
                "等待内核应用 TUN={} 超时: {last}",
                if expected { "true" } else { "false" }
            ));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}
