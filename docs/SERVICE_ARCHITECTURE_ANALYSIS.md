# ClashNova 服务架构升级方案

## 目标
将 ClashNova 的服务模式升级到 clash-verge-rev 级别的可靠性，实现：
- 独立的服务进程
- IPC 进程间通信
- 状态机管理
- 自动恢复机制
- 版本检测与自动重装

## 当前架构 vs 目标架构

### ClashNova 当前架构 (v2.0.2)

```
┌─────────────────────────────────┐
│   ClashNova.exe                 │
│   (Tauri GUI + 服务双重身份)     │
│                                 │
│  ┌────────────────────────────┐ │
│  │  --service 参数?            │ │
│  │    ├─ Yes: 服务模式         │ │
│  │    │   └─> 拉起 mihomo.exe  │ │
│  │    └─ No: GUI 模式          │ │
│  │        └─> Sidecar 启动     │ │
│  └────────────────────────────┘ │
└─────────────────────────────────┘

优点:
+ 简单，单一可执行文件
+ 无需额外安装程序

缺点:
- GUI 和服务耦合
- 服务崩溃无法自动恢复
- 升级时必须停止服务
- 状态管理不清晰
```

### clash-verge-rev 架构

```
┌──────────────────────────────────┐
│  clash-verge.exe (Tauri GUI)     │
│                                  │
│  ┌─────────────────────────────┐ │
│  │  ServiceManager             │ │
│  │  ├─ 状态机管理              │ │
│  │  ├─ 版本检测                │ │
│  │  └─ IPC 客户端              │ │
│  └────────┬────────────────────┘ │
└───────────┼──────────────────────┘
            │ IPC (Named Pipe)
            │ \\.\pipe\clash-verge-service
            │
┌───────────▼──────────────────────┐
│  clash-verge-service.exe         │
│  (独立的 Windows 服务进程)        │
│                                  │
│  ┌─────────────────────────────┐ │
│  │  IPC 服务端                 │ │
│  │  ├─ start_clash()           │ │
│  │  ├─ stop_clash()            │ │
│  │  ├─ get_clash_logs()        │ │
│  │  └─ connect() 心跳检测      │ │
│  └────────┬────────────────────┘ │
│           │                      │
│  ┌────────▼────────────────────┐ │
│  │  内核管理器                 │ │
│  │  ├─ mihomo-alpha.exe 启动   │ │
│  │  ├─ 崩溃自动重启            │ │
│  │  └─ 日志收集                │ │
│  └─────────────────────────────┘ │
└──────────────────────────────────┘

安装/卸载:
├─ clash-verge-service-install.exe
│  └─> 注册 Windows 服务 (LocalSystem)
└─ clash-verge-service-uninstall.exe
   └─> 停止并删除服务
```

## 核心组件分析

### 1. IPC 通信层 (clash_verge_service_ipc)

**关键数据结构:**

```rust
// IPC 路径
pub const IPC_PATH: &str = r"\\.\pipe\clash-verge-service";

// 配置
pub struct IpcConfig {
    pub default_timeout: Duration,  // 150ms
    pub retry_delay: Duration,      // 250ms
    pub max_retries: usize,         // 20
}

// 内核配置
pub struct CoreConfig {
    pub config_path: String,        // mihomo 配置文件
    pub core_path: String,          // mihomo 可执行文件
    pub core_ipc_path: String,      // 外部控制器地址
    pub config_dir: String,         // 配置目录
}

// 日志配置
pub struct WriterConfig {
    pub log_file: String,
}

// 请求 payload
pub struct ClashConfig {
    pub core_config: CoreConfig,
    pub log_config: WriterConfig,
}

// 响应
pub struct Response<T> {
    pub code: i32,      // 0 = 成功, >0 = 错误
    pub message: String,
    pub data: Option<T>,
}
```

**API 接口:**

```rust
// 连接检测（心跳）
async fn connect() -> Result<()>

// 启动内核
async fn start_clash(config: &ClashConfig) -> Result<Response<()>>

// 停止内核
async fn stop_clash() -> Result<Response<()>>

// 获取日志
async fn get_clash_logs() -> Result<Response<Vec<CompactString>>>

// 更新日志配置
async fn update_writer(config: &WriterConfig) -> Result<Response<()>>

// 检查是否需要重装（版本不匹配）
async fn is_reinstall_service_needed() -> bool
```

### 2. 服务状态机

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceStatus {
    Ready,                          // 服务就绪
    NeedsReinstall,                 // 需要重装（版本不匹配）
    InstallRequired,                // 需要安装
    UninstallRequired,              // 需要卸载
    ReinstallRequired,              // 需要重装（用户请求）
    ForceReinstallRequired,         // 强制重装（修复）
    Unavailable(String),            // 不可用（附带原因）
}
```

**状态转换逻辑:**

```rust
pub struct ServiceManager {
    status: Mutex<ServiceStatus>,
    operation_running: AtomicBool,  // 防止并发操作
    operation_done: Notify,         // 操作完成通知
}

impl ServiceManager {
    async fn apply_service_status(&self, status: ServiceStatus) -> Result<()> {
        self.set_status(status.clone());
        match status {
            ServiceStatus::Ready => {
                // 直接使用服务
            }
            ServiceStatus::NeedsReinstall | ServiceStatus::ReinstallRequired => {
                // 1. 卸载旧服务
                run_service_command(uninstall_service, "uninstall")?;
                // 2. 安装新服务
                run_service_command(install_service, "install")?;
                // 3. 等待 IPC 就绪
                wait_for_service_ipc(self).await?;
            }
            ServiceStatus::InstallRequired => {
                // 1. 安装服务
                run_service_command(install_service, "install")?;
                // 2. 等待 IPC 就绪
                wait_for_service_ipc(self).await?;
                // 3. 检查版本
                if is_reinstall_service_needed().await {
                    self.apply_service_status(ServiceStatus::NeedsReinstall).await?;
                }
            }
            ServiceStatus::UninstallRequired => {
                run_service_command(uninstall_service, "uninstall")?;
                self.set_status(ServiceStatus::Unavailable("Service Uninstalled".into()));
            }
            ServiceStatus::Unavailable(reason) => {
                bail!("服务不可用: {}", reason);
            }
        }
        Ok(())
    }
}
```

### 3. 服务安装/卸载

**Windows 实现:**

```rust
// 安装服务
#[cfg(windows)]
fn install_service() -> Result<()> {
    use deelevate::{PrivilegeLevel, Token};
    use runas::Command as RunasCommand;
    
    let binary_path = dirs::service_path()?;
    let install_path = binary_path.with_file_name("clash-verge-service-install.exe");
    
    if !install_path.exists() {
        bail!("installer not found: {install_path:?}");
    }
    
    // 检查权限级别
    let token = Token::with_current_process()?;
    let level = token.privilege_level()?;
    
    let output = match level {
        PrivilegeLevel::NotPrivileged => {
            // 无权限 -> UAC 提权
            let status = RunasCommand::new(&install_path)
                .show(false)
                .status()?;
            Output { status, stdout: Vec::new(), stderr: Vec::new() }
        }
        _ => {
            // 已有管理员权限 -> 直接执行
            StdCommand::new(&install_path)
                .creation_flags(0x08000000)  // CREATE_NO_WINDOW
                .output()?
        }
    };
    
    if let Some((code, err)) = check_output_error(&output) {
        bail!("failed to install service code: {}, details: {}", code, err);
    }
    
    Ok(())
}

// 卸载服务
#[cfg(windows)]
fn uninstall_service() -> Result<()> {
    // 类似逻辑，调用 clash-verge-service-uninstall.exe
}
```

**关键点:**
1. **独立的安装程序** - 不是主程序自己注册服务
2. **权限检测** - 使用 `deelevate` crate 检测当前权限
3. **自动提权** - 无权限时通过 `runas` crate 触发 UAC
4. **隐藏窗口** - `creation_flags(0x08000000)` 避免控制台闪烁

### 4. 启动流程

```rust
pub(super) async fn run_core_by_service(config_file: &PathBuf) -> Result<()> {
    logging!(info, Type::Service, "正在尝试通过服务启动核心");
    
    // 1. 刷新服务状态
    SERVICE_MANAGER.refresh().await?;
    
    // 2. 检查版本
    if clash_verge_service_ipc::is_reinstall_service_needed().await {
        // 版本不匹配 -> 自动重装
        SERVICE_MANAGER.handle_service_status(ServiceStatus::NeedsReinstall).await?;
    }
    
    // 3. 启动内核
    start_with_existing_service(config_file).await
}

async fn start_with_existing_service(config_file: &PathBuf) -> Result<()> {
    // 1. 构造配置
    let payload = clash_verge_service_ipc::ClashConfig {
        core_config: CoreConfig {
            config_path: dirs::path_to_str(config_file)?.into(),
            core_path: dirs::path_to_str(&bin_path)?.into(),
            core_ipc_path: IClashTemp::guard_external_controller_ipc(),
            config_dir: dirs::path_to_str(&dirs::app_home_dir()?)?.into(),
        },
        log_config: Logger::global().service_writer_config()?,
    };
    
    // 2. 通过 IPC 发送启动命令
    let response = clash_verge_service_ipc::start_clash(&payload).await
        .context("无法连接到Clash Verge Service")?;
    
    // 3. 检查响应
    if response.code > 0 {
        bail!(response.message);
    }
    
    Ok(())
}
```

## ClashNova 升级方案

### 阶段 1: 当前版本 (v2.0.2) - 已完成 ✅

**特性:**
- 使用 `windows-service` crate 直接操作 Service Manager API
- 主程序双重身份（GUI / 服务）
- 自动启动服务（TUN 模式）
- 基本的状态检测

**限制:**
- 无 IPC，GUI 无法控制服务
- 无状态机，状态管理简单
- 无自动重装机制
- 升级时必须手动停止服务

### 阶段 2: IPC 通信层 (v2.1.0) - 计划中

**目标:**
实现 ClashNova 主程序与服务进程之间的 IPC 通信。

**实施步骤:**

1. **创建 `nova-service-ipc` crate**
   ```
   ClashNova-v2/
   ├── crates/
   │   └── nova-service-ipc/
   │       ├── Cargo.toml
   │       ├── src/
   │       │   ├── lib.rs
   │       │   ├── client.rs    # GUI 端
   │       │   ├── server.rs    # 服务端
   │       │   └── types.rs     # 共享类型
   ```

2. **定义 IPC 协议**
   ```rust
   // types.rs
   pub const IPC_PATH: &str = r"\\.\pipe\clashnova-service";
   
   pub struct IpcConfig {
       pub default_timeout: Duration,
       pub retry_delay: Duration,
       pub max_retries: usize,
   }
   
   pub struct CoreConfig {
       pub config_path: String,
       pub core_path: String,
       pub external_controller: String,
       pub config_dir: String,
   }
   
   pub struct ServiceRequest {
       pub command: String,  // "start", "stop", "status", "logs"
       pub data: Option<CoreConfig>,
   }
   
   pub struct ServiceResponse<T> {
       pub code: i32,
       pub message: String,
       pub data: Option<T>,
   }
   ```

3. **实现客户端 (GUI 端)**
   ```rust
   // client.rs
   use tokio::net::windows::named_pipe::ClientOptions;
   
   pub async fn connect() -> Result<()> {
       let client = ClientOptions::new()
           .open(IPC_PATH)?;
       // 发送心跳
       Ok(())
   }
   
   pub async fn start_core(config: &CoreConfig) -> Result<ServiceResponse<()>> {
       let client = ClientOptions::new().open(IPC_PATH)?;
       let request = ServiceRequest {
           command: "start".to_string(),
           data: Some(config.clone()),
       };
       // 发送请求，接收响应
       Ok(ServiceResponse { code: 0, message: "".into(), data: None })
   }
   
   pub async fn stop_core() -> Result<ServiceResponse<()>> {
       // 类似实现
   }
   ```

4. **实现服务端 (服务进程)**
   ```rust
   // server.rs
   use tokio::net::windows::named_pipe::ServerOptions;
   
   pub async fn start_ipc_server() -> Result<()> {
       let mut server = ServerOptions::new()
           .create(IPC_PATH)?;
       
       loop {
           server.connect().await?;
           
           // 处理请求
           let request: ServiceRequest = read_request(&mut server).await?;
           let response = match request.command.as_str() {
               "start" => handle_start(request.data).await,
               "stop" => handle_stop().await,
               "logs" => handle_logs().await,
               _ => ServiceResponse {
                   code: 1,
                   message: "Unknown command".into(),
                   data: None,
               },
           };
           
           write_response(&mut server, &response).await?;
       }
   }
   ```

5. **修改 main.rs**
   ```rust
   fn main() {
       if std::env::args().any(|a| a == "--service") {
           // 服务模式：启动 IPC 服务器
           tokio::runtime::Runtime::new()
               .unwrap()
               .block_on(async {
                   nova_service_ipc::server::start_ipc_server().await
               });
           return;
       }
       
       // GUI 模式：正常启动 Tauri
       tauri::Builder::default()
           .setup(|app| {
               // 初始化时检查服务连接
               Ok(())
           })
           .run(tauri::generate_context!())
           .expect("error while running tauri application");
   }
   ```

### 阶段 3: 状态机管理 (v2.2.0)

**目标:**
实现完整的服务状态机和自动管理。

**实施步骤:**

1. **定义 ServiceStatus 枚举**
   ```rust
   // service.rs
   #[derive(Debug, Clone, PartialEq, Eq)]
   pub enum ServiceStatus {
       Ready,
       NeedsReinstall,
       InstallRequired,
       UninstallRequired,
       ReinstallRequired,
       ForceReinstallRequired,
       Unavailable(String),
   }
   ```

2. **实现 ServiceManager**
   ```rust
   pub struct ServiceManager {
       status: Mutex<ServiceStatus>,
       operation_running: AtomicBool,
       operation_done: Notify,
   }
   
   impl ServiceManager {
       pub async fn refresh(&self) -> Result<()> {
           // 检测服务状态
           if nova_service_ipc::is_reinstall_needed().await {
               self.handle_service_status(ServiceStatus::NeedsReinstall).await?;
           } else {
               self.set_status(ServiceStatus::Ready);
           }
           Ok(())
       }
       
       pub async fn handle_service_status(&self, status: ServiceStatus) -> Result<()> {
           // 状态转换逻辑
       }
   }
   ```

3. **版本检测**
   ```rust
   // 在服务端嵌入版本号
   const SERVICE_VERSION: &str = env!("CARGO_PKG_VERSION");
   
   pub async fn is_reinstall_needed() -> bool {
       match nova_service_ipc::get_service_version().await {
           Ok(version) => version != SERVICE_VERSION,
           Err(_) => true,
       }
   }
   ```

### 阶段 4: 独立安装程序 (v2.3.0)

**目标:**
创建独立的服务安装/卸载程序。

**实施步骤:**

1. **创建 bin 目标**
   ```toml
   # Cargo.toml
   [[bin]]
   name = "clashnova-service-install"
   path = "src/bin/service_install.rs"
   
   [[bin]]
   name = "clashnova-service-uninstall"
   path = "src/bin/service_uninstall.rs"
   ```

2. **实现安装程序**
   ```rust
   // src/bin/service_install.rs
   use windows_service::{
       service::{ServiceAccess, ServiceInfo, ServiceStartType, ServiceType},
       service_manager::{ServiceManager, ServiceManagerAccess},
   };
   
   fn main() -> Result<(), Box<dyn std::error::Error>> {
       let exe_path = std::env::current_exe()?
           .parent()
           .unwrap()
           .join("ClashNova.exe");
       
       let service_info = ServiceInfo {
           name: OsString::from("clashnova-core"),
           display_name: OsString::from("ClashNova Core Service"),
           service_type: ServiceType::OWN_PROCESS,
           start_type: ServiceStartType::AutoStart,
           error_control: ServiceErrorControl::Normal,
           executable_path: exe_path,
           launch_arguments: vec![
               OsString::from("--service"),
           ],
           dependencies: vec![],
           account_name: None,  // LocalSystem
           account_password: None,
       };
       
       let manager = ServiceManager::local_computer(
           None::<&str>,
           ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
       )?;
       
       let service = manager.create_service(
           &service_info,
           ServiceAccess::CHANGE_CONFIG | ServiceAccess::START,
       )?;
       
       service.set_description("ClashNova 内核服务")?;
       service.start(&Vec::<&OsStr>::new())?;
       
       println!("Service installed successfully");
       Ok(())
   }
   ```

3. **修改构建配置**
   ```toml
   # tauri.conf.json
   {
     "tauri": {
       "bundle": {
         "resources": [
           "clashnova-service-install.exe",
           "clashnova-service-uninstall.exe"
         ]
       }
     }
   }
   ```

### 阶段 5: 自动恢复机制 (v2.4.0)

**目标:**
实现内核崩溃自动重启、服务健康检查。

**实施步骤:**

1. **内核进程监控**
   ```rust
   // 在服务进程中
   async fn monitor_core_process(mut child: Child) {
       loop {
           match child.try_wait() {
               Ok(Some(status)) => {
                   // 进程退出
                   log::warn!("Core process exited: {:?}", status);
                   tokio::time::sleep(Duration::from_secs(3)).await;
                   
                   // 自动重启
                   if let Err(e) = restart_core().await {
                       log::error!("Failed to restart core: {}", e);
                   }
               }
               Ok(None) => {
                   // 仍在运行
                   tokio::time::sleep(Duration::from_secs(5)).await;
               }
               Err(e) => {
                   log::error!("Failed to check core status: {}", e);
                   break;
               }
           }
       }
   }
   ```

2. **服务健康检查**
   ```rust
   // 在 GUI 端
   async fn health_check_loop() {
       let mut interval = tokio::time::interval(Duration::from_secs(10));
       loop {
           interval.tick().await;
           
           if let Err(e) = nova_service_ipc::connect().await {
               log::warn!("Service health check failed: {}", e);
               
               // 尝试重启服务
               if let Err(e) = service::start_or_elevate() {
                   log::error!("Failed to restart service: {}", e);
               }
           }
       }
   }
   ```

## 实施优先级

### P0 - 必须 (v2.1.0)
- ✅ IPC 通信层
- ✅ 基本的启动/停止命令

### P1 - 重要 (v2.2.0)
- ✅ 服务状态机
- ✅ 版本检测与自动重装
- ✅ 错误处理和日志

### P2 - 建议 (v2.3.0)
- ✅ 独立安装程序
- ✅ 更好的用户提示

### P3 - 可选 (v2.4.0)
- ✅ 自动恢复机制
- ✅ 健康检查
- ⭕ 服务日志查看器

## 测试计划

### 单元测试
- IPC 连接/断开
- 消息序列化/反序列化
- 状态机转换

### 集成测试
1. 服务安装测试
2. TUN 模式启动测试
3. 服务崩溃恢复测试
4. 版本升级测试
5. 并发操作测试

### 用户验收测试
1. 首次安装体验
2. TUN 模式启用体验
3. 异常场景处理（服务崩溃、网络断开）
4. 卸载体验

## 风险与缓解

### 风险1: IPC 复杂度
- **风险**: Named Pipe 在 Windows 上的实现细节复杂
- **缓解**: 参考 clash-verge-rev 实现，使用成熟的 tokio named_pipe API

### 风险2: 向后兼容
- **风险**: 升级后旧版本服务可能冲突
- **缓解**: 版本检测 + 自动卸载旧服务

### 风险3: 权限问题
- **风险**: UAC 提权可能被用户拒绝
- **缓解**: 清晰的错误提示 + 重试机制

## 时间估算

- **阶段 2 (IPC)**: 3-5 天
- **阶段 3 (状态机)**: 2-3 天
- **阶段 4 (安装程序)**: 1-2 天
- **阶段 5 (自动恢复)**: 2-3 天
- **测试与修复**: 3-5 天

**总计**: 11-18 天

## 参考资料

1. **clash-verge-rev 源码**
   - https://github.com/clash-verge-rev/clash-verge-rev
   - https://github.com/clash-verge-rev/clash-verge-service-ipc

2. **相关 crates**
   - `windows-service`: Windows 服务管理
   - `tokio::net::windows::named_pipe`: Named Pipe 异步 IO
   - `deelevate`: 权限检测
   - `runas`: UAC 提权

3. **Windows API 文档**
   - Service Control Manager
   - Named Pipes
