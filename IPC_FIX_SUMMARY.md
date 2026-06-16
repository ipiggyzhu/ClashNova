# IPC 连接失败修复总结

## 问题描述
TUN 切换时出现错误：
```
IPC 调用失败: 无法连接到服务（命名管道打开失败）
```

## 根本原因

### 1. **命名管道创建标志错误**
**问题位置**: `crates/nova-service-ipc/src/server.rs:360`

**原代码**:
```rust
CreateNamedPipeW(
    PCWSTR(pipe_name.as_ptr()),
    PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,  // ❌ 错误
    ...
)
```

**问题**: `FILE_FLAG_FIRST_PIPE_INSTANCE` 标志限制了只能创建一个管道实例。当客户端尝试连接时，如果管道已经被占用，新的连接请求会失败。

**修复后**:
```rust
CreateNamedPipeW(
    PCWSTR(pipe_name.as_ptr()),
    PIPE_ACCESS_DUPLEX,  // ✅ 移除 FILE_FLAG_FIRST_PIPE_INSTANCE
    ...
)
```

### 2. **管道处理方式不当**
**问题**: 原实现在主线程中串行处理客户端请求，无法同时处理多个连接。

**修复**: 采用多线程模型
- 主线程循环创建新的命名管道实例并等待连接
- 每个客户端连接在独立线程中处理
- 处理完成后断开连接并清理资源

**新架构**:
```rust
loop {
    // 创建新管道实例
    let h_pipe = CreateNamedPipeW(...);
    
    // 等待客户端连接
    ConnectNamedPipe(h_pipe, None);
    
    // 在新线程中处理
    std::thread::spawn(move || {
        handle_client(h_pipe, core_manager);
        DisconnectNamedPipe(h_pipe);
        CloseHandle(h_pipe);
    });
}
```

### 3. **错误处理不完善**
**问题**: 客户端连接失败时缺少重试机制。

**修复**: 添加三次重试逻辑
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

### 4. **缺少超时设置**
**问题**: 管道读写操作没有超时，可能导致无限阻塞。

**修复**: 添加读写超时
```rust
pipe.set_read_timeout(Some(Duration::from_secs(5)))?;
pipe.set_write_timeout(Some(Duration::from_secs(5)))?;
```

### 5. **连接错误处理不当**
**问题**: `ConnectNamedPipe` 可能返回 `ERROR_PIPE_CONNECTED` (535) 错误码，表示客户端已连接，这不应被视为错误。

**修复**:
```rust
let connected = unsafe { ConnectNamedPipe(h_pipe, None) };
if let Err(e) = connected {
    let error_code = e.code().0;
    // ERROR_PIPE_CONNECTED (535) 表示客户端已经连接
    if error_code != 535 {
        log::warn!("客户端连接失败: {:?}", e);
        unsafe { CloseHandle(h_pipe).ok(); }
        continue;
    }
}
```

## 关键改进点

### 服务端 (server.rs)
1. ✅ 移除 `FILE_FLAG_FIRST_PIPE_INSTANCE` 标志
2. ✅ 实现多线程并发处理模型
3. ✅ 正确处理 `ERROR_PIPE_CONNECTED` 错误码
4. ✅ 添加详细的日志（debug 级别）
5. ✅ 正确管理句柄生命周期（避免重复关闭）

### 客户端 (client.rs)
1. ✅ 添加重试机制（最多 3 次）
2. ✅ 设置读写超时（5 秒）
3. ✅ 改进错误消息（区分管道不存在、权限不足等）
4. ✅ 移除未使用的 `Path` 导入

## 参考实现对比

| 特性 | 原实现 | clash-verge-rev | 修复后 |
|------|--------|-----------------|--------|
| 管道标志 | `PIPE_ACCESS_DUPLEX \| FILE_FLAG_FIRST_PIPE_INSTANCE` | `PIPE_ACCESS_DUPLEX` | ✅ `PIPE_ACCESS_DUPLEX` |
| 并发处理 | ❌ 串行 | ✅ 多线程 | ✅ 多线程 |
| 重试机制 | ❌ 无 | ✅ 有 | ✅ 3 次重试 |
| 超时设置 | ❌ 无 | ✅ 有 | ✅ 5 秒超时 |
| 错误码处理 | ❌ 基础 | ✅ 完善 | ✅ 处理 535 |

## 测试验证

### 1. 编译测试
```bash
cargo build --package nova-service-ipc --features client
cargo build --package nova-service-ipc --features server
```

### 2. 功能测试
1. 启动服务端（需要管理员权限）
2. 客户端发送 `ping` 请求
3. 客户端发送 `start` 请求启动内核
4. 客户端发送 `status` 请求查询状态
5. 客户端发送 `stop` 请求停止内核

### 3. 并发测试
同时从多个客户端发送请求，验证多线程处理能力。

## 部署步骤

1. **重新编译服务**
   ```bash
   cd /mnt/d/code/ClashNova-v2
   cargo build --release
   ```

2. **重装服务**（如果服务已安装）
   - 停止现有服务
   - 卸载服务
   - 安装新版本服务
   - 启动服务

3. **验证**
   - 在 GUI 中切换 TUN 模式
   - 检查日志确认无 IPC 错误
   - 验证网络连接正常

## 潜在问题

1. **管道权限**: 命名管道默认权限可能不允许低权限进程访问高权限服务
   - **解决方案**: 可能需要在 `CreateNamedPipeW` 中设置 `SECURITY_ATTRIBUTES`

2. **管道缓冲区大小**: 当前设置为 8192 字节
   - 如果传输大量日志，可能需要增加缓冲区大小

3. **线程泄漏**: 每个连接创建一个新线程
   - **优化方案**: 考虑使用线程池或异步 I/O（tokio）

## 后续优化建议

1. **使用 tokio 异步 I/O** 替代线程模型，提高性能
2. **实现连接池** 减少管道创建/销毁开销
3. **添加心跳机制** 检测服务端存活状态
4. **支持 Unix Domain Socket** 在 Linux/macOS 上提供类似功能
5. **添加单元测试** 覆盖各种错误场景

## 相关文件

- `crates/nova-service-ipc/src/server.rs` - 服务端实现
- `crates/nova-service-ipc/src/client.rs` - 客户端实现
- `crates/nova-service-ipc/src/types.rs` - 类型定义
- `src-tauri/src/core.rs` - 调用 IPC 启动内核
- `src-tauri/src/service_manager.rs` - 服务状态管理

## 参考资料

- [Windows Named Pipes 文档](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipes)
- [clash-verge-rev IPC 实现](https://github.com/clash-verge-rev/clash-verge-service-ipc)
- [Rust windows crate](https://microsoft.github.io/windows-docs-rs/)
