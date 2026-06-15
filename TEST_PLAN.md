# ClashNova TUN 模式测试计划

## 测试目标
验证 TUN 模式能否正常工作，以及服务模式的可靠性。

## 参考实现
已研究 clash-verge-rev 的架构：
- 使用独立的 IPC 服务库 (`clash_verge_service_ipc`)
- 服务管理器状态机 (`ServiceStatus` 枚举)
- 自动重装机制（版本不匹配时）

## 当前架构对比

### ClashNova (简化版)
```
┌─────────────┐
│ ClashNova   │ ──[--service]──> ┌───────────────┐
│  (主程序)    │                  │ Windows服务   │
│             │ <────────────────│ (同一可执行文件)│
└─────────────┘                  └───────────────┘
                                        │
                                        ├─> mihomo.exe
```

### clash-verge-rev (完整版)
```
┌─────────────────┐
│ clash-verge     │ ──[IPC]──> ┌─────────────────────┐
│ (主GUI程序)      │            │ Windows服务         │
│                 │            │ (独立安装程序管理)    │
└─────────────────┘            └─────────────────────┘
                                      │
                                      ├─> mihomo-alpha.exe
```

## 问题诊断

### 问题1: 服务安装按钮无反应 (已修复 v2.0.1)
- **根因**: PowerShell 命令引号嵌套问题
- **修复**: 改用 `windows-service` crate 直接操作 Service Manager API
- **状态**: ✅ 已修复

### 问题2: TUN 模式 "Access denied" (v2.0.2 待测试)
- **症状**: 服务已安装但 TUN 启动失败
- **可能原因**:
  1. 服务未自动启动
  2. 服务启动了但崩溃
  3. 权限配置问题

- **v2.0.2 改进**:
  - `apply_tun()` 自动检测并启动服务
  - 增加详细日志输出
  - 服务启动等待 1000ms 稳定期

## 测试步骤

### 前置条件
1. ⚠️ **先停止当前运行的服务进程** (否则无法安装新版本)
   ```powershell
   # 方法1: 服务管理器
   services.msc → 找到 clashnova-core → 右键停止
   
   # 方法2: 命令行 (需管理员)
   sc stop clashnova-core
   
   # 方法3: 重启电脑
   ```

2. 安装 v2.0.2 (CI 构建完成后)

### 测试用例

#### TC1: 服务安装测试
1. 打开设置 → 服务模式
2. 点击"安装服务"按钮
3. **预期**: UAC 弹窗 → 授权 → 显示"服务已安装"

#### TC2: TUN 模式启用测试
1. 确保服务已安装
2. 打开设置 → 启用 TUN 模式
3. **预期**: 
   - 服务自动启动
   - TUN 模式正常工作
   - 无 "Access denied" 错误

#### TC3: 服务状态查看
1. Windows + R → `services.msc`
2. 找到 "ClashNova Core Service"
3. **检查**:
   - 启动类型: 自动
   - 状态: 正在运行
   - 登录身份: Local System

#### TC4: 日志检查
1. 查看日志文件:
   ```
   %AppData%\ClashNova\logs\
   ```
2. **搜索关键词**: TUN, service, Access, denied
3. **预期**: 无错误日志

#### TC5: 网络连通性测试
1. TUN 模式启用后
2. 命令行测试:
   ```bash
   curl -v https://www.google.com
   ```
3. **预期**: 请求成功通过代理

## 已知限制

1. **服务模式仅支持 Windows**
   - Linux/macOS 需要 root 权限直接运行

2. **安装/卸载需要管理员权限**
   - UAC 弹窗无法避免

3. **服务进程独立运行**
   - 关闭 GUI 后服务仍运行
   - 需手动卸载服务

## 如果测试失败

### 收集诊断信息
```bash
# 1. 服务状态
sc query clashnova-core

# 2. 服务配置
sc qc clashnova-core

# 3. 最近的服务事件
Get-EventLog -LogName Application -Source "clashnova-core" -Newest 10

# 4. 进程列表
Get-Process | Where-Object {$_.ProcessName -like "*clash*" -or $_.ProcessName -like "*mihomo*"}
```

### 日志位置
- **主程序日志**: `%AppData%\ClashNova\logs\`
- **服务日志**: Windows 事件查看器 → 应用程序日志

## 下一步改进方向 (如需要)

如果 v2.0.2 仍有问题，可以考虑：

1. **采用 clash-verge-rev 的 IPC 架构**
   - 独立的服务安装程序
   - 通过 Named Pipe 通信
   - 版本自动检测和重装

2. **增加服务健康检查**
   - 定期 ping 服务
   - 自动恢复机制

3. **改进错误提示**
   - UI 显示服务状态
   - 一键修复按钮

