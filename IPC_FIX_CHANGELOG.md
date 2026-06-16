# IPC 修复变更清单

## 修改的文件

### 1. `crates/nova-service-ipc/src/server.rs`

#### 变更 A: 移除 FILE_FLAG_FIRST_PIPE_INSTANCE
**位置**: 第 9-16 行
```diff
 #[cfg(windows)]
-use windows::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
+use windows::Win32::Storage::FileSystem::{PIPE_ACCESS_DUPLEX};
```

#### 变更 B: 移除旧的 run() 方法实现
**位置**: 第 343-449 行
- 删除了串行处理的旧实现
- 替换为多线程并发处理模型

#### 变更 C: 新增 run() 方法（多线程版本）
**关键改进**:
1. 移除 `FILE_FLAG_FIRST_PIPE_INSTANCE` 标志
2. 处理 `ERROR_PIPE_CONNECTED` (535) 错误码
3. 每个连接在独立线程中处理
4. 添加详细的 debug 日志

```rust
pub fn run(&self) -> Result<()> {
    loop {
        let h_pipe = unsafe {
            CreateNamedPipeW(
                PCWSTR(pipe_name.as_ptr()),
                PIPE_ACCESS_DUPLEX, // 移除 FILE_FLAG_FIRST_PIPE_INSTANCE
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                PIPE_UNLIMITED_INSTANCES,
                8192, 8192, 0, None,
            )
        };
        
        // 等待并在新线程中处理
        let connected = unsafe { ConnectNamedPipe(h_pipe, None) };
        if let Err(e) = connected {
            let error_code = e.code().0;
            if error_code != 535 { // 处理 ERROR_PIPE_CONNECTED
                log::warn!("客户端连接失败: {:?}", e);
                continue;
            }
        }
        
        // 在新线程中处理客户端
        let core_manager = self.core_manager.clone();
        std::thread::spawn(move || {
            Self::handle_client(h_pipe, core_manager);
            unsafe {
                DisconnectNamedPipe(h_pipe).ok();
                CloseHandle(h_pipe).ok();
            }
        });
    }
}
```

#### 变更 D: 新增 handle_client() 静态方法
**功能**: 在独立线程中处理单个客户端请求

```rust
#[cfg(windows)]
fn handle_client(h_pipe: HANDLE, core_manager: Arc<Mutex<CoreManager>>) -> Result<()> {
    // 读取请求 → 处理 → 发送响应
    // 避免 File 析构函数关闭句柄（外部管理）
    std::mem::forget(pipe_file);
}
```

#### 变更 E: 新增 handle_request_static() 方法
**原因**: 静态方法可以在多线程中调用，替代原来的 `&self` 方法

#### 变更 F: 删除旧的 handle_request() 方法
- 因为新实现使用静态方法

#### 变更 G: 添加平台条件编译标记
```rust
#[cfg(windows)]
fn start_monitor_thread(&self) { ... }

#[cfg(windows)]
fn handle_request_static(...) { ... }
```

### 2. `crates/nova-service-ipc/src/client.rs`

#### 变更 A: 移除未使用的导入
```diff
-use std::path::Path;
```

#### 变更 B: 重写 send_request() - 添加重试机制
```rust
fn send_request(&self, request: &ServiceRequest) -> Result<Vec<u8>> {
    for attempt in 1..=3 {
        match self.try_send_request(request) {
            Ok(response) => return Ok(response),
            Err(e) => {
                if attempt < 3 {
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
    }
    Err(last_error.unwrap())
}
```

#### 变更 C: 新增 try_send_request() 方法
**关键改进**:
1. 添加读写超时（5 秒）
2. 改进错误消息（区分管道不存在、权限不足等）
3. 验证响应非空

```rust
fn try_send_request(&self, request: &ServiceRequest) -> Result<Vec<u8>> {
    let pipe = File::options()
        .read(true)
        .write(true)
        .open(IPC_PATH)?;
    
    // 设置超时
    pipe.set_read_timeout(Some(Duration::from_secs(5)))?;
    pipe.set_write_timeout(Some(Duration::from_secs(5)))?;
    
    // 发送请求并读取响应
    // ...
    
    if response_line.is_empty() {
        anyhow::bail!("服务返回空响应");
    }
}
```

## 测试场景

### 场景 1: 基本连接测试
1. 启动服务端
2. 客户端发送 `ping` 请求
3. **预期**: 收到成功响应

### 场景 2: TUN 模式切换
1. 在 GUI 中启用 TUN 模式
2. 观察日志
3. **预期**: 
   - 无 "IPC 调用失败" 错误
   - 日志显示 "内核启动成功"

### 场景 3: 并发连接
1. 同时从多个客户端发送请求
2. **预期**: 所有请求都能正常处理

### 场景 4: 服务崩溃恢复
1. 启动内核
2. 手动杀死 mihomo 进程
3. **预期**: 服务自动重启内核（监控线程）

## 回归测试清单

- [ ] TUN 模式开关正常工作
- [ ] 服务模式下内核启动/停止
- [ ] Sidecar 模式下内核启动/停止
- [ ] 服务安装/卸载
- [ ] 服务自动重启功能
- [ ] 日志获取功能
- [ ] 版本查询功能
- [ ] 状态查询功能

## 已知问题和后续优化

### 已知问题
1. **线程泄漏风险**: 每个连接创建新线程，高频连接可能导致线程过多
2. **管道权限**: 低权限进程可能无法访问高权限服务的管道
3. **缓冲区限制**: 8KB 缓冲区可能不足以传输大量日志

### 后续优化
1. **使用线程池**: 限制最大线程数
2. **异步 I/O**: 使用 tokio 替代线程模型
3. **连接池**: 复用管道连接
4. **添加单元测试**: 覆盖各种错误场景
5. **实现心跳机制**: 定期检测服务存活

## 部署检查清单

在 Windows 环境下：

- [ ] 编译通过：`cargo build --release`
- [ ] 停止现有服务（如果运行中）
- [ ] 卸载旧版本服务（如果已安装）
- [ ] 部署新的可执行文件
- [ ] 安装新版本服务
- [ ] 启动服务
- [ ] 测试 TUN 模式切换
- [ ] 检查日志确认无错误
- [ ] 验证网络连接正常

## 调试日志

启用详细日志以便调试：

**服务端**:
```rust
log::info!("启动 IPC 服务: {}", IPC_PATH);
log::debug!("等待客户端连接...");
log::debug!("客户端已连接");
log::debug!("收到命令: {}", request.command);
log::debug!("响应已发送");
```

**客户端**:
- 重试日志（隐式，通过错误信息体现）
- 连接失败时的详细错误消息

## 性能指标

| 指标 | 预期值 |
|------|--------|
| 单次请求延迟 | < 100ms |
| 并发连接数 | > 10 |
| 重试成功率 | > 95% |
| 服务可用性 | > 99% |

## 错误处理矩阵

| 错误类型 | 错误码 | 客户端行为 | 服务端行为 |
|----------|--------|-----------|-----------|
| 管道不存在 | NotFound | 返回 "服务未运行" | N/A |
| 权限不足 | PermissionDenied | 返回 "权限不足" | N/A |
| 连接超时 | TimedOut | 重试 3 次 | 继续等待新连接 |
| 读取失败 | IOError | 重试 3 次 | 记录日志并清理 |
| 空响应 | - | 返回 "服务返回空响应" | N/A |
| 解析失败 | - | 返回详细错误信息 | 返回错误响应 |

## 参考资料

- [Windows Named Pipes 最佳实践](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-server-using-overlapped-i-o)
- [Rust windows crate 文档](https://microsoft.github.io/windows-docs-rs/)
- [clash-verge-rev 源码](https://github.com/clash-verge-rev/clash-verge-rev)
