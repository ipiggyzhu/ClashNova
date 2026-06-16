# API 诊断脚本 - 排查 Mihomo 内核 API 连接问题
Write-Host "=== Mihomo API 诊断 ===" -ForegroundColor Cyan
Write-Host ""

# 1. 检查服务状态
Write-Host "[1] 服务状态检查" -ForegroundColor Yellow
$serviceQuery = sc.exe query clashnova-core 2>&1 | Out-String
if ($serviceQuery -match "SERVICE_NAME: clashnova-core") {
    Write-Host "[OK] 服务已安装" -ForegroundColor Green

    if ($serviceQuery -match "STATE.*RUNNING") {
        Write-Host "[OK] 服务正在运行" -ForegroundColor Green
    } else {
        Write-Host "[ERROR] 服务未运行！" -ForegroundColor Red
        Write-Host "尝试启动服务..." -ForegroundColor Yellow
        net start clashnova-core
        Start-Sleep -Seconds 3
    }
} else {
    Write-Host "[ERROR] 服务未安装！" -ForegroundColor Red
    Write-Host "请先运行服务安装程序" -ForegroundColor Yellow
    exit 1
}
Write-Host ""

# 2. 检查 Mihomo 进程
Write-Host "[2] Mihomo 进程检查" -ForegroundColor Yellow
$mihomoProcess = Get-Process | Where-Object { $_.ProcessName -like "*mihomo*" -or $_.ProcessName -like "*clash*" }
if ($mihomoProcess) {
    Write-Host "[OK] 找到 Mihomo 进程:" -ForegroundColor Green
    $mihomoProcess | ForEach-Object {
        Write-Host "  - PID: $($_.Id), 名称: $($_.ProcessName), 启动时间: $($_.StartTime)" -ForegroundColor Gray
    }
} else {
    Write-Host "[ERROR] 未找到 Mihomo 进程！" -ForegroundColor Red
    Write-Host "服务可能未成功启动内核" -ForegroundColor Yellow
}
Write-Host ""

# 3. 检查端口监听
Write-Host "[3] API 端口检查 (127.0.0.1:9097)" -ForegroundColor Yellow
$netstat = netstat -ano | Select-String "127.0.0.1:9097"
if ($netstat) {
    Write-Host "[OK] 端口 9097 正在监听:" -ForegroundColor Green
    $netstat | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
} else {
    Write-Host "[ERROR] 端口 9097 未监听！" -ForegroundColor Red
    Write-Host "内核可能未启动或配置错误" -ForegroundColor Yellow
}
Write-Host ""

# 4. 测试 API 连接
Write-Host "[4] API 连接测试" -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:9097/version" -TimeoutSec 3 -ErrorAction Stop
    Write-Host "[OK] API 响应成功:" -ForegroundColor Green
    Write-Host "  状态码: $($response.StatusCode)" -ForegroundColor Gray
    Write-Host "  内容: $($response.Content)" -ForegroundColor Gray
} catch {
    Write-Host "[ERROR] API 连接失败！" -ForegroundColor Red
    Write-Host "  错误: $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ""

# 5. 检查配置文件
Write-Host "[5] 配置文件检查" -ForegroundColor Yellow
$appData = [Environment]::GetFolderPath('ApplicationData')
$configPath = Join-Path $appData "io.clashnova.app\profiles\config.yaml"

if (Test-Path $configPath) {
    Write-Host "[OK] 配置文件存在: $configPath" -ForegroundColor Green

    # 检查 external-controller 配置
    $config = Get-Content $configPath -Raw
    if ($config -match "external-controller:\s*(.+)") {
        $controller = $matches[1].Trim()
        Write-Host "  external-controller: $controller" -ForegroundColor Gray

        if ($controller -ne "127.0.0.1:9097") {
            Write-Host "[WARN] 控制器地址不是 127.0.0.1:9097" -ForegroundColor Yellow
        }
    } else {
        Write-Host "[WARN] 配置文件中未找到 external-controller" -ForegroundColor Yellow
    }
} else {
    Write-Host "[ERROR] 配置文件不存在！" -ForegroundColor Red
}
Write-Host ""

# 6. 检查日志
Write-Host "[6] 服务日志检查" -ForegroundColor Yellow
$logPath = Join-Path $appData "io.clashnova.app\logs"
if (Test-Path $logPath) {
    $latestLog = Get-ChildItem $logPath -Filter "*.log" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latestLog) {
        Write-Host "[OK] 最新日志: $($latestLog.Name)" -ForegroundColor Green
        Write-Host "  最后 10 行:" -ForegroundColor Gray
        Get-Content $latestLog.FullName -Tail 10 | ForEach-Object {
            if ($_ -match "error|错误|failed|失败") {
                Write-Host "  $_" -ForegroundColor Red
            } else {
                Write-Host "  $_" -ForegroundColor Gray
            }
        }
    }
}
Write-Host ""

# 总结
Write-Host "=== 诊断总结 ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "如果 API 连接失败，可能的原因：" -ForegroundColor Yellow
Write-Host "1. Mihomo 进程未启动 → 检查服务日志" -ForegroundColor Gray
Write-Host "2. 配置文件错误 → 检查 external-controller 配置" -ForegroundColor Gray
Write-Host "3. 端口被占用 → 检查是否有其他程序占用 9097" -ForegroundColor Gray
Write-Host "4. 防火墙阻止 → 检查 Windows 防火墙设置" -ForegroundColor Gray
Write-Host ""
Write-Host "请将以上诊断结果反馈给开发者" -ForegroundColor Cyan
