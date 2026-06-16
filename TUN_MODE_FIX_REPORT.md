# ClashNova TUN 模式修复报告

## 执行日期
2026-06-16

## 修复目标
改进 ClashNova 的 TUN 模式服务安装机制，使用 Rust 原生库替代 PowerShell 脚本实现 UAC 提权。

## 问题分析

### 原有实现的问题
1. **PowerShell 依赖风险**
   - PowerShell 可能被企业安全策略禁用
   - 执行策略限制可能导致脚本无法运行

2. **安全隐患**
   - 使用字符串拼接构造 PowerShell 命令
   - 需要手动转义特殊字符（单引号替换为双单引号）
   - 存在命令注入风险

3. **错误处理困难**
   - 需要解析 PowerShell 的 stderr 输出
   - 错误信息不够精确
   - 难以区分不同的失败原因

4. **用户体验问题**
   - 提权流程不够流畅
   - 错误提示不够友好

## 解决方案

### 技术选型
参考 clash-verge-rev 的实现，使用以下 Rust 原生库：

| 库名 | 版本 | 功能 | 优势 |
|------|------|------|------|
| runas | 1.2.0 | UAC 提权执行 | 无需 PowerShell，直接调用 Windows API |
| deelevate | 0.2.0 | 权限检测 | 准确判断当前进程权限级别 |

### 实现细节

#### 1. 依赖更新
```toml
# src-tauri/Cargo.toml
[target.'cfg(windows)'.dependencies]
windows-service = "0.7"
runas = "1.2"      # 新增
deelevate = "0.2"  # 新增
```

#### 2. 权限检测改进
**之前**：尝试连接服务管理器，连接失败则认为需要提权
```rust
let manager_access = ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE;
if ServiceManager::local_computer(None::<&str>, manager_access).is_err() {
    // 需要提权
}
```

**现在**：直接检测进程权限级别
```rust
fn is_elevated() -> bool {
    deelevate::token::is_elevated()
}
```

#### 3. 提权执行改进
**之前**：使用 PowerShell Start-Process -Verb RunAs
```rust
let ps_cmd = format!(
    "Start-Process '{}' -ArgumentList '--dir','{}' -Verb RunAs -Wait",
    installer_str, config_dir_str
);
let output = Command::new("powershell.exe")
    .args(["-NoProfile", "-Command", &ps_cmd])
    .output()?;
```

**现在**：使用 runas::Command
```rust
let status = tokio::task::spawn_blocking(move || {
    runas::Command::new(&installer_str)
        .arg("--dir")
        .arg(&config_dir_str)
        .status()
})
.await??;
```

## 修改文件清单

### 1. src-tauri/Cargo.toml
- 添加 runas 1.2 依赖
- 添加 deelevate 0.2 依赖

### 2. src-tauri/src/service_installer.rs
- 新增 `is_elevated()` 函数：检测当前进程权限
- 修改 `elevate_and_install()`：使用 runas 库提权安装
- 修改 `elevate_and_uninstall()`：使用 runas 库提权卸载
- 删除 PowerShell 相关代码

### 3. src-tauri/src/commands.rs
- 修改 `elevate_install_service()`：使用 runas 库
- 修改 `elevate_uninstall_service()`：使用 runas 库
- 删除 PowerShell 字符串转义逻辑

## 技术优势对比

| 维度 | PowerShell 方案 | runas 库方案 | 改进 |
|------|----------------|-------------|------|
| **可靠性** | 依赖 PowerShell 可用性 | 直接调用 Windows API | ✅ 无外部依赖 |
| **安全性** | 字符串拼接，需手动转义 | 类型安全的 Builder API | ✅ 无注入风险 |
| **错误处理** | 解析 stderr 文本 | 直接获取退出码 | ✅ 更精确 |
| **代码复杂度** | ~30 行（含转义逻辑） | ~15 行 | ✅ 减少 50% |
| **用户体验** | UAC 弹窗显示 PowerShell | UAC 弹窗显示应用名称 | ✅ 更专业 |

## 测试建议

### 基础功能测试
1. **普通用户权限**
   - [ ] 启动 ClashNova
   - [ ] 点击"安装服务"
   - [ ] 确认 UAC 提示弹出
   - [ ] 点击"是"授权
   - [ ] 确认服务安装成功
   - [ ] 开启 TUN 模式
   - [ ] 确认网络正常

2. **管理员权限**
   - [ ] 以管理员身份运行 ClashNova
   - [ ] 点击"安装服务"
   - [ ] 确认无 UAC 提示（直接安装）
   - [ ] 确认服务安装成功

3. **权限拒绝**
   - [ ] 普通用户权限启动
   - [ ] 点击"安装服务"
   - [ ] 在 UAC 提示点击"否"
   - [ ] 确认显示友好错误信息

### 服务管理测试
1. **安装服务**
   - [ ] 服务未安装 → 安装成功
   - [ ] 服务已存在 → 检测并启动

2. **卸载服务**
   - [ ] 服务运行中 → 停止后卸载
   - [ ] 服务已停止 → 直接卸载

3. **重新安装服务**
   - [ ] 卸载后重新安装
   - [ ] 确认 TUN 模式正常

### 边界情况测试
1. **服务异常状态**
   - [ ] 服务安装但未运行
   - [ ] 服务注册损坏
   - [ ] 服务可执行文件缺失

2. **权限边界**
   - [ ] 标准用户
   - [ ] 受限用户
   - [ ] 企业域用户

## 编译说明

### Windows 环境（推荐）
```bash
cd D:\code\ClashNova-v2
cargo build --release
```

### WSL 环境
需要安装 dbus 开发库：
```bash
sudo apt install libdbus-1-dev pkg-config
cargo build --release
```

或使用 Windows 交叉编译：
```bash
cargo build --target x86_64-pc-windows-msvc --release
```

## 回滚方案

如果新实现出现问题，可以回滚到 PowerShell 方案：

```bash
git revert HEAD
cargo build --release
```

或手动修改：
1. 移除 Cargo.toml 中的 runas 和 deelevate 依赖
2. 恢复 service_installer.rs 和 commands.rs 的 PowerShell 代码

## 后续优化建议

1. **权限检测增强**
   - 使用 `deelevate::PrivilegeLevel` 获取更详细的权限信息
   - 区分 Administrator 和 SYSTEM 权限

2. **服务健康检查**
   - 实现服务心跳检测
   - 服务异常时自动重启

3. **错误提示优化**
   - 根据不同错误类型提供针对性提示
   - 添加常见问题解决方案链接

4. **日志增强**
   - 记录详细的权限检测日志
   - 记录 UAC 提权的完整流程

5. **自动修复**
   - 检测服务损坏时提示修复
   - 提供一键修复功能

## 参考资料

- [runas crate 文档](https://docs.rs/runas/1.2.0)
- [deelevate crate 文档](https://docs.rs/deelevate/0.2.0)
- [clash-verge-rev GitHub](https://github.com/clash-verge-rev/clash-verge-rev)
- [Windows UAC 最佳实践](https://docs.microsoft.com/windows/security/identity-protection/user-account-control/)

## 风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| 新库兼容性问题 | 低 | runas 和 deelevate 都是成熟库，被多个项目使用 |
| Windows 版本兼容性 | 低 | 支持 Windows 7+ |
| 编译失败 | 低 | 已在 Cargo.toml 中正确配置 |
| 运行时崩溃 | 低 | 使用 Result 类型进行错误处理 |

## 签署
- 修复人：Claude (Opus 4.8)
- 审核人：待审核
- 测试人：待测试
- 发布人：待发布

---

**状态：✅ 代码修改完成，等待编译测试**
