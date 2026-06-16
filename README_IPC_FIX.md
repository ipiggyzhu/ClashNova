# TUN 切换 IPC 连接失败问题修复

## 问题描述

在 ClashNova-v2 项目中，切换 TUN 模式时出现以下错误：
```
TUN 切换失败
IPC 调用失败: 无法连接到服务（命名管道打开失败）
```

## 根本原因

Windows 命名管道服务端实现存在致命错误：

1. **错误的管道创建标志**: 使用了 `FILE_FLAG_FIRST_PIPE_INSTANCE`，限制只能创建一个管道实例
2. **串行处理模型**: 主线程阻塞处理客户端请求，无法接受新连接
3. **缺少重试机制**: 客户端连接失败时直接报错，没有重试
4. **缺少超时设置**: 管道读写操作可能无限阻塞
5. **错误处理不完善**: 未正确处理 `ERROR_PIPE_CONNECTED` (535) 错误码

## 解决方案

参考 clash-verge-rev 的实现，对 IPC 模块进行了全面重构：

### 服务端改进 (server.rs)

✅ **移除 FILE_FLAG_FIRST_PIPE_INSTANCE**
```rust
// 修复前
PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE

// 修复后
PIPE_ACCESS_DUPLEX
```

✅ **实现多线程并发处理**
```rust
loop {
    let h_pipe = CreateNamedPipeW(...);
    ConnectNamedPipe(h_pipe, None);
    
    // 每个连接在独立线程中处理
    std::thread::spawn(move || {
        handle_client(h_pipe, core_manager);
        DisconnectNamedPipe(h_pipe);
        CloseHandle(h_pipe);
    });
}
```

✅ **正确处理错误码**
```rust
if let Err(e) = connected {
    let error_code = e.code().0;
    if error_code != 535 { // ERROR_PIPE_CONNECTED
        continue;
    }
}
```

### 客户端改进 (client.rs)

✅ **添加重试机制**
```rust
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
```

✅ **设置读写超时**
```rust
pipe.set_read_timeout(Some(Duration::from_secs(5)))?;
pipe.set_write_timeout(Some(Duration::from_secs(5)))?;
```

✅ **改进错误消息**
```rust
match e.kind() {
    ErrorKind::NotFound => "服务未运行（命名管道不存在）",
    ErrorKind::PermissionDenied => "权限不足，无法访问服务",
    _ => "无法连接到服务（命名管道打开失败）",
}
```

## 文件修改清单

| 文件 | 修改类型 | 行数变化 |
|------|---------|----------|
| `crates/nova-service-ipc/src/server.rs` | 重大重构 | +120 / -110 |
| `crates/nova-service-ipc/src/client.rs` | 重大重构 | +60 / -30 |

## 测试验证

### 编译测试
```bash
✅ cargo build --package nova-service-ipc --features client
✅ cargo build --package nova-service-ipc --features server
✅ cargo build --package nova-service-ipc --all-features
```

### 功能测试（需在 Windows 环境）

1. **基础连接测试**
   - 启动服务端
   - 客户端发送 ping 请求
   - 验证响应成功

2. **TUN 切换测试**
   - 在 GUI 中切换 TUN 模式
   - 验证无错误信息
   - 验证内核成功启动

3. **并发测试**
   - 同时从多个客户端发送请求
   - 验证所有请求都能处理

4. **压力测试**
   - 连续快速切换 TUN 模式
   - 验证服务稳定性

## 部署指南

### 在 Windows 环境下

1. **编译新版本**
   ```powershell
   cd D:\code\ClashNova-v2
   cargo build --release
   ```

2. **停止旧服务**
   ```powershell
   net stop clashnova-core
   sc.exe delete clashnova-core
   ```

3. **部署新文件**
   - 替换 `clashnova.exe`
   - 替换服务安装/卸载程序

4. **安装新服务**
   ```powershell
   .\target\release\service_install.exe
   net start clashnova-core
   ```

5. **测试验证**
   - 启动 GUI
   - 切换 TUN 模式
   - 检查日志

## 预期效果

### 修复前
```
❌ [ERROR] TUN 切换失败
❌ [ERROR] IPC 调用失败: 无法连接到服务（命名管道打开失败）
```

### 修复后
```
✅ [INFO] TUN 模式由服务 clashnova-core 托管，通过 IPC 启动
✅ [INFO] 通过 IPC 启动内核
✅ [INFO] 内核启动成功
✅ [INFO] TUN 模式已启用
```

## 性能指标

| 指标 | 目标值 | 说明 |
|------|--------|------|
| 连接延迟 | < 100ms | 单次 IPC 调用延迟 |
| 并发连接 | > 10 | 同时处理的客户端数 |
| 重试成功率 | > 95% | 3 次重试内成功率 |
| 服务可用性 | > 99% | 服务正常运行时间比例 |

## 相关文档

- **[IPC_FIX_SUMMARY.md](./IPC_FIX_SUMMARY.md)** - 技术细节和修复原理
- **[IPC_FIX_CHANGELOG.md](./IPC_FIX_CHANGELOG.md)** - 详细的变更记录
- **[IPC_FIX_TESTING_GUIDE.md](./IPC_FIX_TESTING_GUIDE.md)** - Windows 平台测试指南
- **[test_ipc_fix.sh](./test_ipc_fix.sh)** - 自动化测试脚本

## 技术参考

- [Windows Named Pipes 官方文档](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipes)
- [clash-verge-rev 参考实现](https://github.com/clash-verge-rev/clash-verge-rev)
- [Rust windows crate](https://microsoft.github.io/windows-docs-rs/)

## 后续优化建议

1. **使用 tokio 异步 I/O** - 替代线程模型，提高性能
2. **实现线程池** - 限制最大线程数，防止资源耗尽
3. **添加连接池** - 复用管道连接，减少创建开销
4. **实现心跳机制** - 定期检测服务存活状态
5. **添加单元测试** - 覆盖各种错误场景
6. **支持 Unix Domain Socket** - 在 Linux/macOS 上提供类似功能

## 贡献者

修复基于 clash-verge-rev 项目的优秀实现，感谢原作者的贡献。

## 许可证

遵循 ClashNova-v2 项目的许可证。

---

**状态**: ✅ 已修复，待 Windows 环境测试验证

**优先级**: 🔴 高（阻塞 TUN 功能）

**影响范围**: Windows 平台 TUN 模式

**测试状态**: 
- ✅ Linux 编译通过
- ⏳ Windows 功能测试待验证
- ⏳ 生产环境部署待确认
