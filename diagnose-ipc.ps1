# IPC 问题诊断脚本
# 请在 PowerShell（管理员模式）中运行

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "ClashNova IPC 诊断工具" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

# 1. 检查 Git 版本
Write-Host "[1] 检查代码版本..." -ForegroundColor Yellow
$gitCommit = git log --oneline -1
Write-Host "当前 commit: $gitCommit" -ForegroundColor Green
Write-Host ""

# 2. 检查编译时间
Write-Host "[2] 检查可执行文件..." -ForegroundColor Yellow
if (Test-Path "target\release\clashnova.exe") {
    $fileInfo = Get-Item "target\release\clashnova.exe"
    Write-Host "✓ clashnova.exe 存在" -ForegroundColor Green
    Write-Host "  最后编译时间: $($fileInfo.LastWriteTime)" -ForegroundColor Gray
    Write-Host "  文件大小: $([math]::Round($fileInfo.Length / 1MB, 2)) MB" -ForegroundColor Gray
} else {
    Write-Host "✗ clashnova.exe 不存在，需要编译！" -ForegroundColor Red
}
Write-Host ""

# 3. 检查服务状态
Write-Host "[3] 检查服务状态..." -ForegroundColor Yellow
$serviceStatus = sc.exe query clashnova-core 2>&1
if ($serviceStatus -match "RUNNING") {
    Write-Host "✓ 服务正在运行" -ForegroundColor Green
} elseif ($serviceStatus -match "STOPPED") {
    Write-Host "⚠ 服务已停止" -ForegroundColor Yellow
} else {
    Write-Host "✗ 服务未安装" -ForegroundColor Red
}
Write-Host $serviceStatus
Write-Host ""

# 4. 检查命名管道
Write-Host "[4] 检查命名管道..." -ForegroundColor Yellow
$pipes = Get-ChildItem \\.\pipe\ 2>&1 | Where-Object { $_.Name -like "*clashnova*" -or $_.Name -like "*clash*" }
if ($pipes) {
    Write-Host "✓ 找到相关管道:" -ForegroundColor Green
    $pipes | ForEach-Object { Write-Host "  - $($_.Name)" -ForegroundColor Gray }
} else {
    Write-Host "✗ 未找到 clashnova 相关的命名管道" -ForegroundColor Red
    Write-Host "  预期管道名: clashnova-service" -ForegroundColor Gray
}
Write-Host ""

# 5. 检查进程
Write-Host "[5] 检查相关进程..." -ForegroundColor Yellow
$processes = Get-Process | Where-Object { $_.ProcessName -like "*clashnova*" -or $_.ProcessName -like "*mihomo*" }
if ($processes) {
    Write-Host "✓ 找到相关进程:" -ForegroundColor Green
    $processes | ForEach-Object {
        Write-Host "  - $($_.ProcessName) (PID: $($_.Id))" -ForegroundColor Gray
    }
} else {
    Write-Host "⚠ 未找到相关进程" -ForegroundColor Yellow
}
Write-Host ""

# 6. 检查日志文件
Write-Host "[6] 检查日志..." -ForegroundColor Yellow
$logPaths = @(
    "$env:APPDATA\ClashNova\logs\app.log",
    "$env:APPDATA\ClashNova\logs\service.log",
    "C:\ProgramData\ClashNova\service.log"
)

foreach ($logPath in $logPaths) {
    if (Test-Path $logPath) {
        Write-Host "✓ 日志文件: $logPath" -ForegroundColor Green
        Write-Host "  最新几行:" -ForegroundColor Gray
        Get-Content $logPath -Tail 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        Write-Host ""
    }
}

# 7. 测试 IPC 连接
Write-Host "[7] 测试 IPC 连接..." -ForegroundColor Yellow
try {
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", "clashnova-service", [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(1000)
    Write-Host "✓ IPC 连接成功！" -ForegroundColor Green
    $pipe.Close()
} catch {
    Write-Host "✗ IPC 连接失败: $_" -ForegroundColor Red
}
Write-Host ""

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "诊断完成" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步建议:" -ForegroundColor Yellow
Write-Host "1. 如果代码版本不是 b03d31c 或更新，请执行: git pull" -ForegroundColor Gray
Write-Host "2. 如果 clashnova.exe 编译时间早于代码更新，请执行: cargo build --release" -ForegroundColor Gray
Write-Host "3. 如果服务未运行或管道不存在，请重启服务" -ForegroundColor Gray
Write-Host "4. 如果服务运行但管道不存在，说明服务代码未更新，需要重新编译和安装" -ForegroundColor Gray
