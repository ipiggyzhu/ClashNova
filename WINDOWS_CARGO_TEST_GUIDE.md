# Windows 环境 Cargo 测试完整指南

**当前状态**: ⚠️ 需要安装 MSVC 工具链

**错误信息**:
```
error: linker `link.exe` not found
note: the msvc targets depend on the msvc linker but `link.exe` was not found
note: please ensure that Visual Studio 2017 or later, or Build Tools for Visual Studio were installed with the Visual C++ option
```

---

## 🔧 安装 MSVC 工具链（必需）

### 方案 1: 安装 Visual Studio Build Tools（推荐）

**下载地址**: https://visualstudio.microsoft.com/zh-hans/downloads/

1. **下载 Build Tools for Visual Studio 2022**
   - 滚动到页面底部 "Tools for Visual Studio"
   - 点击 "Build Tools for Visual Studio 2022"
   
2. **运行安装程序**
   ```
   vs_BuildTools.exe
   ```

3. **选择工作负载**
   - ✅ 勾选 "使用 C++ 的桌面开发" (Desktop development with C++)
   - ✅ 在右侧确保勾选:
     - MSVC v143 - VS 2022 C++ x64/x86 生成工具
     - Windows 11 SDK (最新版本)
     - C++ CMake 工具

4. **安装**
   - 点击 "安装" 按钮
   - 等待安装完成（约 5-10 分钟）

5. **重启终端**
   ```powershell
   # 关闭当前 PowerShell
   # 重新打开 PowerShell
   ```

6. **验证安装**
   ```powershell
   # 检查 link.exe
   where link.exe
   
   # 应该输出类似：
   # C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.xx.xxxxx\bin\Hostx64\x64\link.exe
   ```

---

### 方案 2: 使用 Rustup 安装（备选）

如果不想安装完整的 Build Tools：

```powershell
# 安装 Visual Studio 2022 Redistributable
# 下载地址: https://aka.ms/vs/17/release/vc_redist.x64.exe
```

---

## ✅ 完整测试流程

### 步骤 1: 清理构建缓存

```powershell
cd D:\code\ClashNova-v2
cargo clean
```

### 步骤 2: 检查依赖

```powershell
cargo check
```

**预期输出**:
```
   Checking nova-service-ipc v0.1.0
   Checking nova-core v2.0.0
   Checking clashnova v2.4.0
    Finished dev [unoptimized + debuginfo] target(s) in XXs
```

### 步骤 3: 编译 Release 版本

```powershell
cargo build --release
```

**预期输出**:
```
   Compiling clashnova v2.4.0
    Finished release [optimized] target(s) in XXXs
```

### 步骤 4: 检查生成的文件

```powershell
# 主程序
ls target\release\clashnova.exe

# 服务安装程序
ls target\release\clashnova-service-install.exe

# 服务卸载程序
ls target\release\clashnova-service-uninstall.exe
```

---

## 🧪 功能测试清单

### 测试 1: TUN 模式安装（管理员权限）

```powershell
# 以管理员身份运行 PowerShell

cd D:\code\ClashNova-v2

# 1. 安装服务
.\target\release\clashnova-service-install.exe --dir "C:\Users\$env:USERNAME\AppData\Roaming\io.clashnova.app"

# 预期：弹出 UAC 提示，显示 "ClashNova" 而非 "PowerShell"

# 2. 检查服务状态
sc query clashnova-core

# 预期：
# STATE: RUNNING

# 3. 检查命名管道
Get-ChildItem \\.\pipe\ | Where-Object { $_.Name -eq "clashnova-service" }

# 预期：
# clashnova-service

# 4. 测试 IPC 连接
.\deep-diagnose.ps1

# 预期：
# [OK] IPC connection successful
```

### 测试 2: TUN 模式切换（普通用户）

```powershell
# 以普通用户身份运行 PowerShell

cd D:\code\ClashNova-v2

# 1. 启动 GUI
.\target\release\clashnova.exe

# 2. 在 GUI 中：
#    - 导航到 "设置" -> "TUN 模式"
#    - 点击开关切换 TUN 模式
#    - 观察是否有权限错误

# 预期：
# - 无 "权限不足" 错误
# - 无 "IPC 调用失败" 错误
# - TUN 模式成功开启/关闭
```

### 测试 3: Logo 显示

```powershell
# 在 GUI 运行时检查：

# 1. 任务栏图标
#    - 应显示用户品牌 logo（image-1.png）

# 2. 窗口标题栏
#    - 应显示 logo

# 3. 系统托盘
#    - 应显示 logo

# 预期：
# - 所有位置的 logo 都是用户提供的 image-1.png
# - 不是默认的 "N" 字母图标
```

### 测试 4: 路由地图显示

```powershell
# 在 GUI 中：

# 1. 导航到 "路由地图" 页面

# 2. 检查 3D 地球模式：
#    - 本机 → 目标地区之间应有金色弧线
#    - 弧线中点应有 ✈️ emoji

# 3. 切换到 2D 平面模式：
#    - 本机 → 目标地区之间应有连接线
#    - 连接线中点应有旋转的飞机 SVG 图标
#    - 飞机应指向目标方向

# 预期：
# - ✅ 连接线显示正常
# - ✅ 飞机图标显示正常
# - ✅ 飞机方向正确（出口 → 入口）
```

---

## 📊 测试结果记录表

### 编译测试

| 测试项 | 命令 | 状态 | 备注 |
|--------|------|------|------|
| 清理缓存 | `cargo clean` | ⏳ 待测试 | |
| 依赖检查 | `cargo check` | ⏳ 待测试 | |
| Release 编译 | `cargo build --release` | ⏳ 待测试 | |
| 文件生成 | `ls target\release\*.exe` | ⏳ 待测试 | |

### 功能测试

| 测试项 | 前置条件 | 状态 | 备注 |
|--------|----------|------|------|
| 服务安装 | 管理员 PowerShell | ⏳ 待测试 | |
| UAC 显示 | - | ⏳ 待测试 | 应显示 "ClashNova" |
| 服务状态 | - | ⏳ 待测试 | 应为 RUNNING |
| IPC 连接 | deep-diagnose.ps1 | ⏳ 待测试 | |
| TUN 开关 | 普通用户 GUI | ⏳ 待测试 | |
| 权限错误 | - | ⏳ 待测试 | 不应出现 |
| 任务栏 Logo | GUI 运行 | ⏳ 待测试 | |
| 窗口 Logo | GUI 运行 | ⏳ 待测试 | |
| 3D 弧线 | 路由地图页面 | ⏳ 待测试 | |
| 3D 飞机 | 路由地图页面 | ⏳ 待测试 | |
| 2D 连接线 | 路由地图页面 | ⏳ 待测试 | |
| 2D 飞机 | 路由地图页面 | ⏳ 待测试 | |

---

## ⚠️ 常见问题

### Q1: 编译时提示 `link.exe` 不存在
**A**: 需要安装 Visual Studio Build Tools，参见上方安装指南

### Q2: UAC 提示显示 "PowerShell"
**A**: 说明使用的是旧版本，需要重新编译并确保使用 `runas` 库

### Q3: TUN 模式提示权限错误
**A**: 运行 `.\deep-diagnose.ps1` 检查 IPC 连接状态

### Q4: 路由地图没有飞机图标
**A**: 检查前端是否编译成功，运行 `npm run build`

---

## 📝 测试完成后

完成所有测试后，请将结果填入上方的"测试结果记录表"，并更新：

1. **GOAL_ACHIEVEMENT_REPORT.md**
   - 将 "Cargo 测试 ⚠️ 50%" 更新为 "Cargo 测试 ✅ 100%"
   - 将所有 "⏳ 待测试" 更新为实际结果

2. **FINAL_TEST_REPORT.md**
   - 添加 Windows 环境测试结果

3. **提交测试报告**
   ```powershell
   git add .
   git commit -m "test: Windows 环境完整测试通过

   测试环境:
   - Windows 11 [版本号]
   - MSVC [版本号]
   - Rust [版本号]
   
   测试结果:
   - ✅ Cargo 编译成功
   - ✅ TUN 模式安装/卸载
   - ✅ UAC 显示正确
   - ✅ IPC 连接正常
   - ✅ Logo 显示正确
   - ✅ 路由地图正常"
   
   git push origin main
   ```

---

## 🎯 完成目标

所有测试通过后，才算真正达成用户的完整要求：

- ✅ 多代理协作测试
- ✅ TUN 模式修复（参考 clash-verge-rev）
- ✅ Logo 修复
- ✅ 路由地图修复
- ✅ 多轮测试
- ✅ **Cargo 测试（Windows 环境编译 + 功能验证）** ← 当前缺失

**当前进度**: 95% → 目标 100%

---

**文档生成时间**: 2026-06-17  
**下一步**: 安装 MSVC 工具链，然后按照本指南完成测试
