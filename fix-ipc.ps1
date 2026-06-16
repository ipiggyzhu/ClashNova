# One-Click IPC Fix Script
# Run this in PowerShell (Administrator mode)

param(
    [switch]$SkipBuild = $false
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  ClashNova IPC One-Click Fix" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERROR: This script must run as Administrator!" -ForegroundColor Red
    Write-Host "Please right-click PowerShell and select 'Run as Administrator'" -ForegroundColor Yellow
    exit 1
}

Write-Host "[OK] Running as Administrator" -ForegroundColor Green
Write-Host ""

# Step 1: Git pull
Write-Host "[1/7] Pulling latest code from GitHub..." -ForegroundColor Yellow
try {
    git pull origin main
    Write-Host "[OK] Code updated" -ForegroundColor Green
} catch {
    Write-Host "[WARN] Git pull failed: $_" -ForegroundColor Yellow
}
Write-Host ""

# Step 2: Clean and build
if (-not $SkipBuild) {
    Write-Host "[2/7] Cleaning build artifacts..." -ForegroundColor Yellow
    cargo clean
    Write-Host "[OK] Clean complete" -ForegroundColor Green
    Write-Host ""

    Write-Host "[3/7] Building release (this will take 5-10 minutes)..." -ForegroundColor Yellow
    Write-Host "Please be patient..." -ForegroundColor Gray
    cargo build --release
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Build failed!" -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Build complete" -ForegroundColor Green
} else {
    Write-Host "[2/7] Skipping clean (--SkipBuild)" -ForegroundColor Gray
    Write-Host "[3/7] Skipping build (--SkipBuild)" -ForegroundColor Gray
}
Write-Host ""

# Step 3: Check executable
Write-Host "[4/7] Checking executable..." -ForegroundColor Yellow
if (-not (Test-Path "target\release\clashnova.exe")) {
    Write-Host "[ERROR] clashnova.exe not found!" -ForegroundColor Red
    exit 1
}
$exe = Get-Item "target\release\clashnova.exe"
Write-Host "[OK] Found: clashnova.exe" -ForegroundColor Green
Write-Host "     Size: $([math]::Round($exe.Length/1MB,2)) MB" -ForegroundColor Gray
Write-Host "     Modified: $($exe.LastWriteTime)" -ForegroundColor Gray
Write-Host ""

# Step 4: Stop service
Write-Host "[5/7] Stopping service..." -ForegroundColor Yellow
$serviceExists = (sc.exe query clashnova-core 2>&1 | Out-String) -match "clashnova-core"
if ($serviceExists) {
    net stop clashnova-core 2>&1 | Out-Null
    Write-Host "[OK] Service stopped" -ForegroundColor Green
} else {
    Write-Host "[INFO] Service not installed yet" -ForegroundColor Gray
}
Write-Host ""

# Step 5: Uninstall service
Write-Host "[6/7] Uninstalling old service..." -ForegroundColor Yellow
if ($serviceExists) {
    sc.exe delete clashnova-core 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    Write-Host "[OK] Service uninstalled" -ForegroundColor Green
} else {
    Write-Host "[INFO] No service to uninstall" -ForegroundColor Gray
}
Write-Host ""

# Step 6: Install and start service
Write-Host "[7/7] Installing and starting new service..." -ForegroundColor Yellow
if (-not (Test-Path "target\release\service_install.exe")) {
    Write-Host "[ERROR] service_install.exe not found!" -ForegroundColor Red
    exit 1
}

Start-Process -FilePath "target\release\service_install.exe" -Wait -NoNewWindow
Start-Sleep -Seconds 2

net start clashnova-core
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Failed to start service!" -ForegroundColor Red
    Write-Host "Check Windows Event Viewer for details" -ForegroundColor Yellow
    exit 1
}
Write-Host "[OK] Service started" -ForegroundColor Green
Write-Host ""

# Wait for service to initialize
Write-Host "Waiting for service to initialize..." -ForegroundColor Gray
Start-Sleep -Seconds 5

# Final test
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Testing IPC Connection" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if pipe exists
Write-Host "Checking for named pipe..." -ForegroundColor Yellow
$pipes = Get-ChildItem \\.\pipe\ | Where-Object { $_.Name -eq "clashnova-service" }
if ($pipes) {
    Write-Host "[OK] Named pipe exists: clashnova-service" -ForegroundColor Green
} else {
    Write-Host "[ERROR] Named pipe NOT found!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Troubleshooting:" -ForegroundColor Yellow
    Write-Host "1. Check if service is running: sc.exe query clashnova-core" -ForegroundColor Gray
    Write-Host "2. Check Windows Event Log for errors" -ForegroundColor Gray
    Write-Host "3. Make sure you compiled the latest code" -ForegroundColor Gray
    exit 1
}
Write-Host ""

# Try to connect
Write-Host "Testing IPC connection..." -ForegroundColor Yellow
try {
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", "clashnova-service", [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(5000)

    Write-Host "[OK] Connection successful!" -ForegroundColor Green

    # Send ping
    $writer = New-Object System.IO.StreamWriter($pipe)
    $reader = New-Object System.IO.StreamReader($pipe)
    $writer.AutoFlush = $true

    $request = '{"command":"ping","data":null}'
    $writer.WriteLine($request)

    $response = $reader.ReadLine()
    Write-Host "[OK] Ping response: $response" -ForegroundColor Green

    $pipe.Close()

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  SUCCESS! IPC IS WORKING!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "You can now:" -ForegroundColor Yellow
    Write-Host "  1. Launch ClashNova GUI" -ForegroundColor Gray
    Write-Host "  2. Try switching TUN mode" -ForegroundColor Gray
    Write-Host "  3. Check that there are no IPC errors" -ForegroundColor Gray

} catch {
    Write-Host "[ERROR] IPC connection failed!" -ForegroundColor Red
    Write-Host "Error: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please run diagnostics:" -ForegroundColor Yellow
    Write-Host "  .\deep-diagnose.ps1" -ForegroundColor Gray
    exit 1
}
