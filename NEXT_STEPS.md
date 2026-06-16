# 🚀 IPC 修复 - 下一步操作指南

## ✅ 已完成

1. **代码修复** - 完成 IPC 服务端和客户端的重构
2. **文档编写** - 创建了 4 份详细文档
3. **Git 提交** - 创建了规范的 commit 记录
4. **远程推送** - 已推送到 GitHub (commit: b03d31c)

---

## 📋 在 Windows 环境下的操作步骤

### 1. 拉取最新代码

打开 PowerShell 或 Git Bash：

```bash
cd D:\code\ClashNova-v2
git pull origin main
```

### 2. 编译项目

在 PowerShell（**管理员模式**）中：

```powershell
# 清理旧的构建
cargo clean

# 编译 Release 版本
cargo build --release

# 检查编译产物
dir target\release\clashnova.exe
dir target\release\service_install.exe
dir target\release\service_uninstall.exe
```

预计编译时间：5-10 分钟（首次编译）

### 3. 备份当前版本（可选但推荐）

```powershell
# 创建备份目录
mkdir backup -ErrorAction SilentlyContinue

# 备份当前运行的程序
Copy-Item target\release\clashnova.exe backup\clashnova_backup.exe -Force

# 导出当前服务配置
sc.exe qc clashnova-core > backup\service_config.txt
```

### 4. 停止并卸载旧服务

```powershell
# 停止服务
net stop clashnova-core

# 卸载服务
sc.exe delete clashnova-core

# 或使用卸载程序
# .\target\release\service_uninstall.exe

# 验证卸载成功
sc.exe query clashnova-core
# 应该显示: "指定的服务不存在"
```

### 5. 安装新服务

```powershell
# 使用安装程序
.\target\release\service_install.exe

# 验证安装成功
sc.exe query clashnova-core
# 应该显示服务状态为 STOPPED

# 启动服务
net start clashnova-core

# 再次验证
sc.exe query clashnova-core
# 应该显示服务状态为 RUNNING
```

### 6. 测试 IPC 连接

#### 方法 A: 使用 GUI 测试

1. 启动 ClashNova GUI
2. 进入 **设置** 页面
3. 找到 **TUN 模式** 开关
4. 点击切换开关

**观察结果**:
- ✅ **成功**: 开关切换成功，无错误提示
- ❌ **失败**: 显示错误消息

#### 方法 B: 查看日志

```powershell
# 查看应用日志
type "%APPDATA%\ClashNova\logs\app.log" | Select-String "IPC"

# 查看服务日志（如果有）
type "C:\ProgramData\ClashNova\service.log" | Select-String "IPC"
```

**成功的日志示例**:
```
[INFO] TUN 模式由服务 clashnova-core 托管，通过 IPC 启动
[INFO] 通过 IPC 启动内核
[INFO] 内核启动成功
```

**失败的日志示例**:
```
[ERROR] IPC 调用失败: 无法连接到服务（命名管道打开失败）
```

#### 方法 C: 使用 PowerShell 脚本测试

创建 `test-ipc-connection.ps1`:

```powershell
$pipeName = "\\.\pipe\clashnova-service"

Write-Host "正在测试 IPC 连接..." -ForegroundColor Yellow

try {
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", "clashnova-service", [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(5000)
    
    Write-Host "✅ IPC 连接成功!" -ForegroundColor Green
    
    $writer = New-Object System.IO.StreamWriter($pipe)
    $reader = New-Object System.IO.StreamReader($pipe)
    
    $request = '{"command":"ping","data":null}'
    $writer.WriteLine($request)
    $writer.Flush()
    
    $response = $reader.ReadLine()
    Write-Host "服务响应: $response" -ForegroundColor Cyan
    
    $pipe.Close()
    
    Write-Host "✅ 测试通过！" -ForegroundColor Green
} catch {
    Write-Host "❌ IPC 连接失败: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "故障排查步骤:" -ForegroundColor Yellow
    Write-Host "1. 检查服务是否运行: sc.exe query clashnova-core"
    Write-Host "2. 检查命名管道是否存在: Get-ChildItem \\.\pipe\ | Where-Object { `$_.Name -like '*clashnova*' }"
    Write-Host "3. 查看服务日志"
}
```

运行测试:
```powershell
.\test-ipc-connection.ps1
```

### 7. 完整功能测试清单

完成以下测试项目：

#### 基础功能
- [ ] 服务能正常安装
- [ ] 服务能正常启动
- [ ] GUI 能正常启动

#### IPC 功能
- [ ] 命名管道已创建（检查 `\\.\pipe\clashnova-service`）
- [ ] GUI 能连接到服务
- [ ] TUN 模式能成功切换（开启）
- [ ] TUN 模式能成功切换（关闭）
- [ ] 日志中无 IPC 错误

#### 内核功能
- [ ] 内核能通过 IPC 启动
- [ ] 内核能通过 IPC 停止
- [ ] 状态查询功能正常
- [ ] 版本查询功能正常
- [ ] 日志获取功能正常

#### 稳定性测试
- [ ] 快速切换 TUN 模式 10 次，无崩溃
- [ ] 服务重启后仍能正常工作
- [ ] GUI 重启后仍能连接服务

#### 网络功能
- [ ] TUN 模式下网络连接正常
- [ ] 代理功能正常工作
- [ ] DNS 解析正常

---

## 🐛 故障排查

### 问题 1: 编译失败

**症状**: `cargo build --release` 失败

**解决方案**:
```powershell
# 更新 Rust 工具链
rustup update

# 清理并重新编译
cargo clean
cargo build --release
```

### 问题 2: 服务无法启动

**症状**: `net start clashnova-core` 失败

**诊断步骤**:
```powershell
# 查看服务状态
sc.exe query clashnova-core

# 查看服务配置
sc.exe qc clashnova-core

# 查看 Windows 事件日志
eventvwr.msc
# 导航到：Windows 日志 → 应用程序
```

**常见原因**:
- 可执行文件路径错误
- 权限不足
- 端口被占用

### 问题 3: IPC 连接失败

**症状**: GUI 显示 "IPC 调用失败"

**诊断步骤**:
```powershell
# 1. 检查服务是否运行
sc.exe query clashnova-core

# 2. 检查命名管道是否存在
Get-ChildItem \\.\pipe\ | Where-Object { $_.Name -like "*clashnova*" }

# 3. 检查防火墙/杀毒软件
# 确保 clashnova.exe 没有被阻止

# 4. 重启服务
net stop clashnova-core
net start clashnova-core
```

### 问题 4: TUN 模式无法开启

**症状**: 切换 TUN 开关无效

**诊断步骤**:
```powershell
# 检查 TUN 驱动
Get-NetAdapter | Where-Object { $_.InterfaceDescription -like "*tun*" }

# 检查路由表
route print

# 查看日志
type "%APPDATA%\ClashNova\logs\app.log"
```

---

## 📊 性能验证

在完成功能测试后，验证性能指标：

| 指标 | 目标值 | 实际值 | 状态 |
|------|--------|--------|------|
| IPC 连接延迟 | < 100ms | ___ ms | ⬜ |
| 内核启动时间 | < 2s | ___ s | ⬜ |
| TUN 切换时间 | < 3s | ___ s | ⬜ |
| 内存占用 | < 100MB | ___ MB | ⬜ |
| CPU 空闲占用 | < 5% | ___ % | ⬜ |

---

## 🔄 回滚方案

如果新版本出现严重问题：

```powershell
# 1. 停止服务
net stop clashnova-core

# 2. 卸载服务
sc.exe delete clashnova-core

# 3. 恢复备份
Copy-Item backup\clashnova_backup.exe target\release\clashnova.exe -Force

# 4. 重新安装服务
.\target\release\service_install.exe

# 5. 启动服务
net start clashnova-core

# 6. 回滚 Git 代码（可选）
git revert HEAD
git push origin main
```

---

## 📝 测试报告模板

完成测试后，填写以下报告：

```markdown
# ClashNova IPC 修复测试报告

**测试日期**: YYYY-MM-DD
**测试环境**: Windows 10/11 版本号
**测试人员**: 

## 编译结果
- [ ] 编译成功
- [ ] 编译时间: ___ 分钟

## 服务安装
- [ ] 卸载旧服务成功
- [ ] 安装新服务成功
- [ ] 服务启动成功

## IPC 连接测试
- [ ] PowerShell 脚本测试通过
- [ ] GUI 能连接服务
- [ ] 日志中无错误

## TUN 模式测试
- [ ] TUN 开启成功
- [ ] TUN 关闭成功
- [ ] 快速切换 10 次无问题
- [ ] 网络连接正常

## 性能指标
- IPC 延迟: ___ ms
- 内核启动: ___ s
- 内存占用: ___ MB
- CPU 占用: ___ %

## 问题记录
（如有问题请详细描述）

## 结论
- [ ] ✅ 测试通过，可以发布
- [ ] ⚠️ 测试通过，但有小问题
- [ ] ❌ 测试失败，需要回滚
```

---

## 🎯 成功标准

当以下所有条件满足时，修复被认为成功：

1. ✅ 编译无错误
2. ✅ 服务能正常安装和启动
3. ✅ TUN 模式能正常切换
4. ✅ 日志中无 "IPC 调用失败" 错误
5. ✅ 网络功能正常
6. ✅ 性能指标达标
7. ✅ 稳定性测试通过

---

## 📞 技术支持

如果遇到问题：

1. **查看文档**:
   - `README_IPC_FIX.md` - 快速概览
   - `IPC_FIX_SUMMARY.md` - 技术细节
   - `IPC_FIX_TESTING_GUIDE.md` - 详细测试指南

2. **收集信息**:
   - 错误截图
   - 日志文件
   - 系统信息（Windows 版本、Rust 版本等）

3. **在 GitHub 创建 Issue**:
   - 标题：`[IPC] 具体问题描述`
   - 标签：`bug`, `ipc`
   - 附上收集的信息

---

## 🎊 测试完成后

测试成功后：

1. 更新 `README_IPC_FIX.md`，将测试状态改为 ✅
2. 在 GitHub 仓库创建一个 Release（如果需要）
3. 更新项目文档，说明 IPC 问题已修复
4. 通知用户升级到新版本

---

**祝测试顺利！** 🚀

如有任何问题，随时查阅相关文档或联系。
