//! 开机自启:Windows 下直接维护 HKCU Run 项, 确保带空格的安装路径被正确引用。

use tauri::AppHandle;
#[cfg(not(windows))]
use tauri_plugin_autostart::ManagerExt;

use crate::state::AppSettings;

pub fn apply(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    if settings.autostart {
        enable(app, settings)
    } else {
        disable(app)
    }
}

pub fn sync_if_enabled(app: &AppHandle, settings: &AppSettings) {
    if settings.autostart {
        if let Err(err) = enable(app, settings) {
            log::warn!("同步开机自启失败: {err}");
        }
    }
}

fn enable(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = app;
        windows_impl::enable(settings.silent_start)
    }

    #[cfg(not(windows))]
    {
        let _ = settings;
        app.autolaunch()
            .enable()
            .map_err(|e| format!("设置开机自启失败: {e}"))
    }
}

fn disable(app: &AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = app;
        windows_impl::disable()
    }

    #[cfg(not(windows))]
    {
        app.autolaunch()
            .disable()
            .map_err(|e| format!("设置开机自启失败: {e}"))
    }
}

#[cfg(windows)]
mod windows_impl {
    use winreg::enums::RegType::REG_BINARY;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::{RegKey, RegValue};

    const APP_NAME: &str = "ClashNova";
    const LEGACY_APP_NAME: &str = "clashnova";
    const RUN_KEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
    const STARTUP_APPROVED_KEY: &str =
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
    const STARTUP_APPROVED_ENABLED: [u8; 12] = [
        0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];

    pub fn enable(silent_start: bool) -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| format!("定位当前程序失败: {e}"))?;
        let mut command = quote_arg(&exe.to_string_lossy());
        if silent_start {
            command.push_str(" --silent");
        }

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let run = hkcu
            .open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE)
            .map_err(|e| format!("打开开机自启注册表失败: {e}"))?;
        // 旧版 tauri-plugin-autostart 以包名 clashnova 写入未加引号的命令,
        // 升级后若残留会导致开机被拉起两次, 这里先清掉再写新值。
        delete_value_if_exists(&run, LEGACY_APP_NAME)?;
        run.set_value(APP_NAME, &command)
            .map_err(|e| format!("写入开机自启注册表失败: {e}"))?;

        if let Ok(reg) = hkcu.open_subkey_with_flags(STARTUP_APPROVED_KEY, KEY_SET_VALUE) {
            reg.set_raw_value(
                APP_NAME,
                &RegValue {
                    vtype: REG_BINARY,
                    bytes: STARTUP_APPROVED_ENABLED.to_vec(),
                },
            )
            .map_err(|e| format!("启用任务管理器自启状态失败: {e}"))?;
        }

        Ok(())
    }

    pub fn disable() -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        match hkcu.open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE) {
            Ok(reg) => {
                delete_value_if_exists(&reg, APP_NAME)?;
                delete_value_if_exists(&reg, LEGACY_APP_NAME)?;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("打开开机自启注册表失败: {err}")),
        }

        // 对称清理任务管理器自启状态(StartupApproved), 避免遗留孤儿项。
        match hkcu.open_subkey_with_flags(STARTUP_APPROVED_KEY, KEY_SET_VALUE) {
            Ok(reg) => {
                delete_value_if_exists(&reg, APP_NAME)?;
                delete_value_if_exists(&reg, LEGACY_APP_NAME)?;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("打开任务管理器自启状态失败: {err}")),
        }

        Ok(())
    }

    fn delete_value_if_exists(reg: &RegKey, name: &str) -> Result<(), String> {
        match reg.delete_value(name) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("删除开机自启注册表失败: {err}")),
        }
    }

    fn quote_arg(arg: &str) -> String {
        format!("\"{}\"", arg.replace('"', "\\\""))
    }
}
