# ClashNova IPC Fix - Build and Test Script
Write-Host "=== ClashNova IPC Build and Test ===" -ForegroundColor Cyan
Write-Host ""

# Step 1: Check Git version
Write-Host "[1/6] Checking Git version..." -ForegroundColor Yellow
git log --oneline -1
Write-Host ""

# Step 2: Build release
Write-Host "[2/6] Building release version (this may take 5-10 minutes)..." -ForegroundColor Yellow
Write-Host "Running: cargo build --release" -ForegroundColor Gray
cargo build --release
if ($LASTEXITCODE -eq 0) {
    Write-Host "Build successful!" -ForegroundColor Green
} else {
    Write-Host "Build failed! Exit code: $LASTEXITCODE" -ForegroundColor Red
    exit 1
}
Write-Host ""

# Step 3: Check executable
Write-Host "[3/6] Checking executable..." -ForegroundColor Yellow
if (Test-Path "target\release\clashnova.exe") {
    $file = Get-Item "target\release\clashnova.exe"
    Write-Host "File: clashnova.exe" -ForegroundColor Green
    Write-Host "Size: $([math]::Round($file.Length/1MB,2)) MB" -ForegroundColor Green
    Write-Host "Time: $($file.LastWriteTime)" -ForegroundColor Green
} else {
    Write-Host "ERROR: clashnova.exe not found!" -ForegroundColor Red
    exit 1
}
Write-Host ""

# Step 4: Stop and uninstall old service
Write-Host "[4/6] Stopping and uninstalling old service..." -ForegroundColor Yellow
sc.exe query clashnova-core | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Stopping service..." -ForegroundColor Gray
    net stop clashnova-core 2>&1 | Out-Null
    Write-Host "Uninstalling service..." -ForegroundColor Gray
    sc.exe delete clashnova-core 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    Write-Host "Old service removed" -ForegroundColor Green
} else {
    Write-Host "No existing service found" -ForegroundColor Gray
}
Write-Host ""

# Step 5: Install and start new service
Write-Host "[5/6] Installing and starting new service..." -ForegroundColor Yellow
if (Test-Path "target\release\service_install.exe") {
    Write-Host "Running service installer..." -ForegroundColor Gray
    Start-Process -FilePath "target\release\service_install.exe" -Wait -NoNewWindow
    Start-Sleep -Seconds 2
    Write-Host "Starting service..." -ForegroundColor Gray
    net start clashnova-core
    Start-Sleep -Seconds 2
    Write-Host "Service started" -ForegroundColor Green
} else {
    Write-Host "ERROR: service_install.exe not found!" -ForegroundColor Red
    exit 1
}
Write-Host ""

# Step 6: Test IPC connection
Write-Host "[6/6] Testing IPC connection..." -ForegroundColor Yellow
Start-Sleep -Seconds 3
try {
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", "clashnova-service", [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(5000)
    Write-Host "SUCCESS: IPC connection works!" -ForegroundColor Green
    $pipe.Close()
} catch {
    Write-Host "ERROR: IPC connection failed: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "Debugging info:" -ForegroundColor Yellow
    Write-Host "Service status:" -ForegroundColor Gray
    sc.exe query clashnova-core
    Write-Host ""
    Write-Host "Named pipes:" -ForegroundColor Gray
    Get-ChildItem \\.\pipe\ | Where-Object { $_.Name -like "*clashnova*" }
}
Write-Host ""
Write-Host "=== Test Complete ===" -ForegroundColor Cyan
