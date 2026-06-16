# ClashNova TUN 模式修复总结

## 问题诊断

原有实现使用 PowerShell 脚本执行 UAC 提权，存在以下问题：
1. PowerShell 依赖可能被安全策略禁用
2. 脚本注入风险（需要字符串转义）
3. 错误信息难以解析
4. 用户体验不够流畅

## 解决方案

参考 clash-verge-rev 的实现，使用 Rust 原生库：
- **deelevate 0.2**: 检测当前进程是否有管理员权限
- **runas 1.2**: 执行 UAC 提权，无需 PowerShell

## 代码改动

### 1. 依赖更新 (src-tauri/Cargo.toml)

```toml
[target.'cfg(windows)'.dependencies]
windows-service = "0.7"
runas = "1.2"
deelevate = "0.2"
```

### 2. 服务安装器改进 (src-tauri/src/service_installer.rs)

#### 权限检测函数

```rust
#[cfg(windows)]
fn is_elevated() -> bool {
    deelevate::token::is_elevated()
}
```

替代了原来的 `ServiceManager::local_computer` 试探性连接。

#### 提权执行函数

**安装服务**:
```rust
#[cfg(windows)]
async fn elevate_and_install(
    installer_path: &std::path::Path,
    config_dir: &std::path::Path,
) -> Result<(), String> {
    log::info!("使用 runas 库执行 UAC 提权");

    let installer_str = installer_path.to_string_lossy().to_string();
    let config_dir_str = config_dir.to_string_lossy().to_string();

    let status = tokio::task::spawn_blocking(move || {
        runas::Command::new(&installer_str)
            .arg("--dir")
            .arg(&config_dir_str)
            .status()
    })
    .await
    .map_err(|e| format!("提权任务失败: {}", e))?
    .map_err(|e| format!("执行 runas 失败: {}", e))?;

    if !status.success() {
        return Err(format!("提权安装失败，退出码: {:?}", status.code()));
    }

    log::info!("提权安装成功");
    Ok(())
}
```

**卸载服务**:
```rust
#[cfg(windows)]
async fn elevate_and_uninstall(uninstaller_path: &std::path::Path) -> Result<(), String> {
    log::info!("使用 runas 库执行 UAC 提权");

    let uninstaller_str = uninstaller_path.to_string_lossy().to_string();

    let status = tokio::task::spawn_blocking(move || {
        runas::Command::new(&uninstaller_str)
            .status()
    })
    .await
    .map_err(|e| format!("提权任务失败: {}", e))?
    .map_err(|e| format!("执行 runas 失败: {}", e))?;

    if !status.success() {
        return Err(format!("提权卸载失败，退出码: {:?}", status.code()));
    }

    log::info!("提权卸载成功");
    Ok(())
}
```

替代了原来的 PowerShell `Start-Process -Verb RunAs` 方式。

### 3. 命令层改进 (src-tauri/src/commands.rs)

同样使用 runas 库替代 PowerShell：

```rust
/// 使用 runas 库提权执行服务安装（通过重启自身并传递 --install-service 参数）
#[cfg(windows)]
async fn elevate_install_service(config_dir: &std::path::Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("定位自身失败: {e}"))?;
    let exe_str = exe.to_string_lossy().to_string();
    let config_dir_str = config_dir.to_string_lossy().to_string();

    let status = runas::Command::new(&exe_str)
        .arg("--install-service")
        .arg("--dir")
        .arg(&config_dir_str)
        .status()
        .map_err(|e| format!("执行 runas 失败: {e}"))?;

    if !status.success() {
        return Err(format!("提权失败，退出码: {:?}", status.code()));
    }

    Ok(())
}
```

## 优势对比

| 特性 | PowerShell 方案 | runas 库方案 |
|------|----------------|-------------|
| 依赖 | 需要 PowerShell | 无额外依赖 |
| 安全性 | 需要字符串转义，有注入风险 | 类型安全，无注入风险 |
| 可靠性 | 受策略影响 | Windows API 原生调用 |
| 错误处理 | 解析 stderr | 直接获取退出码 |
| 代码复杂度 | 高（字符串拼接） | 低（Builder 模式） |

## 测试建议

1. **基础功能测试**：
   - 在普通用户权限下启动 ClashNova
   - 尝试开启 TUN 模式
   - 确认 UAC 提示正常弹出
   - 确认服务安装成功

2. **权限场景测试**：
   - 已有管理员权限：直接安装，无 UAC 提示
   - 无管理员权限：弹出 UAC，授权后安装
   - 用户拒绝 UAC：返回友好错误信息

3. **服务管理测试**：
   - 安装服务后启动 TUN
   - 卸载服务
   - 重新安装服务

## 后续优化建议

1. 考虑使用 `deelevate::PrivilegeLevel` 进一步优化权限检测逻辑
2. 添加服务健康检查（心跳机制）
3. 优化错误提示的用户友好性
4. 考虑添加服务自动恢复机制

## 编译说明

由于在 WSL 环境中编译需要 dbus 依赖，建议：
- 在 Windows 环境中使用 `cargo build --release` 编译
- 或在 WSL 中安装 dbus 开发库：`sudo apt install libdbus-1-dev pkg-config`

## 参考资料

- [runas crate](https://crates.io/crates/runas)
- [deelevate crate](https://crates.io/crates/deelevate)
- [clash-verge-rev 实现](https://github.com/clash-verge-rev/clash-verge-rev)
