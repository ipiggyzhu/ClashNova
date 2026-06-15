//! ClashNova 服务安装程序
//!
//! 这是一个独立的可执行文件，用于安装 ClashNova 内核服务。
//! 它会被主程序在需要时调用，并通过 UAC 提权。

use std::ffi::OsString;
use std::path::PathBuf;

#[cfg(windows)]
use windows_service::{
    service::{
        ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType, ServiceState,
        ServiceType,
    },
    service_manager::{ServiceManager, ServiceManagerAccess},
};

const SERVICE_NAME: &str = "clashnova-core";

fn main() {
    // 初始化日志
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    log::info!("ClashNova 服务安装程序启动");

    // 解析命令行参数
    let args: Vec<String> = std::env::args().collect();

    // 查找 --dir 参数
    let config_dir = if let Some(pos) = args.iter().position(|a| a == "--dir") {
        if let Some(dir) = args.get(pos + 1) {
            PathBuf::from(dir)
        } else {
            eprintln!("错误: --dir 参数缺少值");
            std::process::exit(1);
        }
    } else {
        eprintln!("错误: 缺少 --dir 参数");
        eprintln!("用法: {} --dir <配置目录>", args[0]);
        std::process::exit(1);
    };

    log::info!("配置目录: {}", config_dir.display());

    // 执行安装
    match install(&config_dir) {
        Ok(_) => {
            log::info!("服务安装成功");
            println!("服务安装成功");
            std::process::exit(0);
        }
        Err(e) => {
            log::error!("服务安装失败: {}", e);
            eprintln!("服务安装失败: {}", e);
            std::process::exit(1);
        }
    }
}

#[cfg(windows)]
fn install(config_dir: &std::path::Path) -> Result<(), String> {
    log::info!("开始安装服务: {}", SERVICE_NAME);

    // 获取主程序路径（与安装程序同目录的 clashnova.exe）
    let exe = std::env::current_exe()
        .map_err(|e| format!("获取当前可执行文件路径失败: {}", e))?;

    let main_exe = exe
        .parent()
        .ok_or("无法获取安装程序所在目录")?
        .join("clashnova.exe");

    if !main_exe.exists() {
        return Err(format!(
            "主程序不存在: {}",
            main_exe.display()
        ));
    }

    log::info!("主程序路径: {}", main_exe.display());

    // 服务启动参数
    let launch_args = vec![
        OsString::from("--service"),
        OsString::from("--dir"),
        OsString::from(config_dir),
    ];

    // 连接到服务管理器
    let manager_access = ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE;
    let manager = ServiceManager::local_computer(None::<&str>, manager_access)
        .map_err(|e| format!("连接服务管理器失败（需要管理员权限）: {}", e))?;

    // 检查服务是否已存在
    let service_access = ServiceAccess::QUERY_STATUS | ServiceAccess::START | ServiceAccess::STOP;
    if let Ok(service) = manager.open_service(SERVICE_NAME, service_access) {
        log::info!("服务已存在，检查状态");

        // 查询服务状态
        if let Ok(status) = service.query_status() {
            match status.current_state {
                ServiceState::Running => {
                    log::info!("服务已在运行");
                    return Ok(());
                }
                ServiceState::Stopped | ServiceState::StopPending | ServiceState::Paused | ServiceState::PausePending => {
                    log::info!("服务已存在但未运行，尝试启动");

                    // 启动服务
                    service
                        .start(&Vec::<&std::ffi::OsStr>::new())
                        .map_err(|e| format!("启动已有服务失败: {}", e))?;

                    // 等待服务启动
                    for _ in 0..20 {
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        if let Ok(status) = service.query_status() {
                            if status.current_state == ServiceState::Running {
                                log::info!("服务启动成功");
                                return Ok(());
                            }
                        }
                    }

                    return Err("服务启动超时".into());
                }
                _ => {
                    log::warn!("服务处于未知状态: {:?}", status.current_state);
                }
            }
        }
    }

    // 创建服务
    log::info!("创建新服务");

    let service_info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from("ClashNova Core Service"),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: main_exe,
        launch_arguments: launch_args,
        dependencies: vec![],
        account_name: None, // LocalSystem
        account_password: None,
    };

    let create_access =
        ServiceAccess::CHANGE_CONFIG | ServiceAccess::START | ServiceAccess::QUERY_STATUS;
    let service = manager
        .create_service(&service_info, create_access)
        .map_err(|e| format!("创建服务失败: {}", e))?;

    log::info!("设置服务描述");
    service
        .set_description("ClashNova 内核服务 - 用于 TUN 模式免管理员运行")
        .map_err(|e| format!("设置服务描述失败: {}", e))?;

    log::info!("启动服务");
    service
        .start(&Vec::<&std::ffi::OsStr>::new())
        .map_err(|e| format!("启动服务失败: {}", e))?;

    // 等待服务启动
    for _ in 0..20 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if let Ok(status) = service.query_status() {
            if status.current_state == ServiceState::Running {
                log::info!("服务安装并启动成功");
                return Ok(());
            }
        }
    }

    Err("服务启动超时".into())
}

#[cfg(not(windows))]
fn install(_config_dir: &std::path::Path) -> Result<(), String> {
    Err("服务模式仅支持 Windows".into())
}
