//! 契约 B 的 15 个 Tauri 命令 + 托盘共用的内部应用函数。

use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

use crate::core::{self, CoreStatus};
use crate::profiles::{self, ProfileMeta};
use crate::state::{AppSettings, AppState};
use crate::{sysproxy_win, tray};

/* ---------------- 内部应用函数(命令与托盘共用) ---------------- */

/// 切换系统代理:更新设置 → 应用注册表 → 重启守卫 → 持久化。
pub fn apply_sys_proxy(app: &AppHandle, enable: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut settings = state.settings_snapshot();
    settings.sys_proxy = enable;
    sysproxy_win::apply(&settings)?;
    {
        let mut guard = state.settings.write().map_err(|_| "settings 锁中毒")?;
        *guard = settings.clone();
    }
    state.persist_settings(&settings)?;
    sysproxy_win::restart_guard(app);
    Ok(())
}

/// 切换 TUN:更新设置 → 重生成运行时配置 → 热加载。
pub async fn apply_tun(app: &AppHandle, enable: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut settings = state.settings_snapshot();
    settings.tun = enable;
    {
        let mut guard = state.settings.write().map_err(|_| "settings 锁中毒")?;
        *guard = settings.clone();
    }
    state.persist_settings(&settings)?;
    profiles::regenerate_runtime(app)?;
    core::reload_runtime(app).await
}

/// 切换出站模式(direct/rule/global):持久化 + 运行时同步。
pub async fn apply_mode(app: &AppHandle, mode: String) -> Result<(), String> {
    if !matches!(mode.as_str(), "direct" | "rule" | "global") {
        return Err(format!("非法模式: {mode}"));
    }
    let state = app.state::<AppState>();
    let mut settings = state.settings_snapshot();
    settings.mode = mode.clone();
    {
        let mut guard = state.settings.write().map_err(|_| "settings 锁中毒")?;
        *guard = settings.clone();
    }
    state.persist_settings(&settings)?;
    // 运行中 → PATCH /configs 轻量切换(前端 REST 也会同步, 此处兜底)
    let (controller, secret) = (settings.external_controller, settings.secret);
    let url = format!("http://{controller}/configs");
    let _ = reqwest::Client::new()
        .patch(&url)
        .bearer_auth(&secret)
        .json(&serde_json::json!({ "mode": mode }))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await;
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
    {
        let mut guard = state.settings.write().map_err(|_| "settings 锁中毒")?;
        *guard = settings.clone();
    }
    state.persist_settings(&settings)?;

    // 系统代理或其参数变化 → 重新应用 + 守卫换代
    if settings.sys_proxy != prev.sys_proxy
        || settings.mixed_port != prev.mixed_port
        || settings.bypass != prev.bypass
        || settings.guard != prev.guard
        || settings.guard_interval_sec != prev.guard_interval_sec
    {
        if settings.sys_proxy || prev.sys_proxy {
            sysproxy_win::apply(&settings)?;
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
        result.map_err(|e| format!("设置开机自启失败: {e}"))?;
    }

    // 影响 mihomo 运行时配置的项 → 重生成 + 热加载
    if settings.mixed_port != prev.mixed_port
        || settings.external_controller != prev.external_controller
        || settings.secret != prev.secret
        || settings.allow_lan != prev.allow_lan
        || settings.ipv6 != prev.ipv6
        || settings.log_level != prev.log_level
        || settings.tun != prev.tun
        || settings.mode != prev.mode
    {
        profiles::regenerate_runtime(&app)?;
        core::reload_runtime(&app).await?;
    }

    tray::sync_tray(&app);
    Ok(())
}

#[tauri::command]
pub fn core_status(app: AppHandle) -> CoreStatus {
    core::status(&app)
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
pub async fn update_profile(app: AppHandle, id: String) -> Result<ProfileMeta, String> {
    profiles::update(&app, id).await
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
pub async fn save_profile_content(
    app: AppHandle,
    id: String,
    content: String,
) -> Result<(), String> {
    profiles::save_content(&app, id, content).await
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
