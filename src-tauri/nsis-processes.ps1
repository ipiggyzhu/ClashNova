[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$InstallRoot,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
# IsPathRooted also accepts C:relative and \relative in Windows PowerShell 5.1.
if ([IO.Path]::GetPathRoot($InstallRoot).Length -lt 3) { throw 'InstallRoot must be fully qualified' }
$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\')) { throw 'InstallRoot cannot be a drive root' }
$prefix = $root + '\'
$programFiles = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$managed = [IO.Path]::GetFullPath((Join-Path $programFiles 'ClashNova\service\clashnova-service.exe'))
$service = Get-CimInstance Win32_Service -Filter "Name='clashnova-core'"
if ($service) {
    $match = [regex]::Match($service.PathName, '^\s*(?:"([^"]+)"|([^\s]+))')
    if (-not $match.Success) { throw 'Unrecognized ClashNova service command' }
    $binary = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    $binary = [IO.Path]::GetFullPath($binary)
    $owned = $binary.Equals($managed, [StringComparison]::OrdinalIgnoreCase) -or $binary.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    if (-not $owned) { throw 'ClashNova service belongs to another installation; leaving it untouched' }
    if ($PSCmdlet.ShouldProcess('clashnova-core', 'Stop service')) {
        $controller = Get-Service -Name 'clashnova-core'
        if ($controller.Status -ne 'Stopped') {
            Stop-Service -Name 'clashnova-core'
            $controller.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
        }
    }
    if ($Uninstall -and $PSCmdlet.ShouldProcess('clashnova-core', 'Delete service registration')) {
        & sc.exe delete clashnova-core | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Failed to remove ClashNova service registration' }
    }
}

$names = @('clashnova.exe', 'mihomo.exe', 'mihomo-x86_64-pc-windows-msvc.exe', 'clashnova-service.exe')
Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in $names -and $_.ExecutablePath -and
    ([IO.Path]::GetFullPath($_.ExecutablePath)).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
} | ForEach-Object {
    if ($PSCmdlet.ShouldProcess("$($_.Name) PID $($_.ProcessId)", 'Stop installed process')) {
        $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($process) {
            # Pin this process before checking its path; never kill a reused PID.
            $null = $process.Handle
            $currentPath = $process.Path
            if ($currentPath -and ([IO.Path]::GetFullPath($currentPath)).Equals([IO.Path]::GetFullPath($_.ExecutablePath), [StringComparison]::OrdinalIgnoreCase)) {
                Stop-Process -InputObject $process -Force
                if (-not $process.WaitForExit(10000)) { throw 'Installed process did not stop' }
            }
        }
    }
}
