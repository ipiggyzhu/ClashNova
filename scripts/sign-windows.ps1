param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = 'Stop'

function Find-SignTool {
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $roots = @(
    "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
    "${env:ProgramFiles}\Windows Kits\10\bin"
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  foreach ($root in $roots) {
    $tool = Get-ChildItem -LiteralPath $root -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($tool) {
      return $tool.FullName
    }
  }

  throw 'signtool.exe was not found on this runner.'
}

function Get-CertificatePath {
  $base64 = $env:WINDOWS_CERTIFICATE_BASE64
  if ([string]::IsNullOrWhiteSpace($base64)) {
    return $null
  }

  $tempDir = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
  $certPath = Join-Path $tempDir 'clashnova-code-signing.pfx'
  if (!(Test-Path -LiteralPath $certPath)) {
    $bytes = [Convert]::FromBase64String(($base64 -replace '\s', ''))
    [System.IO.File]::WriteAllBytes($certPath, $bytes)
  }
  return $certPath
}

$resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
$target = $resolved.Path
$extension = [System.IO.Path]::GetExtension($target).ToLowerInvariant()
if ($extension -notin @('.exe', '.msi', '.dll')) {
  Write-Host "Skipping signing for unsupported file type: $target"
  exit 0
}

$certPath = Get-CertificatePath
if (!$certPath) {
  Write-Host "WINDOWS_CERTIFICATE_BASE64 is not configured; skipping Windows code signing for $target"
  exit 0
}

$signtool = Find-SignTool
$timestampUrl = if ($env:WINDOWS_TIMESTAMP_URL) { $env:WINDOWS_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }
$password = $env:WINDOWS_CERTIFICATE_PASSWORD

$signArgs = @(
  'sign',
  '/f', $certPath,
  '/fd', 'SHA256',
  '/tr', $timestampUrl,
  '/td', 'SHA256',
  '/v'
)

if (![string]::IsNullOrEmpty($password)) {
  $signArgs += @('/p', $password)
}

$signArgs += $target

Write-Host "Signing $target"
& $signtool @signArgs
if ($LASTEXITCODE -ne 0) {
  throw "signtool sign failed for $target with exit code $LASTEXITCODE"
}

Write-Host "Verifying signature for $target"
& $signtool verify /pa /v $target
if ($LASTEXITCODE -ne 0) {
  throw "signtool verify failed for $target with exit code $LASTEXITCODE"
}
