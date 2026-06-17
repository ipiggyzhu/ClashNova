# GitHub Actions 自动编译检测脚本
# 功能: 监控编译状态，失败时获取错误日志并分析

param(
    [string]$repo = "ipiggyzhu/ClashNova",
    [int]$maxWaitMinutes = 30,
    [int]$checkIntervalSeconds = 30
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  GitHub Actions 编译检测脚本" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 获取最新的 workflow run
function Get-LatestWorkflowRun {
    $apiUrl = "https://api.github.com/repos/$repo/actions/runs?per_page=1"
    try {
        $response = Invoke-RestMethod -Uri $apiUrl -Headers @{
            "Accept" = "application/vnd.github+json"
        }
        return $response.workflow_runs[0]
    } catch {
        Write-Host "[ERROR] 获取 workflow run 失败: $_" -ForegroundColor Red
        return $null
    }
}

# 获取 workflow run 的日志
function Get-WorkflowLogs {
    param([string]$runId)
    
    $logsUrl = "https://api.github.com/repos/$repo/actions/runs/$runId/logs"
    $tempZip = Join-Path $env:TEMP "workflow-logs-$runId.zip"
    $tempDir = Join-Path $env:TEMP "workflow-logs-$runId"
    
    try {
        Invoke-WebRequest -Uri $logsUrl -OutFile $tempZip -Headers @{
            "Accept" = "application/vnd.github+json"
        }
        
        if (Test-Path $tempDir) {
            Remove-Item $tempDir -Recurse -Force
        }
        Expand-Archive -Path $tempZip -DestinationPath $tempDir
        
        return $tempDir
    } catch {
        Write-Host "[ERROR] 下载日志失败: $_" -ForegroundColor Red
        return $null
    }
}

# 分析错误日志
function Analyze-BuildErrors {
    param([string]$logsDir)
    
    Write-Host "[分析] 开始分析构建错误..." -ForegroundColor Yellow
    
    $errorPatterns = @{
        "LinkerError" = @("error: linker", "link.exe", "LINK : fatal error")
        "CargoError" = @("error: could not compile", "error\[E\d+\]")
        "DependencyError" = @("error: failed to resolve", "error: no matching package")
        "BuildScriptError" = @("error: failed to run custom build command")
        "TauriError" = @("Error: Command failed", "tauri build failed")
    }
    
    $foundErrors = @{}
    
    Get-ChildItem -Path $logsDir -Filter "*.txt" -Recurse | ForEach-Object {
        $content = Get-Content $_.FullName -Raw
        
        foreach ($errorType in $errorPatterns.Keys) {
            foreach ($pattern in $errorPatterns[$errorType]) {
                if ($content -match $pattern) {
                    if (-not $foundErrors.ContainsKey($errorType)) {
                        $foundErrors[$errorType] = @()
                    }
                    
                    $lines = $content -split "`n"
                    for ($i = 0; $i -lt $lines.Count; $i++) {
                        if ($lines[$i] -match $pattern) {
                            $start = [Math]::Max(0, $i - 5)
                            $end = [Math]::Min($lines.Count - 1, $i + 5)
                            $context = $lines[$start..$end] -join "`n"
                            $foundErrors[$errorType] += $context
                            break
                        }
                    }
                    break
                }
            }
        }
    }
    
    return $foundErrors
}

# 主逻辑
Write-Host "[1/3] 获取最新的 workflow run..." -ForegroundColor Yellow
$run = Get-LatestWorkflowRun

if (-not $run) {
    Write-Host "[ERROR] 无法获取 workflow run" -ForegroundColor Red
    exit 1
}

$runId = $run.id
$runUrl = $run.html_url
$status = $run.status
$conclusion = $run.conclusion

Write-Host "Run ID: $runId" -ForegroundColor Gray
Write-Host "URL: $runUrl" -ForegroundColor Gray
Write-Host "Status: $status" -ForegroundColor Gray
Write-Host ""

# 等待构建完成
$startTime = Get-Date

while ($status -eq "in_progress" -or $status -eq "queued") {
    $elapsed = ((Get-Date) - $startTime).TotalMinutes
    
    if ($elapsed -gt $maxWaitMinutes) {
        Write-Host "[TIMEOUT] 等待超过 $maxWaitMinutes 分钟，停止等待" -ForegroundColor Yellow
        Write-Host "您可以访问 $runUrl 查看构建进度" -ForegroundColor Cyan
        exit 2
    }
    
    Write-Host "[等待] 构建进行中... ($([int]$elapsed) 分钟)" -ForegroundColor Gray
    Start-Sleep -Seconds $checkIntervalSeconds
    
    $run = Get-LatestWorkflowRun
    $status = $run.status
    $conclusion = $run.conclusion
}

Write-Host ""
Write-Host "[2/3] 构建完成，状态: $conclusion" -ForegroundColor Yellow

if ($conclusion -eq "success") {
    Write-Host "[SUCCESS] ✓ 构建成功！" -ForegroundColor Green
    Write-Host ""
    Write-Host "下载地址: https://github.com/$repo/releases/latest" -ForegroundColor Cyan
    Write-Host ""
    
    $artifactsUrl = "https://api.github.com/repos/$repo/actions/runs/$runId/artifacts"
    try {
        $artifacts = Invoke-RestMethod -Uri $artifactsUrl -Headers @{
            "Accept" = "application/vnd.github+json"
        }
        
        Write-Host "构建产物:" -ForegroundColor Yellow
        foreach ($artifact in $artifacts.artifacts) {
            Write-Host "  - $($artifact.name) ($([Math]::Round($artifact.size_in_bytes / 1MB, 2)) MB)" -ForegroundColor Gray
        }
    } catch {
        Write-Host "[WARN] 无法获取 artifacts 信息" -ForegroundColor Yellow
    }
    
    exit 0
}

# 构建失败，获取错误日志
Write-Host "[FAILED] ✗ 构建失败" -ForegroundColor Red
Write-Host ""
Write-Host "[3/3] 下载并分析错误日志..." -ForegroundColor Yellow

$logsDir = Get-WorkflowLogs -runId $runId

if (-not $logsDir) {
    Write-Host "[ERROR] 无法下载日志" -ForegroundColor Red
    Write-Host "请手动访问: $runUrl" -ForegroundColor Cyan
    exit 3
}

$errors = Analyze-BuildErrors -logsDir $logsDir

if ($errors.Count -eq 0) {
    Write-Host "[WARN] 未检测到已知错误模式" -ForegroundColor Yellow
    Write-Host "日志已保存到: $logsDir" -ForegroundColor Cyan
    exit 4
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Red
Write-Host "  错误分析" -ForegroundColor Red
Write-Host "========================================" -ForegroundColor Red
Write-Host ""

foreach ($errorType in $errors.Keys) {
    Write-Host "[$errorType]" -ForegroundColor Red
    foreach ($context in $errors[$errorType]) {
        Write-Host $context -ForegroundColor Gray
        Write-Host ""
    }
}

$reportPath = Join-Path (Get-Location) "build-error-report.txt"
$reportContent = @"
GitHub Actions 构建错误报告
生成时间: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
Run ID: $runId
Run URL: $runUrl

检测到的错误类型:
$($errors.Keys -join ", ")

详细错误信息:
$(
    foreach ($errorType in $errors.Keys) {
        "[$errorType]`n"
        foreach ($context in $errors[$errorType]) {
            "$context`n`n"
        }
    }
)

完整日志位置:
$logsDir
"@

$reportContent | Out-File -FilePath $reportPath -Encoding UTF8

Write-Host "错误报告已保存到: $reportPath" -ForegroundColor Cyan
Write-Host "完整日志位置: $logsDir" -ForegroundColor Cyan
Write-Host ""

exit 5
