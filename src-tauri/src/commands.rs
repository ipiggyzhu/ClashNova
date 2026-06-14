//! 契约 B 的 15 个 Tauri 命令 + 托盘共用的内部应用函数。

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

    // 开启 TUN 时检查服务状态
    if enable {
        // 检查服务是否安装
        if service::status() != "installed" {
            return Err("TUN 模式需要服务模式支持，请先安装服务".into());
        }
        // 检查服务是否运行
        if !service::is_running() {
            // 服务已安装但未运行，尝试启动
            #[cfg(windows)]
            {
                use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
                use windows_service::service::{ServiceAccess, ServiceState};

                let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
                    .map_err(|e| format!("连接服务管理器失败: {e}"))?;
                let service_access = ServiceAccess::QUERY_STATUS | ServiceAccess::START;
                let svc = manager.open_service(service::SERVICE_NAME, service_access)
                    .map_err(|e| format!("打开服务失败: {e}"))?;

                // 检查状态并启动
                if let Ok(status) = svc.query_status() {
                    if status.current_state != ServiceState::Running {
                        use std::ffi::OsStr;
                        svc.start(&Vec::<&OsStr>::new())
                            .map_err(|e| format!("启动服务失败: {e}"))?;
                        log::info!("TUN 模式：服务已启动");
                    }
                }
            }
        }
        // 停止 sidecar 内核，让服务接管
        let _ = core::stop(app);
    }

    profiles::regenerate_runtime(app)?;
    core::reload_runtime(app).await?;

    // 开启 TUN 后重启内核，让服务接管
    if enable {
        core::restart(app)?;
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

    // 系统代理开关/参数变化 → 重新应用注册表 + 守卫换代（不触发内核重载）
    if settings.sys_proxy != prev.sys_proxy
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
        || settings.dns_override != prev.dns_override
        || settings.hosts != prev.hosts
    {
        profiles::regenerate_runtime(&app)?;
        core::reload_runtime(&app).await?;
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

/* ---------------- 配置增强链(M2) ---------------- */

#[tauri::command]
pub fn read_enhancer(app: AppHandle, profile_id: String, enhancer_id: String) -> Result<String, String> {
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

#[tauri::command]
pub async fn service_status() -> String {
    tauri::async_runtime::spawn_blocking(|| service::status().to_string())
        .await
        .unwrap_or_else(|_| "not-installed".into())
}

#[tauri::command]
pub async fn install_service(app: AppHandle) -> Result<(), String> {
    let dir = app.state::<AppState>().dirs.config.clone();

    // 检查是否需要提权
    #[cfg(windows)]
    {
        use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
        let manager_access = ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE;
        if ServiceManager::local_computer(None::<&str>, manager_access).is_err() {
            // 需要提权，用 PowerShell 重启自身执行安装
            return elevate_install_service(&dir).await;
        }
    }

    // 已有管理员权限，直接安装
    tauri::async_runtime::spawn_blocking(move || service::install(&dir))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub async fn uninstall_service() -> Result<(), String> {
    // 检查是否需要提权
    #[cfg(windows)]
    {
        use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
        if ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT).is_err() {
            // 需要提权，用 PowerShell 重启自身执行卸载
            return elevate_uninstall_service().await;
        }
    }

    // 已有管理员权限，直接卸载
    tauri::async_runtime::spawn_blocking(service::uninstall)
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

/// 用 PowerShell 提权执行服务安装（通过重启自身并传递 --install-service 参数）
#[cfg(windows)]
async fn elevate_install_service(config_dir: &std::path::Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("定位自身失败: {e}"))?;
    let ps_cmd = format!(
        "Start-Process '{}' -ArgumentList '--install-service','--dir','{}' -Verb RunAs -Wait",
        exe.display(),
        config_dir.display()
    );

    let output = std::process::Command::new("powershell.exe")
        .args(&["-NoProfile", "-Command", &ps_cmd])
        .output()
        .map_err(|e| format!("执行 PowerShell 失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.is_empty() || stderr.contains("canceled") || stderr.contains("取消") {
            return Err("用户取消了 UAC 授权".into());
        }
        return Err(format!("提权失败: {}", stderr));
    }

    Ok(())
}

/// 用 PowerShell 提权执行服务卸载
#[cfg(windows)]
async fn elevate_uninstall_service() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("定位自身失败: {e}"))?;
    let ps_cmd = format!(
        "Start-Process '{}' -ArgumentList '--uninstall-service' -Verb RunAs -Wait",
        exe.display()
    );

    let output = std::process::Command::new("powershell.exe")
        .args(&["-NoProfile", "-Command", &ps_cmd])
        .output()
        .map_err(|e| format!("执行 PowerShell 失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.is_empty() || stderr.contains("canceled") || stderr.contains("取消") {
            return Err("用户取消了 UAC 授权".into());
        }
        return Err(format!("提权失败: {}", stderr));
    }

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
pub fn query_traffic_series(app: AppHandle, range: String) -> Result<Vec<crate::stats::SeriesPoint>, String> {
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
    std::fs::read_to_string(&path)
        .map_err(|e| format!("读取运行时配置失败: {e}"))
}
