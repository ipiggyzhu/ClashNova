#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! ClashNova 服务卸载程序
//!
//! 这是一个独立的可执行文件，用于卸载 ClashNova 内核服务。
//! 它会被主程序在需要时调用，并通过 UAC 提权。

#[cfg(windows)]
use windows_service::{
    service::{ServiceAccess, ServiceState},
    service_manager::{ServiceManager, ServiceManagerAccess},
};

const SERVICE_NAME: &str = "clashnova-core";

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn write_result(path: Option<&str>, ok: bool, message: &str) {
    if let Some(path) = path {
        let prefix = if ok { "ok" } else { "error" };
        let _ = std::fs::write(path, format!("{prefix}\n{message}\n"));
    }
}

#[cfg(windows)]
fn wait_until_removed(manager: &ServiceManager) -> Result<(), String> {
    for _ in 0..40 {
        if manager
            .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS)
            .is_err()
        {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    Err("旧服务删除超时".into())
}

#[cfg(windows)]
fn is_service_not_found(err: &str) -> bool {
    err.contains("does not exist")
        || err.contains("not exist")
        || err.contains("1060")
        || err.contains("ERROR_SERVICE_DOES_NOT_EXIST")
        || err.contains("服务不存在")
        || err.contains("服务未安装")
        || err.contains("指定的服务")
}

fn main() {
    // 初始化日志
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    log::info!("ClashNova 服务卸载程序启动");
    let args: Vec<String> = std::env::args().collect();
    let result_path = arg_value(&args, "--result");

    // 执行卸载
    match uninstall() {
        Ok(_) => {
            log::info!("服务卸载成功");
            println!("服务卸载成功");
            write_result(result_path.as_deref(), true, "服务卸载成功");
            std::process::exit(0);
        }
        Err(e) => {
            log::error!("服务卸载失败: {}", e);
            eprintln!("服务卸载失败: {}", e);
            write_result(result_path.as_deref(), false, &e);
            std::process::exit(1);
        }
    }
}

#[cfg(windows)]
fn uninstall() -> Result<(), String> {
    log::info!("开始卸载服务: {}", SERVICE_NAME);

    // 连接到服务管理器
    let manager_access = ServiceManagerAccess::CONNECT;
    let manager = ServiceManager::local_computer(None::<&str>, manager_access)
        .map_err(|e| format!("连接服务管理器失败（需要管理员权限）: {}", e))?;

    // 打开服务
    let service_access = ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE;
    let service = match manager.open_service(SERVICE_NAME, service_access) {
        Ok(service) => service,
        Err(e) => {
            let message = e.to_string();
            if is_service_not_found(&message) {
                log::info!("服务未安装，无需卸载");
                return Ok(());
            }
            return Err(format!("打开服务失败: {}", message));
        }
    };

    // 查询服务状态
    if let Ok(status) = service.query_status() {
        log::info!("服务状态: {:?}", status.current_state);

        // 如果服务正在运行，先停止
        if status.current_state != ServiceState::Stopped {
            log::info!("停止服务");

            service.stop().map_err(|e| format!("停止服务失败: {}", e))?;

            // 等待服务停止
            for i in 0..20 {
                std::thread::sleep(std::time::Duration::from_millis(250));
                if let Ok(status) = service.query_status() {
                    if status.current_state == ServiceState::Stopped {
                        log::info!("服务已停止");
                        break;
                    }
                }

                if i == 19 {
                    log::warn!("服务停止超时，但继续卸载");
                }
            }
        }
    }

    // 删除服务
    log::info!("删除服务");
    service
        .delete()
        .map_err(|e| format!("删除服务失败: {}", e))?;

    drop(service);
    wait_until_removed(&manager)?;

    log::info!("服务卸载成功");
    Ok(())
}

#[cfg(not(windows))]
fn uninstall() -> Result<(), String> {
    Err("服务模式仅支持 Windows".into())
}
