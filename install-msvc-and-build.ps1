# ClashNova - 一键安装 MSVC 工具链并编译测试
# 此脚本会自动下载并安装 Visual Studio Build Tools，然后编译项目

param(
    [switch]$SkipInstall = $false,
    [switch]$SkipBuild = $false
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  ClashNova MSVC 自动安装和编译脚本" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 检查管理员权限
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $SkipInstall) {
    Write-Host "需要管理员权限安装 Build Tools" -ForegroundColor Yellow
    Write-Host "正在提升权限..." -ForegroundColor Yellow
    Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

Write-Host "[1/5] 检查 MSVC 工具链..." -ForegroundColor Yellow

# 检查 link.exe 是否存在
$linkExists = Get-Command link.exe -ErrorAction SilentlyContinue
if ($linkExists) {
    Write-Host "[OK] MSVC 已安装: $($linkExists.Source)" -ForegroundColor Green
    $SkipInstall = $true
} else {
    Write-Host "[WARN] MSVC 未安装" -ForegroundColor Yellow
}

if (-not $SkipInstall) {
    Write-Host ""
    Write-Host "[2/5] 下载 Visual Studio Build Tools..." -ForegroundColor Yellow

    $installerPath = "$env:TEMP\vs_buildtools.exe"
    $url = "https://aka.ms/vs/17/release/vs_buildtools.exe"

    try {
        Write-Host "下载地址: $url" -ForegroundColor Gray
        Invoke-WebRequest -Uri $url -OutFile $installerPath -UseBasicParsing
        Write-Host "[OK] 下载完成" -ForegroundColor Green
    } catch {
        Write-Host "[ERROR] 下载失败: $_" -ForegroundColor Red
        Write-Host ""
        Write-Host "请手动下载并安装:" -ForegroundColor Yellow
        Write-Host "1. 访问: https://visualstudio.microsoft.com/zh-hans/downloads/" -ForegroundColor Gray
        Write-Host "2. 下载 'Build Tools for Visual Studio 2022'" -ForegroundColor Gray
        Write-Host "3. 运行安装程序" -ForegroundColor Gray
        Write-Host "4. 选择 '使用 C++ 的桌面开发'" -ForegroundColor Gray
        Write-Host "5. 重新运行本脚本" -ForegroundColor Gray
        exit 1
    }

    Write-Host ""
    Write-Host "[3/5] 安装 Visual Studio Build Tools..." -ForegroundColor Yellow
    Write-Host "这将需要约 10-15 分钟，请耐心等待..." -ForegroundColor Gray
    Write-Host ""

    $installArgs = @(
        "--quiet",
        "--wait",
        "--norestart",
        "--nocache",
        "--add", "Microsoft.VisualStudio.Workload.VCTools",
        "--add", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "--add", "Microsoft.VisualStudio.Component.Windows11SDK.22621"
    )

    try {
        $process = Start-Process -FilePath $installerPath -ArgumentList $installArgs -Wait -PassThru
        if ($process.ExitCode -eq 0 -or $process.ExitCode -eq 3010) {
            Write-Host "[OK] 安装完成" -ForegroundColor Green
        } else {
            Write-Host "[WARN] 安装返回代码: $($process.ExitCode)" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "[ERROR] 安装失败: $_" -ForegroundColor Red
        exit 1
    }

    # 清理安装文件
    Remove-Item -Path $installerPath -Force -ErrorAction SilentlyContinue

    Write-Host ""
    Write-Host "[4/5] 刷新环境变量..." -ForegroundColor Yellow
    Write-Host "需要重新打开 PowerShell 以加载新的 PATH" -ForegroundColor Gray
    Write-Host ""
    Write-Host "请执行以下步骤:" -ForegroundColor Yellow
    Write-Host "1. 关闭此 PowerShell 窗口" -ForegroundColor Gray
    Write-Host "2. 重新打开 PowerShell" -ForegroundColor Gray
    Write-Host "3. 运行: cd D:\code\ClashNova-v2" -ForegroundColor Gray
    Write-Host "4. 运行: .\install-msvc-and-build.ps1 -SkipInstall" -ForegroundColor Gray
    exit 0
}

Write-Host ""
Write-Host "[4/5] 验证 MSVC 工具链..." -ForegroundColor Yellow

# 尝试找到 link.exe
$linkPath = Get-Command link.exe -ErrorAction SilentlyContinue
if ($linkPath) {
    Write-Host "[OK] link.exe 路径: $($linkPath.Source)" -ForegroundColor Green
} else {
    Write-Host "[ERROR] link.exe 仍未找到" -ForegroundColor Red
    Write-Host ""
    Write-Host "请尝试以下操作:" -ForegroundColor Yellow
    Write-Host "1. 打开 'x64 Native Tools Command Prompt for VS 2022'" -ForegroundColor Gray
    Write-Host "2. 在该命令提示符中运行:" -ForegroundColor Gray
    Write-Host "   cd D:\code\ClashNova-v2" -ForegroundColor Gray
    Write-Host "   cargo build --release" -ForegroundColor Gray
    exit 1
}

if ($SkipBuild) {
    Write-Host ""
    Write-Host "跳过编译步骤 (--SkipBuild)" -ForegroundColor Gray
    exit 0
}

Write-Host ""
Write-Host "[5/5] 开始编译项目..." -ForegroundColor Yellow
Write-Host "这将需要 5-10 分钟..." -ForegroundColor Gray
Write-Host ""

cd D:\code\ClashNova-v2

# 清理旧的构建
Write-Host "清理旧的构建..." -ForegroundColor Gray
cargo clean 2>&1 | Out-Null

# 编译 Release 版本
Write-Host "编译 Release 版本..." -ForegroundColor Gray
$buildOutput = cargo build --release 2>&1
$buildSuccess = $LASTEXITCODE -eq 0

if ($buildSuccess) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  编译成功!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""

    # 检查生成的文件
    Write-Host "生成的文件:" -ForegroundColor Yellow
    Get-ChildItem target\release\*.exe | ForEach-Object {
        Write-Host "  - $($_.Name) ($([math]::Round($_.Length/1MB,2)) MB)" -ForegroundColor Gray
    }

    Write-Host ""
    Write-Host "下一步:" -ForegroundColor Yellow
    Write-Host "1. 测试服务安装:" -ForegroundColor Gray
    Write-Host "   .\target\release\clashnova-service-install.exe" -ForegroundColor Gray
    Write-Host ""
    Write-Host "2. 测试 GUI:" -ForegroundColor Gray
    Write-Host "   .\target\release\clashnova.exe" -ForegroundColor Gray
    Write-Host ""
    Write-Host "3. 运行诊断:" -ForegroundColor Gray
    Write-Host "   .\deep-diagnose.ps1" -ForegroundColor Gray

} else {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "  编译失败" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host ""

    # 显示错误日志
    Write-Host "错误日志:" -ForegroundColor Yellow
    $buildOutput | Select-String "error" -Context 0,3 | ForEach-Object {
        Write-Host $_.Line -ForegroundColor Red
    }

    Write-Host ""
    Write-Host "完整日志已保存到 build.log" -ForegroundColor Gray
    $buildOutput | Out-File -FilePath "build.log" -Encoding UTF8

    exit 1
}
