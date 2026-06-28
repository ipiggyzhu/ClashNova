# 独立服务安装程序实现完成 (v2.3.0)

## ✅ 已完成

### 1. 独立可执行文件

**服务安装程序**: `clashnova-service-install.exe`
- 独立的服务安装可执行文件
- 自动检测是否需要管理员权限
- 支持命令行参数：`--dir <配置目录>`
- 检查服务是否已存在并运行
- 自动启动服务并等待就绪

**服务卸载程序**: `clashnova-service-uninstall.exe`
- 独立的服务卸载可执行文件
- 自动停止服务（如果正在运行）
- 等待服务完全停止后删除
- 详细的日志输出

### 2. 服务安装器辅助模块

**文件**: `src-tauri/src/service_installer.rs`

**核心功能**:
- `install_with_installer()` - 调用独立安装程序
- `uninstall_with_installer()` - 调用独立卸载程序
- 自动权限检测（检查 ServiceManager 访问）
- PowerShell UAC 提权（需要时）
- 异步非阻塞执行

### 3. 集成到服务状态机

**修改**: `src-tauri/src/service_manager.rs`

所有服务操作现在都通过独立安装程序：
- `InstallRequired` → `install_with_installer()`
- `ReinstallRequired` → `uninstall_with_installer()` + `install_with_installer()`
- `UninstallRequired` → `uninstall_with_installer()`

### 4. 构建配置

**Cargo.toml**:
```toml
[[bin]]
name = "clashnova-service-install"
path = "src/bin/service_install.rs"

[[bin]]
name = "clashnova-service-uninstall"
path = "src/bin/service_uninstall.rs"
```

**tauri.conf.json**:
```json
"externalBin": [
  "binaries/mihomo",
  "binaries/clashnova-service-install",
  "binaries/clashnova-service-uninstall"
]
```

### 5. 构建脚本

**Windows**: `build-service-installers.bat`
```batch
cargo build --release --bin clashnova-service-install
cargo build --release --bin clashnova-service-uninstall
copy target\release\*.exe src-tauri\binaries\
```

**Linux/macOS**: `build-service-installers.sh`
```bash
cargo build --release --bin clashnova-service-install
cargo build --release --bin clashnova-service-uninstall
cp target/release/clashnova-service-* src-tauri/binaries/
```

---

## 🔧 技术细节

### 权限检测与提升

**检测流程**:
```rust
// 尝试连接到 ServiceManager
let manager_access = ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE;
if ServiceManager::local_computer(None::<&str>, manager_access).is_err() {
    // 需要提权
    elevate_and_install(installer_path, config_dir).await
} else {
    // 已有权限，直接执行
    Command::new(installer_path).output()
}
```

**PowerShell 提权**:
```powershell
Start-Process 'clashnova-service-install.exe' -ArgumentList '--dir','C:\Users\...' -Verb RunAs -Wait
```

### 独立安装程序逻辑

**安装流程**:
1. 解析 `--dir` 参数获取配置目录
2. 获取主程序路径（`clashnova.exe`）
3. 连接到 ServiceManager
4. 检查服务是否已存在
   - 已存在且运行 → 直接返回成功
   - 已存在但停止 → 启动服务
   - 不存在 → 创建新服务
5. 启动服务并等待运行状态（20次重试，250ms间隔）

**卸载流程**:
1. 连接到 ServiceManager
2. 打开服务
3. 查询服务状态
4. 如果正在运行，先停止服务
5. 等待服务停止（20次重试，250ms间隔）
6. 删除服务

### 与主程序的交互

**调用路径**:
```
用户点击"安装服务"
    ↓
commands::install_service()
    ↓
ServiceManager::handle_service_status(InstallRequired)
    ↓
ServiceManager::apply_service_status()
    ↓
service_installer::install_with_installer()
    ↓
[检查权限]
    ↓ 无权限
PowerShell UAC 提权
    ↓
clashnova-service-install.exe --dir <配置目录>
    ↓
[执行安装]
    ↓
返回结果
```

---

## 🆚 与 clash-verge-rev 对比

| 特性 | clash-verge-rev | ClashNova v2.3.0 | 说明 |
|------|----------------|------------------|------|
| 独立安装程序 | ✅ | ✅ | 完全实现 |
| 权限检测 | deelevate | windows-service | 不同库，功能相同 |
| UAC 提权 | runas | PowerShell | 不同方法，效果相同 |
| 服务等待 | 20 次，250ms | 20 次，250ms | ✅ 相同参数 |
| 错误处理 | ✅ | ✅ | 详细日志 |

---

## 📋 构建与打包

### 开发构建

```bash
# 构建服务安装程序
cd ClashNova-v2
./build-service-installers.bat  # Windows
./build-service-installers.sh   # Linux/macOS
```

### 生产构建

```bash
# 构建完整应用
npm run tauri build

# 输出包含：
# - ClashNova.exe (主程序)
# - clashnova-service-install.exe (服务安装程序)
# - clashnova-service-uninstall.exe (服务卸载程序)
# - mihomo.exe (内核)
```

### 目录结构

安装后：
```
C:\Program Files\ClashNova\
├── ClashNova.exe
├── clashnova-service-install.exe
├── clashnova-service-uninstall.exe
├── mihomo.exe
└── ...
```

---

## 🧪 测试用例

### TC1: 首次安装（无权限）
```
前提: 普通用户权限
操作: 点击"安装服务"
预期:
  1. 弹出 UAC 提示
  2. 用户确认后安装程序以管理员权限运行
  3. 服务安装成功
  4. 状态变为 Ready
```

### TC2: 首次安装（已有权限）
```
前提: 已有管理员权限
操作: 点击"安装服务"
预期:
  1. 无 UAC 提示
  2. 直接安装
  3. 服务安装成功
  4. 状态变为 Ready
```

### TC3: 重复安装（服务已存在）
```
前提: 服务已安装且运行
操作: 点击"安装服务"
预期:
  1. 检测到服务已存在
  2. 直接返回成功
  3. 无重复安装
```

### TC4: 卸载服务
```
前提: 服务已安装且运行
操作: 点击"卸载服务"
预期:
  1. 弹出 UAC 提示（如需）
  2. 停止服务
  3. 删除服务
  4. 状态变为 Unavailable
```

### TC5: 升级场景
```
前提: 旧版本服务正在运行
操作: 启动新版本 GUI
预期:
  1. 检测版本不匹配
  2. 自动卸载旧服务
  3. 安装新服务
  4. 状态变为 Ready
```

---

## 🐛 已知问题与解决方案

### 问题 1: UAC 被取消

**现象**: 用户取消 UAC 提示，安装失败

**解决方案**:
- 检测 PowerShell 返回码
- 显示友好错误："需要管理员权限才能安装服务"
- 提供重试按钮

### 问题 2: 安装程序路径找不到

**现象**: 主程序找不到 `clashnova-service-install.exe`

**原因**: 构建时未复制到 binaries 目录

**解决方案**:
- 运行 `build-service-installers.bat/sh`
- 确保 tauri.conf.json 中配置了 externalBin
- 检查打包后的目录结构

### 问题 3: 服务启动超时

**现象**: 安装后等待 IPC 超时

**原因**: 服务启动慢或 IPC 创建失败

**解决方案**:
- 增加重试次数（当前 20 次）
- 检查服务日志
- 手动重启服务

---

## 📈 进度更新

| 阶段 | 状态 | 完成度 |
|------|------|--------|
| 阶段 1: 基础服务支持 (v2.0.2) | ✅ 完成 | 100% |
| 阶段 2: IPC 通信层 (v2.1.0) | ✅ 完成 | 100% |
| 阶段 3: 服务状态机 (v2.2.0) | ✅ 完成 | 100% |
| **阶段 4: 独立安装程序 (v2.3.0)** | ✅ **完成** | **100%** |
| 阶段 5: 自动恢复机制 (v2.4.0) | ⏳ 待开始 | 0% |

**总进度**: 80% ✅

---

## 🎯 下一步：阶段 5（自动恢复机制）

**目标**: 实现内核崩溃自动重启、服务健康检查

**任务**:
1. 服务端：内核进程监控循环
2. 服务端：崩溃自动重启逻辑
3. 客户端：定期健康检查（心跳）
4. 客户端：检测失败自动修复
5. 日志收集与展示

**预计时间**: 2-3 天

---

## 🌟 架构优势

### 1. 清晰的权限边界

- 主程序：普通用户权限
- 安装程序：管理员权限（按需）
- 服务进程：LocalSystem 权限

### 2. 更好的错误处理

- 独立进程可以捕获完整错误
- 详细的日志输出
- 主程序不会因服务安装失败而崩溃

### 3. 易于调试

- 可以手动运行安装/卸载程序测试
- 独立的日志文件
- 不影响主程序开发

### 4. 用户体验优化

- UAC 提示更清晰（独立程序名）
- 安装/卸载可以脱离主程序运行
- 支持命令行脚本化部署

---

## 📚 使用示例

### 手动安装服务

```powershell
# 以管理员身份运行 PowerShell
cd "C:\Program Files\ClashNova"
.\clashnova-service-install.exe --dir "C:\Users\Username\AppData\Roaming\ClashNova"
```

### 手动卸载服务

```powershell
# 以管理员身份运行 PowerShell
cd "C:\Program Files\ClashNova"
.\clashnova-service-uninstall.exe
```

### 批量部署

```powershell
# 企业批量部署脚本
$appPath = "C:\Program Files\ClashNova"
$configDir = "$env:APPDATA\ClashNova"

# 静默安装服务
Start-Process "$appPath\clashnova-service-install.exe" `
    -ArgumentList "--dir", "$configDir" `
    -Verb RunAs `
    -Wait `
    -WindowStyle Hidden
```
