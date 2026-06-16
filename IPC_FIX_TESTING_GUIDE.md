# Windows 平台 IPC 修复测试指南

## 前提条件

- Windows 10/11 操作系统
- 管理员权限
- Rust 工具链（1.70+）
- Visual Studio Build Tools 或 MSVC

## 编译步骤

### 1. 打开 PowerShell（管理员模式）

```powershell
# 切换到项目目录
cd D:\code\ClashNova-v2

# 清理旧的构建缓存
cargo clean

# 构建 Release 版本
cargo build --release
```

### 2. 查找构建产物

```powershell
# 主程序
dir target\release\clashnova.exe

# 服务安装程序
dir target\release\service_install.exe

# 服务卸载程序
dir target\release\service_uninstall.exe
```

## 服务操作指南

### 卸载旧服务（如果已安装）

```powershell
# 方法 1: 使用 Windows 服务管理器
services.msc
# 找到 "clashnova-core" 服务
# 右键 → 停止
# 右键 → 删除

# 方法 2: 使用命令行
sc.exe stop clashnova-core
sc.exe delete clashnova-core

# 方法 3: 使用卸载程序
.\target\release\service_uninstall.exe
```

### 安装新服务

```powershell
# 使用安装程序
.\target\release\service_install.exe

# 验证安装
sc.exe query clashnova-core
```

### 启动服务

```powershell
# 使用服务管理器
net start clashnova-core

# 或者使用 sc 命令
sc.exe start clashnova-core

# 检查服务状态
sc.exe query clashnova-core
```

## 测试 IPC 连接

### 测试 1: 命名管道是否存在

```powershell
# 检查命名管道
Get-ChildItem \\.\pipe\ | Where-Object { $_.Name -like "*clashnova*" }

# 预期输出类似:
# Name          : clashnova-service
# FullName      : \\.\pipe\clashnova-service
```

### 测试 2: 使用 GUI 切换 TUN 模式

1. 启动 ClashNova GUI
2. 进入设置页面
3. 找到 TUN 模式开关
4. 点击切换

**观察日志** (`%APPDATA%\ClashNova\logs\`):
```
✅ 成功日志:
[INFO] TUN 模式由服务 clashnova-core 托管，通过 IPC 启动
[INFO] 通过 IPC 启动内核
[INFO] 内核启动成功

❌ 失败日志（修复前）:
[ERROR] IPC 调用失败: 无法连接到服务（命名管道打开失败）
```

### 测试 3: 手动测试 IPC（使用 PowerShell）

创建测试脚本 `test-ipc.ps1`:

```powershell
# 连接到命名管道并发送 ping 请求
$pipeName = "\\.\pipe\clashnova-service"

try {
    # 打开管道
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", "clashnova-service", [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(5000) # 5 秒超时
    
    Write-Host "✅ 连接成功!" -ForegroundColor Green
    
    # 发送 ping 请求
    $writer = New-Object System.IO.StreamWriter($pipe)
    $reader = New-Object System.IO.StreamReader($pipe)
    
    $request = @{
        command = "ping"
        data = $null
    } | ConvertTo-Json -Compress
    
    $writer.WriteLine($request)
    $writer.Flush()
    
    # 读取响应
    $response = $reader.ReadLine()
    Write-Host "响应: $response" -ForegroundColor Cyan
    
    $pipe.Close()
} catch {
    Write-Host "❌ 连接失败: $_" -ForegroundColor Red
}
```

运行测试:
```powershell
.\test-ipc.ps1
```

预期输出:
```
✅ 连接成功!
响应: {"code":0,"message":"","data":{}}
```

## 调试技巧

### 1. 查看服务日志

```powershell
# 服务日志位置（根据你的配置）
type "C:\ProgramData\ClashNova\service.log"
# 或
type "%APPDATA%\ClashNova\logs\service.log"
```

### 2. 使用 Windows 事件查看器

```powershell
# 打开事件查看器
eventvwr.msc

# 导航到：
# Windows 日志 → 应用程序
# 筛选来源: clashnova-core
```

### 3. 监控命名管道

使用 Process Monitor（ProcMon）监控管道操作：

1. 下载 [Process Monitor](https://learn.microsoft.com/en-us/sysinternals/downloads/procmon)
2. 运行 ProcMon（管理员权限）
3. 添加过滤器：
   - `Process Name` is `clashnova.exe`
   - `Operation` begins with `CreateFile`
   - `Path` contains `pipe`
4. 观察管道创建/连接操作

### 4. 检查服务进程

```powershell
# 查看服务进程
Get-Process | Where-Object { $_.ProcessName -like "*clashnova*" -or $_.ProcessName -like "*mihomo*" }

# 查看服务进程详细信息
Get-WmiObject Win32_Service | Where-Object { $_.Name -eq "clashnova-core" } | Select-Object *

# 查看进程命令行
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "clashnova.exe" } | Select-Object CommandLine
```

## 常见问题排查

### 问题 1: "拒绝访问" 错误

**原因**: 权限不足

**解决方案**:
```powershell
# 确保以管理员身份运行
# 检查用户账户控制（UAC）设置
# 尝试重新安装服务
```

### 问题 2: "管道不存在" 错误

**原因**: 服务未启动

**解决方案**:
```powershell
# 检查服务状态
sc.exe query clashnova-core

# 启动服务
net start clashnova-core

# 检查服务是否能正常启动
```

### 问题 3: "连接超时" 错误

**原因**: 服务响应慢或卡死

**解决方案**:
```powershell
# 重启服务
net stop clashnova-core
net start clashnova-core

# 检查 CPU/内存占用
Get-Process -Name clashnova | Select-Object CPU, WorkingSet
```

### 问题 4: 服务无法启动

**原因**: 可执行文件损坏或缺失依赖

**解决方案**:
```powershell
# 检查服务配置
sc.exe qc clashnova-core

# 手动运行服务程序测试
# 注意: 需要管理员权限
.\target\release\clashnova.exe --service

# 查看依赖
dumpbin /dependents target\release\clashnova.exe
```

## 性能测试

### 并发连接测试

创建 `stress-test.ps1`:

```powershell
# 并发发送 10 个 ping 请求
$jobs = 1..10 | ForEach-Object {
    Start-Job -ScriptBlock {
        $pipeName = "\\.\pipe\clashnova-service"
        $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", "clashnova-service", [System.IO.Pipes.PipeDirection]::InOut)
        $pipe.Connect(5000)
        
        $writer = New-Object System.IO.StreamWriter($pipe)
        $reader = New-Object System.IO.StreamReader($pipe)
        
        $request = '{"command":"ping","data":null}'
        $writer.WriteLine($request)
        $writer.Flush()
        
        $response = $reader.ReadLine()
        $pipe.Close()
        
        return $response
    }
}

# 等待所有作业完成
$jobs | Wait-Job | Receive-Job

# 清理作业
$jobs | Remove-Job
```

**预期结果**: 所有 10 个请求都成功返回响应

### 延迟测试

```powershell
# 测量单次请求延迟
Measure-Command {
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", "clashnova-service", [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(5000)
    
    $writer = New-Object System.IO.StreamWriter($pipe)
    $reader = New-Object System.IO.StreamReader($pipe)
    
    $writer.WriteLine('{"command":"ping","data":null}')
    $writer.Flush()
    
    $reader.ReadLine() | Out-Null
    $pipe.Close()
}
```

**预期结果**: 延迟 < 100ms

## 测试检查清单

- [ ] 服务能正常安装
- [ ] 服务能正常启动
- [ ] 命名管道已创建
- [ ] GUI 能连接到服务
- [ ] TUN 模式切换无错误
- [ ] 内核能通过 IPC 启动
- [ ] 内核能通过 IPC 停止
- [ ] 日志显示正常
- [ ] 状态查询功能正常
- [ ] 版本查询功能正常
- [ ] 多个客户端能并发连接
- [ ] 服务重启后仍能正常工作
- [ ] 内核崩溃后能自动重启

## 回滚方案

如果新版本出现问题，回滚到旧版本：

```powershell
# 1. 停止并卸载新服务
net stop clashnova-core
sc.exe delete clashnova-core

# 2. 恢复旧版本文件
# （假设你备份了旧版本到 backup 目录）
Copy-Item backup\clashnova.exe target\release\ -Force

# 3. 重新安装服务
.\target\release\service_install.exe

# 4. 启动服务
net start clashnova-core
```

## 技术支持

如果遇到问题：

1. 收集日志文件
2. 使用 ProcMon 捕获管道操作
3. 记录错误信息和重现步骤
4. 在 GitHub Issues 中报告问题

## 附录: 命名管道工具

### PipeList (Sysinternals)

```powershell
# 下载并运行 PipeList
.\pipelist.exe

# 查找 clashnova 管道
.\pipelist.exe | Select-String clashnova
```

### Handle (Sysinternals)

```powershell
# 查看哪些进程打开了管道
.\handle.exe -a \\.\pipe\clashnova-service
```

这些工具可以从 [Sysinternals Suite](https://learn.microsoft.com/en-us/sysinternals/downloads/) 下载。
