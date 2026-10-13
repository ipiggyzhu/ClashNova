# Read-only snapshot. Never return addresses, process identities, adapter names or raw errors.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$corePid = [uint32]$env:CLASHNOVA_DIAG_PID

function Read-Listener($entries, [uint16]$port, [string]$address) {
    if (-not $port -or -not $address) { return $null }
    $any = if ($address.Contains(':')) { '::' } else { '0.0.0.0' }
    $matches = @($entries | Where-Object { $_.LocalPort -eq $port -and ($_.LocalAddress -eq $address -or $_.LocalAddress -eq $any) })
    $owned = $null
    if ($corePid -gt 0) {
        $owned = $matches.Count -gt 0 -and @($matches | Where-Object { $_.OwningProcess -ne $corePid }).Count -eq 0
    }
    return @{ occupied = ($matches.Count -gt 0); owned = $owned }
}

$result = @{ mixed = $null; controller = $null; dns = $null; tunUp = $null; service = $null }
try {
    $tcp = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
    $result.mixed = Read-Listener $tcp $env:CLASHNOVA_DIAG_MIXED_PORT '127.0.0.1'
    $result.controller = Read-Listener $tcp $env:CLASHNOVA_DIAG_CONTROLLER_PORT $env:CLASHNOVA_DIAG_CONTROLLER_IP
} catch { }
try {
    $udp = @(Get-NetUDPEndpoint -ErrorAction Stop)
    $result.dns = Read-Listener $udp $env:CLASHNOVA_DIAG_DNS_PORT $env:CLASHNOVA_DIAG_DNS_IP
} catch { }
try {
    $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='clashnova-core'" -ErrorAction Stop
    $result.service = if (-not $service) { 'missing' } elseif ($service.State -eq 'Running') { 'running' } elseif ($service.State -eq 'Stopped') { 'stopped' } else { 'pending' }
} catch { }
if ($env:CLASHNOVA_DIAG_TUN -eq '1') {
    try {
        $device = $env:CLASHNOVA_DIAG_DEVICE
        $adapters = @(Get-NetAdapter -IncludeHidden -ErrorAction Stop | Where-Object {
            if ($device) { $_.Name -eq $device } else {
                $_.Name -match '(?i)(Mihomo|ClashNova|Clash|Meta Tunnel|SakuraiTunnel)' -or $_.InterfaceDescription -match '(?i)(Mihomo|Clash|Meta Tunnel)'
            }
        })
        $result.tunUp = @($adapters | Where-Object { $_.Status -eq 'Up' }).Count -gt 0
    } catch { }
}
$result | ConvertTo-Json -Depth 3 -Compress
