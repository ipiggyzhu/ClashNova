//! 契约 B 的 15 个 Tauri 命令 + 托盘共用的内部应用函数。

use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

use crate::core::{self, CoreStatus};
use crate::profiles::{self, EnhancerMeta, ProfileMeta};
use crate::state::{AppSettings, AppState};
use crate::{hotkeys, service, sysproxy_win, tray};

/* ---------------- 内部应用函数(命令与托盘共用) ---------------- */

/// 切换系统代理:更新设置 → 应用注册表 → 重启守卫 → 持久化。
pub fn apply_sys_proxy(app: &AppHandle, enable: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let prev = state.settings_snapshot();
    let mut settings = prev.clone();
    settings.sys_proxy = enable;
    sysproxy_win::apply(&settings)?;

    let write_result = (|| {
        let mut guard = state.settings.write().map_err(|_| "settings 锁中毒")?;
        *guard = settings.clone();
        state.persist_settings(&settings)
    })();
    if let Err(err) = write_result {
        if let Ok(mut guard) = state.settings.write() {
            *guard = prev.clone();
        }
        let _ = state.persist_settings(&prev);
        if settings.sys_proxy || prev.sys_proxy {
            let _ = sysproxy_win::apply(&prev);
        }
        sysproxy_win::restart_guard(app);
        return Err(err);
    }

    sysproxy_win::restart_guard(app);
    Ok(())
}

fn restore_settings(app: &AppHandle, settings: &AppSettings, regenerate_runtime: bool) {
    let state = app.state::<AppState>();
    if let Ok(mut guard) = state.settings.write() {
        *guard = settings.clone();
    }
    let _ = state.persist_settings(settings);
    if regenerate_runtime {
        let _ = profiles::regenerate_runtime(app);
    }
}

fn restore_core_after_tun_failure(
    app: &AppHandle,
    prev_settings: &AppSettings,
    sidecar_was_running: bool,
    service_was_running: bool,
) {
    if prev_settings.tun || service_was_running {
        let _ = service::start_or_elevate();
        let _ = core::start(app);
        return;
    }

    if !service_was_running && service::is_running() {
        let _ = service::stop();
    }
    if sidecar_was_running {
        let _ = core::start_sidecar(app);
    }
}

async fn rollback_tun_change(
    app: &AppHandle,
    prev_settings: &AppSettings,
    sidecar_was_running: bool,
    service_was_running: bool,
) {
    restore_settings(app, prev_settings, true);
    restore_core_after_tun_failure(app, prev_settings, sidecar_was_running, service_was_running);
    let _ = core::reload_runtime(app).await;
}

pub(crate) fn is_service_ipc_failure(err: &str) -> bool {
    err.contains("IPC 调用失败")
        || err.contains("等待服务 IPC 就绪超时")
        || err.contains("解析响应失败")
        || err.contains("服务返回空响应")
        || err.contains("响应为空")
        || err.contains("服务版本不匹配，需要重装")
}

/// 切换 TUN:更新设置 → 检查服务 → 重生成配置 → 重启内核。
pub async fn apply_tun(app: &AppHandle, enable: bool) -> Result<(), String> {
    let state = app.state::<AppState>();

    // 开启 TUN 时需要服务支持（已安装即可，未运行会自动启动）
    if enable && service::status() == "not-installed" {
        return Err("TUN 模式需要服务模式支持，请先在设置中安装服务".into());
    }
    if enable {
        if let Err(err) = service::diagnose_installation() {
            if service::is_repairable_installation_error(&err) {
                log::warn!("检测到服务安装信息可自动修复，开始重装服务: {err}");
                repair_service(app.clone()).await?;
            } else {
                return Err(err);
            }
        }
    }

    let service_was_running = service::is_running();
    let sidecar_was_running = core::is_sidecar_running(app);
    let prev_settings = state.settings_snapshot();
    let mut settings = prev_settings.clone();
    settings.tun = enable;
    {
        let mut guard = state.settings.write().map_err(|_| "settings 锁中毒")?;
        *guard = settings.clone();
    }
    if let Err(err) = profiles::regenerate_runtime(app) {
        restore_settings(app, &prev_settings, false);
        return Err(err);
    }

    // 开启 TUN 时检查服务状态
    if enable {
        if sidecar_was_running {
            let _ = core::stop_sidecar(app);
        }
        // 检查服务是否运行，未运行则启动
        if !service_was_running {
            log::info!("TUN 模式：服务未运行，尝试启动服务");
            core::stop_orphan_sidecars(app);
            if let Err(err) = service::start_or_elevate() {
                rollback_tun_change(
                    app,
                    &prev_settings,
                    sidecar_was_running,
                    service_was_running,
                )
                .await;
                return Err(err);
            }
        }
        if !service::is_running() {
            rollback_tun_change(
                app,
                &prev_settings,
                sidecar_was_running,
                service_was_running,
            )
            .await;
            return Err("TUN 模式需要服务正在运行，但服务启动后未处于运行状态".into());
        }
    }

    if let Err(err) = state.persist_settings(&settings) {
        rollback_tun_change(
            app,
            &prev_settings,
            sidecar_was_running,
            service_was_running,
        )
        .await;
        return Err(err);
    }

    let core_result = if service::is_running() {
        let reload_result = if !enable || service_was_running {
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
            if let Err(repair_err) = repair_service(app.clone()).await {
                rollback_tun_change(
                    app,
                    &prev_settings,
                    sidecar_was_running,
                    service_was_running,
                )
                .await;
                return Err(format!("自动重装服务失败: {repair_err}"));
            }
            if let Err(tun_err) = core::wait_runtime_tun(app, enable, Duration::from_secs(8)).await
            {
                rollback_tun_change(
                    app,
                    &prev_settings,
                    sidecar_was_running,
                    service_was_running,
                )
                .await;
                return Err(tun_err);
            }
            if service::is_running() {
                let _ = crate::service_manager::get_service_manager()
                    .refresh()
                    .await;
            }
            return Ok(());
        }
        rollback_tun_change(
            app,
            &prev_settings,
            sidecar_was_running,
            service_was_running,
        )
        .await;
        return Err(err);
    }

    if let Err(err) = core::wait_runtime_tun(app, enable, Duration::from_secs(8)).await {
        rollback_tun_change(
            app,
            &prev_settings,
            sidecar_was_running,
            service_was_running,
        )
        .await;
        return Err(err);
    }

    if service::is_running() {
        let _ = crate::service_manager::get_service_manager()
            .refresh()
            .await;
    }

    Ok(())
}

/// 切换出站模式(direct/rule/global):持久化 + 运行时同步。
pub async fn apply_mode(app: &AppHandle, mode: String) -> Result<(), String> {
    if !matches!(mode.as_str(), "direct" | "rule" | "global") {
        return Err(format!("非法模式: {mode}"));
    }
    let state = app.state::<AppState>();
    let mut settings = state.settings_snapshot();
    settings.mode = mode;
    save_settings(app.clone(), settings).await?;
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
    {
        let mut guard = state.settings.write().map_err(|_| "settings 锁中毒")?;
        *guard = settings.clone();
    }
    if runtime_changed {
        if let Err(err) = profiles::regenerate_runtime(&app) {
            restore_settings(&app, &prev, false);
            return Err(err);
        }
    }
    if let Err(err) = state.persist_settings(&settings) {
        restore_settings(&app, &prev, runtime_changed);
        return Err(err);
    }

    // 系统代理开关/参数变化 → 重新应用注册表 + 守卫换代（不触发内核重载）
    if sys_proxy_changed {
        if settings.sys_proxy || prev.sys_proxy {
            if let Err(err) = sysproxy_win::apply(&settings) {
                restore_settings(&app, &prev, runtime_changed);
                return Err(err);
            }
        }
        sysproxy_win::restart_guard(&app);
    }

    // 开机自启
    if settings.autostart != prev.autostart {
        let autolaunch = app.autolaunch();
        let result = if settings.autostart {
            autolaunch.enable()
        } else {
            autolaunch.disable()
        };
        if let Err(err) = result.map_err(|e| format!("设置开机自启失败: {e}")) {
            restore_settings(&app, &prev, runtime_changed);
            if sys_proxy_changed && (settings.sys_proxy || prev.sys_proxy) {
                let _ = sysproxy_win::apply(&prev);
                sysproxy_win::restart_guard(&app);
            }
            return Err(err);
        }
    }

    // 影响 mihomo 运行时配置的项 → 重生成 + 热加载
    if runtime_changed {
        let reload_result = if settings.external_controller != prev.external_controller
            || settings.secret != prev.secret
        {
            core::reload_runtime_with_auth(
                &app,
                prev.external_controller.clone(),
                prev.secret.clone(),
            )
            .await
        } else {
            core::reload_runtime(&app).await
        };
        if let Err(err) = reload_result {
            restore_settings(&app, &prev, true);
            if sys_proxy_changed && (settings.sys_proxy || prev.sys_proxy) {
                let _ = sysproxy_win::apply(&prev);
                sysproxy_win::restart_guard(&app);
            }
            if settings.autostart != prev.autostart {
                let autolaunch = app.autolaunch();
                let _ = if prev.autostart {
                    autolaunch.enable()
                } else {
                    autolaunch.disable()
                };
            }
            let _ = core::reload_runtime_with_auth(
                &app,
                prev.external_controller.clone(),
                prev.secret.clone(),
            )
            .await;
            return Err(err);
        }
    }

    // 热键绑定变化 → 重注册
    if settings.hotkeys != prev.hotkeys {
        hotkeys::sync(&app);
    }

    tray::sync_tray(&app);
    Ok(())
}

#[tauri::command]
pub async fn core_status(app: AppHandle) -> CoreStatus {
    core::status(&app).await
}

#[tauri::command]
pub fn start_core(app: AppHandle) -> Result<(), String> {
    core::start(&app)
}

#[tauri::command]
pub fn stop_core(app: AppHandle) -> Result<(), String> {
    core::stop(&app)
}

#[tauri::command]
pub fn restart_core(app: AppHandle) -> Result<(), String> {
    core::restart(&app)
}

#[tauri::command]
pub fn list_profiles(app: AppHandle) -> Vec<ProfileMeta> {
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
pub fn update_profile_meta(
    app: AppHandle,
    id: String,
    name: String,
    url: Option<String>,
    auto_update_min: Option<u32>,
) -> Result<ProfileMeta, String> {
    profiles::update_meta(&app, id, name, url, auto_update_min)
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
pub fn set_system_proxy(app: AppHandle, enable: bool) -> Result<(), String> {
    apply_sys_proxy(&app, enable)?;
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

    if crate::service::diagnose_installation().is_err() {
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
        return "needs-reinstall".to_string();
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
pub async fn install_service(app: AppHandle) -> Result<(), String> {
    let sidecar_was_running = core::is_sidecar_running(&app);
    if sidecar_was_running {
        core::stop_sidecar(&app)?;
    }

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
    core::start(&app)?;
    tray::sync_tray(&app);
    Ok(())
}

#[tauri::command]
pub async fn start_service(app: AppHandle) -> Result<(), String> {
    if crate::service::status() != "installed" {
        return Err("服务未安装，请先安装服务模式".into());
    }

    let sidecar_was_running = core::is_sidecar_running(&app);
    if sidecar_was_running {
        core::stop_sidecar(&app)?;
    }

    if let Err(err) = crate::service::start_or_elevate() {
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

    core::start(&app)?;
    tray::sync_tray(&app);
    Ok(())
}

#[tauri::command]
pub async fn uninstall_service(app: AppHandle) -> Result<(), String> {
    let was_core_running = core::is_running(&app).await;
    let had_tun = app.state::<AppState>().settings_snapshot().tun;

    let manager = crate::service_manager::get_service_manager();
    manager
        .handle_service_status(crate::service_manager::ServiceStatus::UninstallRequired)
        .await?;

    if had_tun {
        let mut settings = app.state::<AppState>().settings_snapshot();
        settings.tun = false;
        save_settings(app.clone(), settings).await?;
    }

    if was_core_running {
        core::start(&app)?;
    }

    tray::sync_tray(&app);
    Ok(())
}

#[tauri::command]
pub async fn reinstall_service(app: AppHandle) -> Result<(), String> {
    let sidecar_was_running = core::is_sidecar_running(&app);
    if sidecar_was_running {
        core::stop_sidecar(&app)?;
    }

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
    let sidecar_was_running = core::is_sidecar_running(&app);
    if sidecar_was_running {
        core::stop_sidecar(&app)?;
    }

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

/// GitHub Releases 最新版本号;比当前新则返回 Some(版本)。
/// (自动安装升级依赖签名密钥与发布基建, 见 BUILD.md)
#[tauri::command]
pub async fn check_update() -> Result<Option<String>, String> {
    const RELEASES_API: &str = "https://api.github.com/repos/ipiggyzhu/ClashNova/releases/latest";
    let resp = reqwest::Client::new()
        .get(RELEASES_API)
        .header("User-Agent", "ClashNova/2.0")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("检查更新失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("检查更新失败: HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("解析失败: {e}"))?;
    let latest = body["tag_name"]
        .as_str()
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    let current = env!("CARGO_PKG_VERSION");
    Ok((!latest.is_empty() && latest != current).then_some(latest))
}

/// 流量统计: 总量时间序列(range: day|7d|30d)。
#[tauri::command]
pub fn query_traffic_series(
    app: AppHandle,
    range: String,
) -> Result<Vec<crate::stats::SeriesPoint>, String> {
    crate::stats::query_series(&app, &range)
}

/// 流量统计: 维度排行(dim: proxy|process|host)。
#[tauri::command]
pub fn query_traffic_rank(
    app: AppHandle,
    dim: String,
    range: String,
) -> Result<Vec<crate::stats::RankRow>, String> {
    crate::stats::query_rank(&app, &dim, &range)
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
