# 服务状态机实现完成 (v2.2.0)

## ✅ 已完成

### 1. ServiceManager 核心实现

**文件**: `src-tauri/src/service_manager.rs`

**服务状态枚举**:
```rust
pub enum ServiceStatus {
    Ready,                      // 服务就绪
    NeedsReinstall,             // 需要重装（版本不匹配）
    InstallRequired,            // 需要安装
    UninstallRequired,          // 需要卸载
    ReinstallRequired,          // 需要重装（用户请求）
    ForceReinstallRequired,     // 强制重装（修复）
    Unavailable(String),        // 不可用（附带原因）
}
```

**核心功能**:
- ✅ 状态管理（Arc<Mutex<ServiceStatus>>）
- ✅ 并发控制（AtomicBool + Notify）
- ✅ IPC 连接检测与重试
- ✅ 版本检测（自动触发重装）
- ✅ 完整状态机转换逻辑

### 2. 状态机转换逻辑

**状态转换流程**:

```
InstallRequired
    ↓
  安装服务
    ↓
  等待 IPC 就绪
    ↓
  检查版本 → 不匹配？
    ↓            ↓ Yes
   Ready     NeedsReinstall
                ↓
            ReinstallRequired
                ↓
              卸载旧服务
                ↓
              安装新服务
                ↓
             等待 IPC
                ↓
              Ready
```

**关键特性**:
1. **原子操作锁**: 防止并发状态转换
2. **重试机制**: IPC 连接失败自动重试（20次，250ms间隔）
3. **自动恢复**: 版本不匹配自动触发重装
4. **异步非阻塞**: 所有操作都是异步的

### 3. 命令集成

**更新的命令** (`commands.rs`):
- ✅ `service_status()` - 返回详细状态
- ✅ `install_service()` - 使用状态机安装
- ✅ `uninstall_service()` - 使用状态机卸载
- ✅ `reinstall_service()` - 新增：重装服务
- ✅ `repair_service()` - 新增：修复服务

**状态字符串映射**:
```rust
Ready → "ready"
NeedsReinstall → "needs-reinstall"
InstallRequired → "not-installed"
Unavailable(reason) → "unavailable:{reason}"
```

### 4. 应用启动集成

**main.rs setup**:
```rust
// 初始化服务管理器
let service_manager = service_manager::get_service_manager();
tauri::async_runtime::spawn(async move {
    if let Err(e) = service_manager.init().await {
        log::warn!("服务管理器初始化失败: {}", e);
    }
});
```

**初始化流程**:
1. 检查服务是否已安装
2. 检查服务是否正在运行
3. 测试 IPC 连接
4. 检查版本是否匹配
5. 设置初始状态

---

## 🔧 技术细节

### 并发控制

**问题**: 防止多个操作同时修改服务状态

**解决方案**:
```rust
operation_running: Arc<AtomicBool>  // 原子标志
operation_done: Arc<Notify>         // 等待通知

async fn run_operation<Fut>(&self, operation: Fut) -> Result<(), String> {
    // 尝试获取锁
    if self.operation_running.swap(true, Ordering::AcqRel) {
        return Err("已有操作正在进行".into());
    }
    
    // 执行操作
    let result = operation.await;
    
    // 释放锁并通知等待者
    self.operation_running.store(false, Ordering::Release);
    self.operation_done.notify_waiters();
    
    result
}
```

### IPC 连接等待

**问题**: 服务启动后 IPC 管道需要时间创建

**解决方案**:
```rust
async fn wait_for_ipc(&self, max_retries: usize, retry_delay: Duration) -> Result<(), String> {
    for i in 0..max_retries {
        if self.is_ipc_available().await {
            match nova_service_ipc::connect() {
                Ok(_) => return Ok(()),
                Err(e) => log::warn!("IPC 连接失败 ({}/{}): {}", i + 1, max_retries, e),
            }
        }
        
        if i < max_retries - 1 {
            tokio::time::sleep(retry_delay).await;
        }
    }
    
    Err(format!("等待 IPC 就绪超时（{}次重试）", max_retries))
}
```

### 版本检测与自动重装

**流程**:
1. 服务安装完成后，通过 IPC 获取服务版本
2. 比对服务版本与主程序版本
3. 不匹配则自动触发 `ReinstallRequired` 状态
4. 状态机执行：卸载旧服务 → 安装新服务

**代码**:
```rust
// IPC 客户端
pub fn is_reinstall_needed() -> bool {
    match get_version() {
        Ok(response) if response.code == 0 => {
            if let Some(version_info) = response.data {
                let current_version = env!("CARGO_PKG_VERSION");
                version_info.version != current_version
            } else {
                true
            }
        }
        _ => true,
    }
}

// 服务管理器
if nova_service_ipc::is_reinstall_needed() {
    self.set_status(ServiceStatus::NeedsReinstall).await;
    return self.apply_service_status(ServiceStatus::ReinstallRequired).await;
}
```

---

## 📊 与 clash-verge-rev 对比

| 特性 | clash-verge-rev | ClashNova v2.2.0 | 说明 |
|------|----------------|------------------|------|
| 服务状态枚举 | 7 种状态 | 7 种状态 | ✅ 完全对齐 |
| 状态机管理 | ✅ | ✅ | 完整实现 |
| 并发控制 | AtomicBool + Notify | AtomicBool + Notify | ✅ 相同设计 |
| IPC 重试 | 20 次，250ms | 20 次，250ms | ✅ 相同参数 |
| 版本检测 | ✅ | ✅ | 自动触发重装 |
| 独立安装程序 | ✅ | ❌ | 待实现（阶段 4） |
| 自动恢复 | ✅ | ❌ | 待实现（阶段 5） |

---

## 🧪 测试用例

### TC1: 首次安装服务
```
初始状态: InstallRequired
用户操作: 点击"安装服务"
预期结果:
  1. 状态变为 InstallRequired
  2. 执行安装
  3. 等待 IPC 就绪
  4. 检查版本（应匹配）
  5. 状态变为 Ready
```

### TC2: 版本升级
```
初始状态: Ready（旧版本服务）
用户操作: 启动新版本 GUI
预期结果:
  1. 初始化时检测到版本不匹配
  2. 状态变为 NeedsReinstall
  3. 后台自动重装（下次操作触发）
```

### TC3: 服务崩溃
```
初始状态: Ready
事件: 服务进程被杀死
用户操作: 调用任意需要服务的操作
预期结果:
  1. IPC 连接失败
  2. 状态变为 Unavailable("IPC 连接失败")
  3. 提示用户重新安装或修复
```

### TC4: 并发操作
```
初始状态: Ready
用户操作: 同时点击"重装服务"和"卸载服务"
预期结果:
  1. 第一个操作获得锁，开始执行
  2. 第二个操作返回错误"已有操作正在进行"
  3. 第一个操作完成后，第二个可以重试
```

---

## 🚀 使用示例

### 前端调用

```typescript
// 获取服务状态
const status = await invoke<string>('service_status');

if (status === 'not-installed') {
  // 安装服务
  await invoke('install_service');
} else if (status === 'needs-reinstall') {
  // 自动重装
  await invoke('reinstall_service');
} else if (status.startsWith('unavailable:')) {
  const reason = status.split(':')[1];
  // 显示错误：服务不可用，原因：{reason}
  
  // 提供修复选项
  await invoke('repair_service');
}
```

### 后端调用

```rust
use crate::service_manager::{get_service_manager, ServiceStatus};

// 获取状态
let manager = get_service_manager();
let status = manager.current_status().await;

if status.is_ready() {
    // 服务就绪，可以使用
} else {
    // 处理异常状态
    manager.handle_service_status(ServiceStatus::InstallRequired).await?;
}
```

---

## 🐛 已知限制

1. **跨平台支持**: 当前仅支持 Windows
   - macOS/Linux 需要不同的服务管理机制
   - 已在代码中添加 `#[cfg(windows)]` 标记

2. **权限提升**: 安装/卸载仍需要 UAC 提权
   - 阶段 4 将实现独立安装程序来优化体验

3. **IPC 超时**: 固定 20 次重试
   - 未来可以考虑配置化

4. **错误恢复**: 状态转换失败后无自动恢复
   - 需要用户手动重试或修复

---

## 📈 进度更新

| 阶段 | 状态 | 完成度 |
|------|------|--------|
| 阶段 1: 基础服务支持 (v2.0.2) | ✅ 完成 | 100% |
| 阶段 2: IPC 通信层 (v2.1.0) | ✅ 完成 | 100% |
| **阶段 3: 服务状态机 (v2.2.0)** | ✅ **完成** | **100%** |
| 阶段 4: 独立安装程序 (v2.3.0) | ⏳ 待开始 | 0% |
| 阶段 5: 自动恢复机制 (v2.4.0) | ⏳ 待开始 | 0% |

**总进度**: 60% ✅

---

## 🎯 下一步：阶段 4（独立安装程序）

**目标**: 创建独立的服务安装/卸载可执行文件

**任务**:
1. 创建 `src/bin/service_install.rs`
2. 创建 `src/bin/service_uninstall.rs`
3. 实现权限检测（deelevate crate）
4. 实现 UAC 提权（runas crate）
5. 修改构建配置（打包这两个可执行文件）

**优势**:
- 更清晰的权限边界
- 更好的错误处理
- 与 clash-verge-rev 架构完全对齐

**预计时间**: 1-2 天
