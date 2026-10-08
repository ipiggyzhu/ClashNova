//! 契约 B 的 15 个 Tauri 命令 + 托盘共用的内部应用函数。

use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::core::{self, CoreStatus};
use crate::profiles::{self, EnhancerMeta, ProfileMeta};
use crate::state::{AppSettings, AppState, FileTransaction};
use crate::{autostart, hotkeys, service, sysproxy_win, tray};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunAdapterStatus {
    pub enabled: bool,
    pub adapter_present: bool,
    pub adapter_name: Option<String>,
    pub status: Option<String>,
    pub detail: Option<String>,
}

/* ---------------- 内部应用函数(命令与托盘共用) ---------------- */

/// 切换系统代理:更新设置 → 应用注册表 → 重启守卫 → 持久化。
pub async fn apply_sys_proxy(app: &AppHandle, enable: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _configuration = state.config_lock.lock().await;
    let mut settings = state.settings_snapshot();
    settings.sys_proxy = enable;
    save_settings_inner(app.clone(), settings).await
}

async fn rollback_tun_change(
    app: &AppHandle,
    prev_settings: &AppSettings,
    transaction: &mut FileTransaction,
    sidecar_was_running: bool,
    service_was_running: bool,
    core_was_running: bool,
    core_touched: bool,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut guard = state.settings.write().map_err(|_| "settings 锁中毒")?;
        *guard = prev_settings.clone();
    }
    transaction.rollback()?;
    if !core_touched {
        return Ok(());
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 停掉本次切换的实例, 再按原来的运行方式恢复; SCM 运行不等于内核原先运行。
        core::stop(&app)?;
        if !service_was_running && service::is_running() {
            service::stop()?;
        }
        if sidecar_was_running {
            core::start_sidecar(&app)?;
        } else if core_was_running {
            core::start_with_service(&app)?;
        }
        Ok(())
    })
    .await
    .map_err(|err| format!("恢复内核任务失败: {err}"))?
}

pub(crate) fn is_service_ipc_failure(err: &str) -> bool {
    err.contains("IPC 调用失败")
        || err.contains("等待服务 IPC 就绪超时")
        || err.contains("解析响应失败")
        || err.contains("服务返回空响应")
        || err.contains("响应为空")
        || err.contains("服务版本不匹配，需要重装")
}

fn service_ipc_starting_message(err: impl std::fmt::Display) -> String {
    format!("unavailable:服务 IPC 初始化中: {err}")
}

#[cfg(windows)]
fn query_tun_adapter(enabled: bool) -> TunAdapterStatus {
    use std::os::windows::process::CommandExt;

    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$specific = '(?i)(Mihomo|ClashNova|Clash[ -]?(Meta|Verge)|Clash|SakuraiTunnel|Meta Tunnel)'
$wintun = '(?i)(Wintun Userspace Tunnel|Meta Tunnel)'
$adapters = @(Get-NetAdapter -IncludeHidden | Where-Object {
  $name = [string]$_.Name
  $desc = [string]$_.InterfaceDescription
  $matchesSpecific = ($name -match $specific) -or ($desc -match $specific)
  $matchesWintun = ($desc -match $wintun) -and ($name -match '(?i)(Mihomo|Clash|Meta|ClashNova|SakuraiTunnel)')
  $matchesSpecific -or $matchesWintun
} | Sort-Object @{Expression = { if ($_.Status -eq 'Up') { 0 } else { 1 } }}, Name)
if ($adapters.Count -eq 0) {
  [pscustomobject]@{ present = $false; name = $null; status = $null; detail = '未找到 Mihomo/Clash/Wintun 虚拟网卡' } | ConvertTo-Json -Compress
} else {
  $a = $adapters[0]
  [pscustomobject]@{ present = ($a.Status -eq 'Up'); name = $a.Name; status = $a.Status; detail = $a.InterfaceDescription } | ConvertTo-Json -Compress
}
"#;

    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);
    cmd.creation_flags(0x0800_0000);

    let output = match cmd.output() {
        Ok(output) => output,
        Err(err) => {
            return TunAdapterStatus {
                enabled,
                adapter_present: false,
                adapter_name: None,
                status: None,
                detail: Some(format!("执行 Get-NetAdapter 失败: {err}")),
            };
        }
    };

    if !output.status.success() {
        return TunAdapterStatus {
            enabled,
            adapter_present: false,
            adapter_name: None,
            status: None,
            detail: Some(format!(
                "Get-NetAdapter 返回失败: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )),
        };
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json = stdout.trim();
    let parsed = serde_json::from_str::<serde_json::Value>(json);
    let Ok(value) = parsed else {
        return TunAdapterStatus {
            enabled,
            adapter_present: false,
            adapter_name: None,
            status: None,
            detail: Some(format!("解析网卡检测结果失败: {json}")),
        };
    };

    TunAdapterStatus {
        enabled,
        adapter_present: value
            .get("present")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        adapter_name: value
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned),
        status: value
            .get("status")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned),
        detail: value
            .get("detail")
            .and_then(serde_json::Value::as_str)
            .filter(|detail| !detail.trim().is_empty())
            .map(ToOwned::to_owned),
    }
}

#[cfg(not(windows))]
fn query_tun_adapter(enabled: bool) -> TunAdapterStatus {
    TunAdapterStatus {
        enabled,
        adapter_present: false,
        adapter_name: None,
        status: Some("unsupported".into()),
        detail: Some("虚拟网卡检测仅支持 Windows".into()),
    }
}

async fn query_tun_adapter_async(enabled: bool) -> TunAdapterStatus {
    tauri::async_runtime::spawn_blocking(move || query_tun_adapter(enabled))
        .await
        .unwrap_or_else(|err| TunAdapterStatus {
            enabled,
            adapter_present: false,
            adapter_name: None,
            status: None,
            detail: Some(format!("网卡检测任务失败: {err}")),
        })
}

async fn wait_tun_adapter(
    app: &AppHandle,
    expected: bool,
    timeout: Duration,
) -> Result<TunAdapterStatus, String> {
    let started = Instant::now();
    let mut last = query_tun_adapter_async(app.state::<AppState>().settings_snapshot().tun).await;

    loop {
        if last.status.as_deref() == Some("unsupported") {
            return Ok(last);
        }
        if !expected || last.adapter_present {
            return Ok(last);
        }

        if expected && matches!(core::runtime_tun_enabled(app).await, Ok(true)) {
            last.status = Some("runtime-enabled".into());
            last.detail = Some(match last.detail {
                Some(detail) => format!("{detail}; mihomo 已确认 tun.enable=true"),
                None => "mihomo 已确认 tun.enable=true".into(),
            });
            return Ok(last);
        }

        if started.elapsed() >= timeout {
            let service_status = service_status().await;
            return Err(format!(
                "等待 TUN 虚拟网卡出现超时: 服务状态={service_status}, 网卡状态={}, 详情={}",
                last.status.as_deref().unwrap_or("unknown"),
                last.detail.as_deref().unwrap_or("无")
            ));
        }

        tokio::time::sleep(Duration::from_millis(500)).await;
        last = query_tun_adapter_async(app.state::<AppState>().settings_snapshot().tun).await;
    }
}

/// 切换 TUN:更新设置 → 检查服务 → 重生成配置 → 重启内核。
pub async fn apply_tun(app: &AppHandle, enable: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _configuration = state.config_lock.lock().await;
    apply_tun_inner(app, enable).await
}

async fn apply_tun_inner(app: &AppHandle, enable: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    if enable && service::status() == "not-installed" {
        return Err("TUN 模式需要服务模式支持，请先在设置中安装服务".into());
    }
    if enable {
        if let Err(err) = service::diagnose_installation() {
            if service::is_repairable_installation_error(&err) {
                log::warn!("检测到服务安装信息可自动修复，开始重装服务: {err}");
                repair_service_inner(app.clone()).await?;
            } else {
                return Err(err);
            }
        }
    }

    let service_was_running = service::is_running();
    let sidecar_was_running = core::is_sidecar_running(app);
    let core_was_running = core::is_running(app).await;
    let prev_settings = state.settings_snapshot();
    let mut settings = prev_settings.clone();
    settings.tun = enable;
    let mut transaction =
        FileTransaction::capture(&[state.dirs.settings_file(), state.dirs.runtime_config()])?;
    let mut core_touched = false;
    let result = async {
        {
            let mut guard = state.settings.write().map_err(|_| "settings 锁中毒")?;
            *guard = settings.clone();
        }
        profiles::regenerate_runtime_async(app).await?;
        if enable {
            core_touched = true;
            if sidecar_was_running {
                core::stop_sidecar(app)?;
            }
            if !service_was_running {
                core::stop_orphan_sidecars(app);
                service::start_or_elevate()?;
            }
            if !service::is_running() {
                return Err("TUN 模式需要服务正在运行，但服务启动后未处于运行状态".into());
            }
        }
        state.persist_settings(&settings)?;
        core_touched = true;
        let core_result = if enable && service::is_running() {
            let reload_result = if service_was_running {
                core::reload_runtime(app).await
            } else {
                Ok(())
            };
            reload_result.and_then(|_| core::start(app))
        } else {
            core::restart(app)
        };
        if let Err(err) = core_result {
            if enable && service::is_running() && is_service_ipc_failure(&err) {
                log::warn!("检测到服务 IPC 故障，尝试自动重装服务: {err}");
                repair_service_inner(app.clone())
                    .await
                    .map_err(|repair| format!("{err}; 自动重装服务失败: {repair}"))?;
            } else {
                return Err(err);
            }
        }
        core::wait_runtime_tun(app, enable, Duration::from_secs(8)).await?;
        if enable {
            wait_tun_adapter(app, true, Duration::from_secs(10)).await?;
        }
        if service::is_running() {
            if let Err(err) = crate::service_manager::get_service_manager()
                .refresh()
                .await
            {
                log::warn!("TUN 已应用，但刷新服务状态失败: {err}");
            }
        }
        Ok::<(), String>(())
    }
    .await;

    if let Err(err) = result {
        let rollback = rollback_tun_change(
            app,
            &prev_settings,
            &mut transaction,
            sidecar_was_running,
            service_was_running,
            core_was_running,
            core_touched,
        )
        .await;
        tray::sync_tray(app);
        return Err(match rollback {
            Ok(()) => err,
            Err(rollback) => format!("{err}; TUN 回滚失败: {rollback}"),
        });
    }
    transaction.commit();
    Ok(())
}

/// 切换出站模式(direct/rule/global):持久化 + 运行时同步。
pub async fn apply_mode(app: &AppHandle, mode: String) -> Result<(), String> {
    if !matches!(mode.as_str(), "direct" | "rule" | "global") {
        return Err(format!("非法模式: {mode}"));
    }
    let state = app.state::<AppState>();
    let _configuration = state.config_lock.lock().await;
    let mut settings = state.settings_snapshot();
    settings.mode = mode;
    save_settings_inner(app.clone(), settings).await?;
    Ok(())
}

/* ---------------- 契约 B 命令 ---------------- */

#[tauri::command]
pub fn get_settings(app: AppHandle) -> AppSettings {
    app.state::<AppState>().settings_snapshot()
}

/// 保存设置并按差异应用副作用(系统代理/守卫/自启/内核配置)。
#[tauri::command]
pub async fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _configuration = state.config_lock.lock().await;
    save_settings_inner(app.clone(), settings).await
}

fn merge_settings_patch(
    current: &AppSettings,
    patch: serde_json::Value,
) -> Result<AppSettings, String> {
    let patch = patch.as_object().ok_or("设置补丁必须为对象")?;
    let mut value = serde_json::to_value(current).map_err(|_| "读取设置结构失败")?;
    let object = value.as_object_mut().ok_or("设置结构无效")?;
    for (key, value) in patch {
        if !object.contains_key(key) {
            return Err("设置补丁包含未知字段".into());
        }
        object.insert(key.clone(), value.clone());
    }
    // serde 的类型错误可能含原始值; 对外只返回字段类型错误, 不回显密钥等输入。
    serde_json::from_value(value).map_err(|_| "设置补丁字段类型或取值无效".into())
}

#[tauri::command]
pub async fn patch_settings(
    app: AppHandle,
    patch: serde_json::Value,
) -> Result<AppSettings, String> {
    let state = app.state::<AppState>();
    let _configuration = state.config_lock.lock().await;
    let settings = merge_settings_patch(&state.settings_snapshot(), patch)?;
    save_settings_inner(app.clone(), settings).await?;
    Ok(state.settings_snapshot())
}

async fn save_settings_inner(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let state = app.state::<AppState>();
    let prev = state.settings_snapshot();
    if settings.tun && settings.tun != prev.tun {
        return Err("开启 TUN 请使用 set_tun 命令，以确保服务模式接管内核".into());
    }
    let sys_proxy_changed = settings.sys_proxy != prev.sys_proxy
        || settings.bypass != prev.bypass
        || settings.mixed_port != prev.mixed_port
        || settings.guard != prev.guard
        || settings.guard_interval_sec != prev.guard_interval_sec;
    let runtime_changed = settings.mixed_port != prev.mixed_port
        || settings.external_controller != prev.external_controller
        || settings.secret != prev.secret
        || settings.allow_lan != prev.allow_lan
        || settings.ipv6 != prev.ipv6
        || settings.log_level != prev.log_level
        || settings.tun != prev.tun
        || settings.mode != prev.mode
        || settings.dns_override != prev.dns_override
        || settings.hosts != prev.hosts
        || settings.enable_dns != prev.enable_dns
        || settings.dns_listen != prev.dns_listen
        || settings.dns_enhanced_mode != prev.dns_enhanced_mode
        || settings.fake_ip_range != prev.fake_ip_range
        || settings.fake_ip_filter_mode != prev.fake_ip_filter_mode
        || settings.ipv6_dns != prev.ipv6_dns
        || settings.prefer_h3 != prev.prefer_h3
        || settings.respect_rules != prev.respect_rules
        || settings.use_hosts != prev.use_hosts
        || settings.use_system_hosts != prev.use_system_hosts;
    let autostart_changed = settings.autostart != prev.autostart
        || (settings.autostart && settings.silent_start != prev.silent_start);
    let mut transaction =
        FileTransaction::capture(&[state.dirs.settings_file(), state.dirs.runtime_config()])?;
    let mut proxy_attempted = false;
    let mut autostart_attempted = false;
    let mut hotkeys_attempted = false;
    let mut reload_attempted = false;
    let result = async {
        {
            let mut guard = state.settings.write().map_err(|_| "settings 锁中毒")?;
            *guard = settings.clone();
        }
        if runtime_changed {
            profiles::regenerate_runtime_async(&app).await?;
        }
        state.persist_settings(&settings)?;

        if sys_proxy_changed {
            if settings.sys_proxy || prev.sys_proxy {
                proxy_attempted = true;
                sysproxy_win::apply(&settings)?;
            }
            sysproxy_win::restart_guard(&app);
        }
        if autostart_changed {
            autostart_attempted = true;
            autostart::apply(&app, &settings)?;
        }
        if runtime_changed {
            reload_attempted = true;
            core::reload_runtime_with_auth(
                &app,
                prev.external_controller.clone(),
                prev.secret.clone(),
            )
            .await?;
        }
        if settings.hotkeys != prev.hotkeys {
            hotkeys_attempted = true;
            hotkeys::sync(&app)?;
        }
        Ok::<(), String>(())
    }
    .await;

    if let Err(err) = result {
        let mut errors = Vec::new();
        match state.settings.write() {
            Ok(mut guard) => *guard = prev.clone(),
            Err(_) => errors.push("恢复 settings 内存快照失败".to_string()),
        }
        // 恢复原始文件字节, 不重新执行可能变化/失败的增强链。
        let files_restored = match transaction.rollback() {
            Ok(()) => true,
            Err(rollback) => {
                errors.push(rollback);
                false
            }
        };
        if proxy_attempted {
            if let Err(rollback) = sysproxy_win::apply(&prev) {
                errors.push(rollback);
            }
        }
        if sys_proxy_changed {
            sysproxy_win::restart_guard(&app);
        }
        if autostart_attempted {
            if let Err(rollback) = autostart::apply(&app, &prev) {
                errors.push(rollback);
            }
        }
        if hotkeys_attempted {
            if let Err(rollback) = hotkeys::sync(&app) {
                errors.push(rollback);
            }
        }
        if reload_attempted && files_restored {
            // 请求超时时新控制器可能已经生效, 先尝试新地址, 再尝试旧地址。
            let mut restored = core::reload_runtime_with_auth(
                &app,
                settings.external_controller.clone(),
                settings.secret.clone(),
            )
            .await;
            if restored.is_err()
                && (settings.external_controller != prev.external_controller
                    || settings.secret != prev.secret)
            {
                restored = core::reload_runtime_with_auth(
                    &app,
                    prev.external_controller.clone(),
                    prev.secret.clone(),
                )
                .await;
            }
            if let Err(rollback) = restored {
                errors.push(rollback);
            }
        }
        tray::sync_tray(&app);
        return Err(if errors.is_empty() {
            err
        } else {
            format!("{err}; 回滚失败: {}", errors.join("; "))
        });
    }
    transaction.commit();

    tray::sync_tray(&app);
    Ok(())
}

#[tauri::command]
pub async fn core_status(app: AppHandle) -> CoreStatus {
    core::status(&app).await
}

#[tauri::command]
pub async fn start_core(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _configuration = state.config_lock.lock().await;
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || core::start(&worker))
        .await
        .map_err(|e| format!("启动任务失败: {e}"))?
}

#[tauri::command]
pub async fn stop_core(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _configuration = state.config_lock.lock().await;
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || core::stop(&worker))
        .await
        .map_err(|e| format!("停止任务失败: {e}"))?
}

#[tauri::command]
pub async fn restart_core(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _configuration = state.config_lock.lock().await;
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || core::restart(&worker))
        .await
        .map_err(|e| format!("重启任务失败: {e}"))?
}

#[tauri::command]
pub fn list_profiles(app: AppHandle) -> Result<Vec<ProfileMeta>, String> {
    profiles::load_index(&app)
}

#[tauri::command]
pub async fn import_profile(app: AppHandle, url: String) -> Result<ProfileMeta, String> {
    profiles::import(&app, url).await
}

#[tauri::command]
pub async fn import_profile_file(
    app: AppHandle,
    name: String,
    content: String,
) -> Result<ProfileMeta, String> {
    profiles::import_file(&app, name, content).await
}

#[tauri::command]
pub async fn update_profile(app: AppHandle, id: String) -> Result<ProfileMeta, String> {
    profiles::update(&app, id).await
}

#[tauri::command]
pub async fn update_profile_meta(
    app: AppHandle,
    id: String,
    name: String,
    url: Option<String>,
    auto_update_min: Option<u32>,
) -> Result<ProfileMeta, String> {
    profiles::update_meta(&app, id, name, url, auto_update_min).await
}

#[tauri::command]
pub async fn select_profile(app: AppHandle, id: String) -> Result<(), String> {
    profiles::select(&app, id).await
}

#[tauri::command]
pub async fn delete_profile(app: AppHandle, id: String) -> Result<(), String> {
    profiles::delete(&app, id).await
}

#[tauri::command]
pub fn read_profile(app: AppHandle, id: String) -> Result<String, String> {
    profiles::read_content(&app, &id)
}

#[tauri::command]
pub fn list_profile_rule_targets(app: AppHandle, id: String) -> Result<Vec<String>, String> {
    profiles::list_rule_targets(&app, &id)
}

#[tauri::command]
pub async fn save_profile_content(
    app: AppHandle,
    id: String,
    content: String,
) -> Result<(), String> {
    profiles::save_content(&app, id, content).await
}

/* ---------------- 配置增强链(M2) ---------------- */

#[tauri::command]
pub fn read_enhancer(
    app: AppHandle,
    profile_id: String,
    enhancer_id: String,
) -> Result<String, String> {
    profiles::read_enhancer(&app, &profile_id, &enhancer_id)
}

#[tauri::command]
pub async fn save_enhancer(
    app: AppHandle,
    profile_id: String,
    enhancer_id: Option<String>,
    kind: String,
    name: String,
    content: String,
) -> Result<EnhancerMeta, String> {
    profiles::save_enhancer(&app, profile_id, enhancer_id, kind, name, content).await
}

#[tauri::command]
pub async fn delete_enhancer(
    app: AppHandle,
    profile_id: String,
    enhancer_id: String,
) -> Result<(), String> {
    profiles::delete_enhancer(&app, profile_id, enhancer_id).await
}

#[tauri::command]
pub async fn toggle_enhancer(
    app: AppHandle,
    profile_id: String,
    enhancer_id: String,
    enabled: bool,
) -> Result<(), String> {
    profiles::toggle_enhancer(&app, profile_id, enhancer_id, enabled).await
}

#[tauri::command]
pub async fn reorder_enhancers(
    app: AppHandle,
    profile_id: String,
    enhancer_ids: Vec<String>,
) -> Result<(), String> {
    profiles::reorder_enhancers(&app, profile_id, enhancer_ids).await
}

#[tauri::command]
pub async fn set_system_proxy(app: AppHandle, enable: bool) -> Result<(), String> {
    apply_sys_proxy(&app, enable).await?;
    tray::sync_tray(&app);
    Ok(())
}

#[tauri::command]
pub async fn set_tun(app: AppHandle, enable: bool) -> Result<(), String> {
    apply_tun(&app, enable).await?;
    tray::sync_tray(&app);
    Ok(())
}

#[tauri::command]
pub async fn set_mode(app: AppHandle, mode: String) -> Result<(), String> {
    apply_mode(&app, mode).await?;
    tray::sync_tray(&app);
    Ok(())
}

#[tauri::command]
pub fn open_app_dir(app: AppHandle, kind: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let path = match kind.as_str() {
        "config" => state.dirs.config.clone(),
        "core" => state.dirs.config.clone(),
        "logs" => state.dirs.logs.clone(),
        other => return Err(format!("未知目录类型: {other}")),
    };
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("打开目录失败: {e}"))
}

/* ---------------- 系统能力(M2) ---------------- */

#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("非法 URL: {url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("打开链接失败: {e}"))
}

// 服务状态查询
#[tauri::command]
pub async fn service_status() -> String {
    let manager = crate::service_manager::get_service_manager();

    if let Err(err) = crate::service::diagnose_installation() {
        log::warn!("服务安装诊断失败: {err}");
        return "needs-reinstall".to_string();
    }
    if crate::service::status() != "installed" {
        return "not-installed".to_string();
    }
    if !crate::service::is_running() {
        return "unavailable:服务未运行".to_string();
    }

    let ipc_ready = match tauri::async_runtime::spawn_blocking(nova_service_ipc::connect).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(err)) => Err(err.to_string()),
        Err(err) => Err(format!("IPC 检测任务失败: {err}")),
    };
    if let Err(err) = ipc_ready {
        log::warn!("服务 SCM 已运行，但 IPC 不可用: {err}");
        return service_ipc_starting_message(err);
    }

    let reinstall_needed =
        tauri::async_runtime::spawn_blocking(nova_service_ipc::is_reinstall_needed)
            .await
            .unwrap_or(true);
    if reinstall_needed {
        return "needs-reinstall".to_string();
    }

    let mut status = manager.current_status().await;
    if !matches!(
        status,
        crate::service_manager::ServiceStatus::Ready
            | crate::service_manager::ServiceStatus::NeedsReinstall
            | crate::service_manager::ServiceStatus::ReinstallRequired
            | crate::service_manager::ServiceStatus::ForceReinstallRequired
    ) {
        let _ = manager.refresh().await;
        status = manager.current_status().await;
    }

    match status {
        crate::service_manager::ServiceStatus::Ready => "ready".to_string(),
        crate::service_manager::ServiceStatus::NeedsReinstall => "needs-reinstall".to_string(),
        crate::service_manager::ServiceStatus::InstallRequired => "not-installed".to_string(),
        crate::service_manager::ServiceStatus::UninstallRequired => {
            "uninstall-required".to_string()
        }
        crate::service_manager::ServiceStatus::ReinstallRequired => {
            "reinstall-required".to_string()
        }
        crate::service_manager::ServiceStatus::ForceReinstallRequired => {
            "force-reinstall-required".to_string()
        }
        crate::service_manager::ServiceStatus::Unavailable(reason) => {
            format!("unavailable:{}", reason)
        }
    }
}

#[tauri::command]
pub async fn check_tun_adapter(app: AppHandle) -> TunAdapterStatus {
    let settings_tun = app.state::<AppState>().settings_snapshot().tun;
    let mut status = query_tun_adapter_async(settings_tun).await;
    if settings_tun && !status.adapter_present {
        if matches!(core::runtime_tun_enabled(&app).await, Ok(true)) {
            status.status = Some("runtime-enabled".into());
            status.detail = Some(match status.detail {
                Some(detail) => format!("{detail}; mihomo 已确认 tun.enable=true"),
                None => "mihomo 已确认 tun.enable=true".into(),
            });
        }
    }
    status
}

#[tauri::command]
pub async fn probe_url(url: String) -> Result<i64, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("非法 URL: {url}"));
    }

    let started = Instant::now();
    let result = reqwest::Client::new()
        .get(&url)
        .timeout(Duration::from_secs(5))
        .send()
        .await;
    match result {
        Ok(response) if response.status().is_success() => {
            Ok(started.elapsed().as_millis().min(i64::MAX as u128) as i64)
        }
        Ok(response) => {
            log::debug!("网络探测返回非成功状态: {}", response.status());
            Ok(-1)
        }
        Err(err) => {
            log::debug!("网络探测失败: {}", err.without_url());
            Ok(-1)
        }
    }
}

#[tauri::command]
pub async fn install_service(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _configuration = state.config_lock.lock().await;
    let sidecar_was_running = core::is_sidecar_running(&app);
    if sidecar_was_running {
        core::stop_sidecar(&app)?;
    }
    // 清理残留 mihomo，避免旧进程占用文件导致安装失败
    core::stop_orphan_sidecars(&app);

    let manager = crate::service_manager::get_service_manager();
    let result = manager
        .handle_service_status(crate::service_manager::ServiceStatus::InstallRequired)
        .await;

    if let Err(err) = result {
        if sidecar_was_running {
            let _ = core::start(&app);
        }
        return Err(err);
    }

    // 安装成功，启动内核
    core::start_with_service(&app)?;
    tray::sync_tray(&app);
    Ok(())
}

#[tauri::command]
pub async fn start_service(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _configuration = state.config_lock.lock().await;
    if crate::service::status() != "installed" {
        return Err("服务未安装，请先安装服务模式".into());
    }

    if app.state::<AppState>().settings_snapshot().tun {
        apply_tun_inner(&app, true).await?;
        tray::sync_tray(&app);
        return Ok(());
    }

    let sidecar_was_running = core::is_sidecar_running(&app);
    if sidecar_was_running {
        core::stop_sidecar(&app)?;
    }

    if let Err(err) = core::start_with_service(&app) {
        if sidecar_was_running {
            let _ = core::start(&app);
        }
        return Err(err);
    }

    if let Err(err) = crate::service_manager::get_service_manager()
        .refresh()
        .await
    {
        if sidecar_was_running {
            let _ = core::start(&app);
        }
        return Err(err);
    }

    tray::sync_tray(&app);
    Ok(())
}

#[tauri::command]
pub async fn uninstall_service(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _configuration = state.config_lock.lock().await;
    let had_tun = app.state::<AppState>().settings_snapshot().tun;
    // 卸载前彻底停止内核：先停 sidecar，再经 IPC 停止服务托管的 mihomo，
    // 最后兜底清理任何命令行指向本应用配置目录的残留 mihomo 进程，
    // 否则卸载后 mihomo 仍在运行会占用文件，导致后续安装失败。
    let _ = core::stop(&app);
    core::stop_orphan_sidecars(&app);

    let manager = crate::service_manager::get_service_manager();
    manager
        .handle_service_status(crate::service_manager::ServiceStatus::UninstallRequired)
        .await?;

    if had_tun {
        let mut settings = app.state::<AppState>().settings_snapshot();
        settings.tun = false;
        save_settings_inner(app.clone(), settings).await?;
    }

    tray::sync_tray(&app);
    Ok(())
}

#[tauri::command]
pub async fn reinstall_service(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _configuration = state.config_lock.lock().await;
    let sidecar_was_running = core::is_sidecar_running(&app);
    if sidecar_was_running {
        core::stop_sidecar(&app)?;
    }
    // 清理残留 mihomo，避免旧进程占用文件导致重装失败
    core::stop_orphan_sidecars(&app);

    let manager = crate::service_manager::get_service_manager();
    let result = manager
        .handle_service_status(crate::service_manager::ServiceStatus::ReinstallRequired)
        .await;

    if let Err(err) = result {
        if sidecar_was_running {
            let _ = core::start(&app);
        }
        return Err(err);
    }

    core::start(&app)?;
    tray::sync_tray(&app);
    Ok(())
}

#[tauri::command]
pub async fn repair_service(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _configuration = state.config_lock.lock().await;
    repair_service_inner(app.clone()).await
}

async fn repair_service_inner(app: AppHandle) -> Result<(), String> {
    let sidecar_was_running = core::is_sidecar_running(&app);
    if sidecar_was_running {
        core::stop_sidecar(&app)?;
    }
    // 清理残留 mihomo，避免旧进程占用文件导致修复失败
    core::stop_orphan_sidecars(&app);

    let manager = crate::service_manager::get_service_manager();
    let result = manager
        .handle_service_status(crate::service_manager::ServiceStatus::ForceReinstallRequired)
        .await;

    if let Err(err) = result {
        if sidecar_was_running {
            let _ = core::start(&app);
        }
        return Err(err);
    }

    core::start(&app)?;
    tray::sync_tray(&app);
    Ok(())
}

/// 解除全部 UWP 应用的回环限制(PowerShell 枚举 AppX 包逐个豁免)。
#[tauri::command]
pub async fn exempt_uwp_loopback() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut cmd = std::process::Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-Command",
            "Get-AppxPackage | ForEach-Object { CheckNetIsolation.exe LoopbackExempt -a \"-n=$($_.PackageFamilyName)\" } | Out-Null",
        ]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let out = cmd.output().map_err(|e| format!("执行失败: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "UWP 豁免失败: {}",
                String::from_utf8_lossy(&out.stderr)
            ))
        }
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

#[derive(Debug, serde::Deserialize)]
struct GitHubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}

#[derive(Debug, serde::Deserialize)]
struct GitHubTag {
    name: String,
}

#[derive(Debug, Eq, PartialEq)]
struct ParsedVersion {
    parts: Vec<u64>,
}

impl Ord for ParsedVersion {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        let len = self.parts.len().max(other.parts.len());
        for i in 0..len {
            let left = self.parts.get(i).copied().unwrap_or(0);
            let right = other.parts.get(i).copied().unwrap_or(0);
            match left.cmp(&right) {
                std::cmp::Ordering::Equal => continue,
                ordering => return ordering,
            }
        }
        std::cmp::Ordering::Equal
    }
}

impl PartialOrd for ParsedVersion {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

fn parse_stable_version(tag: &str) -> Option<(String, ParsedVersion)> {
    let version = tag.trim().trim_start_matches(|c| c == 'v' || c == 'V');
    if version.is_empty() || version.contains('-') {
        return None;
    }
    let version = version.split('+').next().unwrap_or(version);
    let parts = version
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if parts.is_empty() {
        return None;
    }
    Some((version.to_string(), ParsedVersion { parts }))
}

fn newest_version<I>(tags: I) -> Option<String>
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    tags.into_iter()
        .filter_map(|tag| parse_stable_version(tag.as_ref()))
        .max_by(|(_, left), (_, right)| left.cmp(right))
        .map(|(version, _)| version)
}

async fn get_github_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
) -> Result<T, String> {
    let resp = client
        .get(url)
        .header(
            "User-Agent",
            format!("ClashNova/{}", env!("CARGO_PKG_VERSION")),
        )
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("检查更新失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("检查更新失败: HTTP {}", resp.status()));
    }
    resp.json().await.map_err(|e| format!("解析失败: {e}"))
}

async fn latest_release_version(client: &reqwest::Client) -> Result<Option<String>, String> {
    const RELEASES_API: &str =
        "https://api.github.com/repos/ipiggyzhu/ClashNova/releases?per_page=20";
    let releases: Vec<GitHubRelease> = get_github_json(client, RELEASES_API).await?;
    Ok(newest_version(
        releases
            .into_iter()
            .filter(|release| !release.draft && !release.prerelease)
            .map(|release| release.tag_name),
    ))
}

async fn latest_tag_version(client: &reqwest::Client) -> Result<Option<String>, String> {
    const TAGS_API: &str = "https://api.github.com/repos/ipiggyzhu/ClashNova/tags?per_page=50";
    let tags: Vec<GitHubTag> = get_github_json(client, TAGS_API).await?;
    Ok(newest_version(tags.into_iter().map(|tag| tag.name)))
}

/// GitHub 最新版本号;比当前稳定版本新则返回 Some(版本)。
/// Release 列表优先, tags 兜底, 避免 latest release 缺失或标记异常导致误判。
#[tauri::command]
pub async fn check_update() -> Result<Option<String>, String> {
    let client = reqwest::Client::new();
    let latest = match latest_release_version(&client).await {
        Ok(Some(version)) => Some(version),
        Ok(None) => latest_tag_version(&client).await?,
        Err(release_err) => match latest_tag_version(&client).await {
            Ok(version) => version,
            Err(tag_err) => return Err(format!("{release_err}; fallback tags failed: {tag_err}")),
        },
    };
    let Some(latest) = latest else {
        return Ok(None);
    };
    let Some((_, latest_parsed)) = parse_stable_version(&latest) else {
        return Ok(None);
    };
    let Some((_, current_parsed)) = parse_stable_version(env!("CARGO_PKG_VERSION")) else {
        return Ok(None);
    };
    Ok((latest_parsed > current_parsed).then_some(latest))
}

/// 流量统计: 总量时间序列(range: day|7d|30d)。
#[tauri::command]
pub async fn query_traffic_series(
    app: AppHandle,
    range: String,
) -> Result<Vec<crate::stats::SeriesPoint>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::stats::query_series(&app, &range))
        .await
        .map_err(|e| e.to_string())?
}

/// 流量统计: 维度排行(dim: proxy|process|host)。
#[tauri::command]
pub async fn query_traffic_rank(
    app: AppHandle,
    dim: String,
    range: String,
) -> Result<Vec<crate::stats::RankRow>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::stats::query_rank(&app, &dim, &range))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn query_traffic_summary(
    app: AppHandle,
    range: String,
) -> Result<crate::stats::TrafficSummary, String> {
    tauri::async_runtime::spawn_blocking(move || crate::stats::query_summary(&app, &range))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn get_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "macOS",
        "linux" => "Linux",
        other => other,
    }
}

/// 恢复默认设置并按差异应用全部副作用。
#[tauri::command]
pub async fn reset_settings(app: AppHandle) -> Result<AppSettings, String> {
    let defaults = AppSettings::default();
    save_settings(app, defaults.clone()).await?;
    Ok(defaults)
}

/// 获取当前运行时配置 YAML(只读查看)。
#[tauri::command]
pub fn get_runtime_config(app: AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    let path = state.dirs.runtime_config();
    log::info!("读取运行时配置: {}", path.display());

    match std::fs::read_to_string(&path) {
        Ok(content) => {
            log::info!("读取成功，内容长度: {} 字节", content.len());
            Ok(content)
        }
        Err(e) => {
            log::error!("读取运行时配置失败: {}", e);
            Err(format!("读取运行时配置失败: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn settings_patch_preserves_fields_not_in_the_patch() {
        let settings = AppSettings {
            language: "en".into(),
            mixed_port: 8901,
            ..AppSettings::default()
        };
        let merged =
            merge_settings_patch(&settings, serde_json::json!({ "theme": "light" })).unwrap();
        assert_eq!(merged.theme, "light");
        assert_eq!(merged.language, "en");
        assert_eq!(merged.mixed_port, 8901);
    }

    #[test]
    fn settings_patch_rejects_invalid_shape_fields_and_values_without_echoing_them() {
        let settings = AppSettings::default();
        assert!(merge_settings_patch(&settings, serde_json::json!([])).is_err());
        assert!(merge_settings_patch(&settings, serde_json::json!({ "unknown": true })).is_err());
        let err = merge_settings_patch(
            &settings,
            serde_json::json!({ "mixedPort": "sensitive-input" }),
        )
        .unwrap_err();
        assert!(!err.contains("sensitive-input"));
    }

    #[tokio::test]
    async fn http_probe_requires_a_success_status() {
        for (status, success) in [
            ("200 OK", true),
            ("204 No Content", true),
            ("404 Not Found", false),
            ("500 Internal Server Error", false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) =
                    tokio::time::timeout(Duration::from_secs(8), listener.accept())
                        .await
                        .unwrap()
                        .unwrap();
                let mut request = [0u8; 2048];
                socket.read(&mut request).await.unwrap();
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            });
            let result = probe_url(url).await.unwrap();
            server.await.unwrap();
            assert_eq!(result >= 0, success, "{status}");
        }
    }

    #[tokio::test]
    async fn http_probe_rejects_non_http_urls() {
        assert!(probe_url("file:///not-a-network-probe".into())
            .await
            .is_err());
    }
}
