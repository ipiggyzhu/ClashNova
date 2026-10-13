//! 托盘快捷面板：按显示器工作区和 DPI 定位，隐藏后由前端释放实时订阅；
//! 轻量驻留下持续隐藏一段时间后销毁 WebView。
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::state::AppState;

static OPENING_PANEL: AtomicBool = AtomicBool::new(false);
/// 每次打开递增；延迟释放任务据此判断期间是否重新打开过。
static PANEL_GENERATION: AtomicU64 = AtomicU64::new(0);
/// 留一段缓冲，避免频繁开合时反复冷启动 WebView。
const PANEL_RELEASE_DELAY: Duration = Duration::from_secs(60);

fn panel_bounds(
    anchor: (f64, f64),
    area: (i32, i32, u32, u32),
    scale: f64,
) -> (i32, i32, u32, u32) {
    let (left, top, width, height) = area;
    let gap = ((8.0 * scale).round() as u32).min(width.min(height).saturating_sub(1) / 2);
    let panel_width = ((368.0 * scale).round() as u32)
        .min(width.saturating_sub(gap * 2))
        .max(1);
    let panel_height = ((600.0 * scale).round() as u32)
        .min(height.saturating_sub(gap * 2))
        .max(1);
    let min_x = left + gap as i32;
    let min_y = top + gap as i32;
    let max_x = (left + width as i32 - gap as i32 - panel_width as i32).max(min_x);
    let max_y = (top + height as i32 - gap as i32 - panel_height as i32).max(min_y);
    let x = (anchor.0 - panel_width as f64 + 16.0 * scale).round() as i32;
    let above = (anchor.1 - panel_height as f64 - gap as f64).round() as i32;
    let y = if above >= min_y {
        above
    } else {
        (anchor.1 + gap as f64).round() as i32
    };
    (
        x.clamp(min_x, max_x),
        y.clamp(min_y, max_y),
        panel_width,
        panel_height,
    )
}

pub fn hide(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("tray") {
        window.hide().map_err(|err| err.to_string())?;
        let _ = window.emit("tray-visibility", false);
        if app.state::<AppState>().settings_snapshot().lightweight_on_close {
            schedule_release(app);
        }
    }
    Ok(())
}

/// 主窗口也销毁后不再有 WebView 存活，WebView2 浏览器进程才能整体退出。
fn schedule_release(app: &AppHandle) {
    let generation = PANEL_GENERATION.load(Ordering::Acquire);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(PANEL_RELEASE_DELAY).await;
        // 与打开流程互斥，避免销毁正在重新显示的面板。
        if PANEL_GENERATION.load(Ordering::Acquire) != generation
            || OPENING_PANEL.swap(true, Ordering::AcqRel)
        {
            return;
        }
        if let Some(window) = app
            .get_webview_window("tray")
            .filter(|window| !window.is_visible().unwrap_or(true))
        {
            if let Err(err) = window.destroy() {
                log::warn!("释放快捷面板失败: {err}");
            }
        }
        OPENING_PANEL.store(false, Ordering::Release);
    });
}

pub fn toggle(app: &AppHandle, position: PhysicalPosition<f64>) {
    if let Some(window) = app.get_webview_window("tray") {
        if window.is_visible().unwrap_or(false) {
            if let Err(err) = hide(app) {
                log::warn!("关闭快捷面板失败: {err}");
            }
            return;
        }
    }
    if OPENING_PANEL.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    // 避开 WebView2 同步事件回调创建窗口的死锁。
    tauri::async_runtime::spawn_blocking(move || {
        let result = show(&app, position);
        OPENING_PANEL.store(false, Ordering::Release);
        if let Err(err) = result {
            log::error!("打开快捷面板失败: {err}");
            crate::tray::show_main_window(&app);
            let _ = app.emit(
                "operation-error",
                serde_json::json!({
                    "title": "打开快捷面板失败", "message": err,
                }),
            );
        }
    });
}

fn show(app: &AppHandle, position: PhysicalPosition<f64>) -> Result<(), String> {
    PANEL_GENERATION.fetch_add(1, Ordering::AcqRel);
    let monitor = app
        .monitor_from_point(position.x, position.y)
        .map_err(|err| err.to_string())?
        .or(app.primary_monitor().map_err(|err| err.to_string())?)
        .ok_or_else(|| "未找到可用显示器".to_string())?;
    let area = monitor.work_area();
    let (x, y, width, height) = panel_bounds(
        (position.x, position.y),
        (
            area.position.x,
            area.position.y,
            area.size.width,
            area.size.height,
        ),
        monitor.scale_factor(),
    );
    let window = match app.get_webview_window("tray") {
        Some(window) => window,
        None => WebviewWindowBuilder::new(app, "tray", WebviewUrl::App("tray".into()))
            .title("ClashNova · 快捷面板")
            .inner_size(368.0, 600.0)
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .shadow(true)
            .transparent(true)
            .visible(false)
            .focused(false)
            .build()
            .map_err(|err| err.to_string())?,
    };
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|err| err.to_string())?;
    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(|err| err.to_string())?;
    window.show().map_err(|err| err.to_string())?;
    let _ = window.emit("tray-visibility", true);
    window.set_focus().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn tray_panel_visible(window: WebviewWindow) -> Result<bool, String> {
    if window.label() != "tray" {
        return Ok(false);
    }
    window.is_visible().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn hide_tray_panel(app: AppHandle) -> Result<(), String> {
    hide(&app)
}

#[tauri::command]
pub fn tray_open_main(app: AppHandle) {
    crate::tray::show_main_window(&app);
}

#[tauri::command]
pub fn tray_quit_app(app: AppHandle) {
    crate::tray::quit(&app);
}

#[cfg(test)]
mod tests {
    use super::panel_bounds;

    #[test]
    fn panel_stays_above_bottom_taskbar() {
        assert_eq!(
            panel_bounds((1890.0, 1060.0), (0, 0, 1920, 1040), 1.0),
            (1538, 432, 368, 600)
        );
    }

    #[test]
    fn top_and_side_taskbars_keep_panel_inside_work_area() {
        assert_eq!(
            panel_bounds((100.0, 20.0), (0, 40, 1920, 1040), 1.0),
            (8, 48, 368, 600)
        );
        let (x, y, width, height) = panel_bounds((20.0, 600.0), (48, 0, 1872, 1080), 1.0);
        assert!(x >= 56 && y >= 8);
        assert!(x + width as i32 <= 1912 && y + height as i32 <= 1072);
    }

    #[test]
    fn negative_secondary_monitor_and_fractional_dpi_are_preserved() {
        let (x, y, width, height) = panel_bounds((-20.0, 1040.0), (-1920, 0, 1920, 1040), 1.25);
        assert_eq!((width, height), (460, 750));
        assert!(x >= -1910 && x + width as i32 <= -10);
        assert!(y >= 10 && y + height as i32 <= 1030);
    }

    #[test]
    fn high_dpi_small_work_area_shrinks_instead_of_clipping_controls() {
        let (x, y, width, height) = panel_bounds((790.0, 590.0), (0, 0, 800, 560), 2.0);
        assert_eq!((width, height), (736, 528));
        assert!(x >= 16 && x + width as i32 <= 784);
        assert_eq!(y, 16);
    }
}
