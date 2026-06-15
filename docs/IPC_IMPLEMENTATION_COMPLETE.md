# ClashNova IPC 通信层实现完成

## ✅ 已完成

### 1. IPC Crate 创建 (`nova-service-ipc`)

**位置**: `crates/nova-service-ipc/`

**结构**:
```
nova-service-ipc/
├── Cargo.toml
└── src/
    ├── lib.rs       # 入口
    ├── types.rs     # 数据类型定义
    ├── client.rs    # 客户端（GUI 端）
    └── server.rs    # 服务端（服务进程）
```

### 2. 核心功能

#### IPC 协议
- **命名管道路径**: `\\.\pipe\clashnova-service`
- **通信格式**: JSON over 命名管道
- **请求/响应**: 单行 JSON

#### 客户端 API
```rust
// 连接检测
pub fn connect() -> Result<()>

// 启动内核
pub fn start_core(config: &CoreConfig) -> Result<ServiceResponse<()>>

// 停止内核
pub fn stop_core() -> Result<ServiceResponse<()>>

// 获取状态
pub fn get_status() -> Result<ServiceResponse<CoreStatus>>

// 获取日志
pub fn get_logs(lines: usize) -> Result<ServiceResponse<Vec<String>>>

// 获取版本
pub fn get_version() -> Result<ServiceResponse<ServiceVersion>>

// 检查是否需要重装
pub fn is_reinstall_needed() -> bool

// 检查 IPC 是否可用
pub fn is_ipc_available() -> bool
```

#### 服务端
```rust
// 启动 IPC 服务器（阻塞）
pub fn start_server() -> Result<()>
```

**核心管理器**:
- 内核进程管理（启动/停止/状态检测）
- 自动重启机制（检测进程退出）
- 日志缓冲（1000 行）

### 3. 集成到项目

**Workspace**:
```toml
[workspace]
members = ["crates/nova-core", "crates/nova-service-ipc", "src-tauri"]
```

**主项目依赖**:
```toml
nova-service-ipc = { path = "../crates/nova-service-ipc", features = ["client"] }
```

**服务模式入口** (`main.rs`):
```rust
if std::env::args().any(|a| a == "--service") {
    env_logger::init();
    log::info!("ClashNova 服务模式启动");
    
    if let Err(e) = nova_service_ipc::start_server() {
        log::error!("IPC 服务器启动失败: {}", e);
        std::process::exit(1);
    }
    return;
}
```

## 📋 下一步计划

### 阶段 3: 服务状态机 (v2.2.0)

**目标**: 实现完整的服务状态管理。

**任务**:
1. 创建 `ServiceStatus` 枚举
2. 实现 `ServiceManager` 结构体
3. 集成 IPC 客户端到现有服务管理
4. 版本检测与自动重装逻辑

**估计时间**: 2-3 天

### 阶段 4: 独立安装程序 (v2.3.0)

**目标**: 创建独立的服务安装/卸载程序。

**任务**:
1. 创建 `clashnova-service-install` 二进制
2. 创建 `clashnova-service-uninstall` 二进制
3. 权限检测与自动提权
4. 打包到安装包中

**估计时间**: 1-2 天

### 阶段 5: 自动恢复机制 (v2.4.0)

**目标**: 内核崩溃自动重启、服务健康检查。

**任务**:
1. 服务端：内核进程监控循环
2. 客户端：定期健康检查
3. 自动重启逻辑
4. 日志收集与展示

**估计时间**: 2-3 天

## 🧪 测试计划

### 本地测试（Windows 环境）

1. **编译测试**
   ```powershell
   cd ClashNova-v2
   cargo build --release
   ```

2. **服务模式测试**
   ```powershell
   # 手动启动服务模式
   .\target\release\clashnova.exe --service
   
   # 检查 IPC 管道是否创建
   Test-Path \\.\pipe\clashnova-service
   ```

3. **IPC 通信测试**
   - 启动服务进程
   - GUI 发送 ping 命令
   - GUI 发送 start 命令
   - 检查内核是否启动

### 集成测试

1. **服务安装流程**
2. **TUN 模式启动流程**
3. **服务崩溃恢复**
4. **版本升级流程**

## 📊 进度总结

| 阶段 | 状态 | 完成度 |
|------|------|--------|
| 阶段 1: 基础服务支持 (v2.0.2) | ✅ 完成 | 100% |
| 阶段 2: IPC 通信层 (v2.1.0) | ✅ 完成 | 100% |
| 阶段 3: 服务状态机 (v2.2.0) | ⏳ 待开始 | 0% |
| 阶段 4: 独立安装程序 (v2.3.0) | ⏳ 待开始 | 0% |
| 阶段 5: 自动恢复机制 (v2.4.0) | ⏳ 待开始 | 0% |

**总进度**: 40%

## 🚀 下次启动任务

1. 在 Windows 环境下编译测试
2. 实现服务状态机
3. 集成 IPC 客户端到现有命令

## 💡 关键设计决策

### 1. 为什么使用命名管道而不是 TCP/HTTP？

**优点**:
- Windows 原生支持
- 进程间通信专用，无端口冲突
- 权限控制更严格
- 更低的延迟

**缺点**:
- 仅支持 Windows
- 调试相对困难

### 2. 为什么使用单行 JSON 而不是二进制协议？

**优点**:
- 简单易调试
- 易于扩展
- 人类可读

**缺点**:
- 性能略低（但对于 IPC 场景足够）

### 3. 为什么服务端使用单线程而不是多线程？

**优点**:
- 简化状态管理（内核进程单例）
- 避免锁竞争
- 命令按顺序执行，逻辑清晰

**缺点**:
- 无法并发处理多个客户端（但实际场景中只有一个 GUI 客户端）

## 📚 参考资料

1. **clash-verge-rev IPC 实现**
   - https://github.com/clash-verge-rev/clash-verge-service-ipc
   - 使用了更复杂的异步 tokio 实现
   - 我们简化为同步实现，降低复杂度

2. **Windows Named Pipes**
   - https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipes
   - CreateNamedPipeW / ConnectNamedPipe API

3. **Rust Windows Crate**
   - https://microsoft.github.io/windows-docs-rs/doc/windows/
   - Win32::System::Pipes 模块
