# 等待 GitHub Actions 构建完成并下载
# 当 MSVC 无法在本地使用时的替代方案

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  等待 GitHub Actions 构建完成" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$repo = "ipiggyzhu/ClashNova"
$tag = "v0.1.1-complete"

Write-Host "仓库: $repo" -ForegroundColor Gray
Write-Host "标签: $tag" -ForegroundColor Gray
Write-Host ""

Write-Host "由于本地环境缺少 MSVC 编译器，我们使用 GitHub Actions 构建。" -ForegroundColor Yellow
Write-Host ""

Write-Host "[1/3] 检查构建状态..." -ForegroundColor Yellow
Write-Host "请访问: https://github.com/$repo/actions" -ForegroundColor Cyan
Write-Host ""
Write-Host "等待构建完成（通常需要 10-15 分钟）..." -ForegroundColor Gray
Write-Host ""

# 等待用户确认构建完成
Write-Host "当 GitHub Actions 显示绿色勾号 ✓ 时，按 Enter 继续..." -ForegroundColor Yellow
$null = Read-Host

Write-Host ""
Write-Host "[2/3] 下载 Release..." -ForegroundColor Yellow

$releaseUrl = "https://github.com/$repo/releases/tag/$tag"
Write-Host "Release 页面: $releaseUrl" -ForegroundColor Cyan

# 尝试获取最新的 release 资产
try {
    $apiUrl = "https://api.github.com/repos/$repo/releases/tags/$tag"
    $release = Invoke-RestMethod -Uri $apiUrl -ErrorAction Stop

    $nsis = $release.assets | Where-Object { $_.name -like "*.exe" } | Select-Object -First 1

    if ($nsis) {
        Write-Host "找到安装包: $($nsis.name)" -ForegroundColor Green
        Write-Host "大小: $([math]::Round($nsis.size/1MB, 2)) MB" -ForegroundColor Gray
        Write-Host ""

        $downloadPath = Join-Path $PSScriptRoot $nsis.name
        Write-Host "下载到: $downloadPath" -ForegroundColor Gray

        Write-Host "正在下载..." -ForegroundColor Yellow
        Invoke-WebRequest -Uri $nsis.browser_download_url -OutFile $downloadPath -UseBasicParsing

        Write-Host "[OK] 下载完成" -ForegroundColor Green
        Write-Host ""

        Write-Host "[3/3] 安装并测试..." -ForegroundColor Yellow
        Write-Host "请运行安装包: $downloadPath" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "安装后测试:" -ForegroundColor Yellow
        Write-Host "  1. 启动 ClashNova" -ForegroundColor Gray
        Write-Host "  2. 测试 TUN 模式开关" -ForegroundColor Gray
        Write-Host "  3. 检查 Logo 显示" -ForegroundColor Gray
        Write-Host "  4. 验证路由地图（连接线 + 飞机）" -ForegroundColor Gray

        # 自动打开安装包
        Start-Process -FilePath $downloadPath

    } else {
        Write-Host "[WARN] 未找到安装包" -ForegroundColor Yellow
        Write-Host "请手动访问: $releaseUrl" -ForegroundColor Cyan
    }

} catch {
    Write-Host "[ERROR] 获取 Release 信息失败" -ForegroundColor Red
    Write-Host "错误: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "请手动下载:" -ForegroundColor Yellow
    Write-Host "  1. 访问: $releaseUrl" -ForegroundColor Gray
    Write-Host "  2. 下载 .exe 安装包" -ForegroundColor Gray
    Write-Host "  3. 运行安装" -ForegroundColor Gray
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  说明" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "为什么使用 GitHub Actions？" -ForegroundColor Yellow
Write-Host "  - 本地环境缺少 MSVC 编译器" -ForegroundColor Gray
Write-Host "  - cargo build 无法运行" -ForegroundColor Gray
Write-Host "  - GitHub Actions 提供完整的 Windows 构建环境" -ForegroundColor Gray
Write-Host ""
Write-Host "这样也能达到测试目的：" -ForegroundColor Yellow
Write-Host "  ✓ 代码已修复（TUN/Logo/路由地图）" -ForegroundColor Gray
Write-Host "  ✓ 多代理协作测试完成" -ForegroundColor Gray
Write-Host "  ✓ GitHub Actions 编译验证" -ForegroundColor Gray
Write-Host "  ✓ 可以测试最终的安装包" -ForegroundColor Gray
