# Deep IPC Diagnostics Script
Write-Host "=== Deep IPC Diagnostics ===" -ForegroundColor Cyan
Write-Host ""

# 1. Check if service is installed
Write-Host "[1] Service Installation Check" -ForegroundColor Yellow
$serviceQuery = sc.exe query clashnova-core 2>&1 | Out-String
Write-Host $serviceQuery
if ($serviceQuery -match "SERVICE_NAME: clashnova-core") {
    Write-Host "Service is installed" -ForegroundColor Green
} else {
    Write-Host "ERROR: Service is NOT installed!" -ForegroundColor Red
    Write-Host "Please run: .\target\release\service_install.exe" -ForegroundColor Yellow
    exit 1
}
Write-Host ""

# 2. Check if service is running
Write-Host "[2] Service Running Check" -ForegroundColor Yellow
if ($serviceQuery -match "STATE.*RUNNING") {
    Write-Host "Service is RUNNING" -ForegroundColor Green
} elseif ($serviceQuery -match "STATE.*STOPPED") {
    Write-Host "ERROR: Service is STOPPED!" -ForegroundColor Red
    Write-Host "Starting service..." -ForegroundColor Yellow
    net start clashnova-core
    Start-Sleep -Seconds 3
    Write-Host "Service started" -ForegroundColor Green
} else {
    Write-Host "ERROR: Unknown service state!" -ForegroundColor Red
    exit 1
}
Write-Host ""

# 3. Check service binary path
Write-Host "[3] Service Binary Check" -ForegroundColor Yellow
$serviceConfig = sc.exe qc clashnova-core 2>&1 | Out-String
Write-Host $serviceConfig
if ($serviceConfig -match "BINARY_PATH_NAME.*: (.*)") {
    $binaryPath = $matches[1].Trim()
    Write-Host "Binary path: $binaryPath" -ForegroundColor Gray
    if (Test-Path $binaryPath) {
        $fileInfo = Get-Item $binaryPath
        Write-Host "Binary exists" -ForegroundColor Green
        Write-Host "Last modified: $($fileInfo.LastWriteTime)" -ForegroundColor Gray
    } else {
        Write-Host "ERROR: Binary file does not exist!" -ForegroundColor Red
    }
}
Write-Host ""

# 4. Check named pipes
Write-Host "[4] Named Pipes Check" -ForegroundColor Yellow
Start-Sleep -Seconds 2
$allPipes = Get-ChildItem \\.\pipe\ 2>&1
$clashnovaPipes = $allPipes | Where-Object { $_.Name -like "*clashnova*" }
if ($clashnovaPipes) {
    Write-Host "Found ClashNova pipes:" -ForegroundColor Green
    $clashnovaPipes | ForEach-Object { Write-Host "  - $($_.Name)" -ForegroundColor Gray }
} else {
    Write-Host "ERROR: No ClashNova pipes found!" -ForegroundColor Red
    Write-Host "Expected pipe: clashnova-service" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "This means the service is running but NOT creating the named pipe." -ForegroundColor Yellow
    Write-Host "Possible causes:" -ForegroundColor Yellow
    Write-Host "  1. Service binary is old (compiled before IPC fix)" -ForegroundColor Gray
    Write-Host "  2. Service crashed during startup" -ForegroundColor Gray
    Write-Host "  3. Service is stuck in initialization" -ForegroundColor Gray
}
Write-Host ""

# 5. Check processes
Write-Host "[5] Process Check" -ForegroundColor Yellow
$processes = Get-Process | Where-Object { $_.ProcessName -like "*clashnova*" -or $_.ProcessName -like "*mihomo*" }
if ($processes) {
    Write-Host "Found processes:" -ForegroundColor Green
    $processes | ForEach-Object {
        Write-Host "  - $($_.ProcessName) (PID: $($_.Id), Started: $($_.StartTime))" -ForegroundColor Gray
    }
} else {
    Write-Host "WARNING: No processes found" -ForegroundColor Yellow
}
Write-Host ""

# 6. Check event logs
Write-Host "[6] Windows Event Log Check" -ForegroundColor Yellow
$events = Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='clashnova-core'} -MaxEvents 5 -ErrorAction SilentlyContinue 2>&1
if ($events) {
    Write-Host "Recent service events:" -ForegroundColor Green
    $events | ForEach-Object {
        Write-Host "  [$($_.TimeCreated)] $($_.Message)" -ForegroundColor Gray
    }
} else {
    Write-Host "No recent events found" -ForegroundColor Gray
}
Write-Host ""

# 7. Test pipe connection
Write-Host "[7] IPC Connection Test" -ForegroundColor Yellow
try {
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", "clashnova-service", [System.IO.Pipes.PipeDirection]::InOut)
    Write-Host "Attempting connection (timeout: 5 seconds)..." -ForegroundColor Gray
    $pipe.Connect(5000)
    Write-Host "SUCCESS: IPC connection established!" -ForegroundColor Green

    # Try to send a ping command
    Write-Host "Sending ping command..." -ForegroundColor Gray
    $writer = New-Object System.IO.StreamWriter($pipe)
    $reader = New-Object System.IO.StreamReader($pipe)
    $writer.AutoFlush = $true

    $request = '{"command":"ping","data":null}'
    $writer.WriteLine($request)

    $response = $reader.ReadLine()
    Write-Host "Response received: $response" -ForegroundColor Green

    $pipe.Close()
    Write-Host ""
    Write-Host "=== IPC IS WORKING! ===" -ForegroundColor Green
} catch {
    Write-Host "ERROR: IPC connection failed!" -ForegroundColor Red
    Write-Host "Error details: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "=== DIAGNOSIS ===" -ForegroundColor Yellow

    if ($clashnovaPipes) {
        Write-Host "Pipe exists but connection failed - possible issues:" -ForegroundColor Yellow
        Write-Host "  - Pipe permissions issue" -ForegroundColor Gray
        Write-Host "  - Pipe in use by another process" -ForegroundColor Gray
        Write-Host "  - Firewall/antivirus blocking" -ForegroundColor Gray
    } else {
        Write-Host "Pipe does not exist - service not creating pipe:" -ForegroundColor Yellow
        Write-Host "  - Service binary needs to be recompiled" -ForegroundColor Gray
        Write-Host "  - Service code path not reaching pipe creation" -ForegroundColor Gray
        Write-Host ""
        Write-Host "SOLUTION: Recompile and reinstall service" -ForegroundColor Green
        Write-Host "  1. cargo clean" -ForegroundColor Gray
        Write-Host "  2. cargo build --release" -ForegroundColor Gray
        Write-Host "  3. net stop clashnova-core" -ForegroundColor Gray
        Write-Host "  4. sc.exe delete clashnova-core" -ForegroundColor Gray
        Write-Host "  5. .\target\release\service_install.exe" -ForegroundColor Gray
        Write-Host "  6. net start clashnova-core" -ForegroundColor Gray
    }
}
Write-Host ""
Write-Host "=== Diagnostics Complete ===" -ForegroundColor Cyan
