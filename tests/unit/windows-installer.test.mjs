import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const windowsOnly = { skip: process.platform !== 'win32' }
const root = fileURLToPath(new URL('../..', import.meta.url))
const installRoot = 'C:\\Apps\\ClashNova'
const installed = (id, name = 'clashnova.exe', directory = installRoot) => ({ id, name, path: `${directory}\\${name}` })

function runHook(options = {}) {
  const fixture = Buffer.from(JSON.stringify({ installRoot, processes: [], ...options })).toString('base64')
  const script = Buffer.from(path.join(root, 'src-tauri/nsis-processes.ps1')).toString('base64')
  // All OS-facing commands are mocked in this child scope; never touch real services/processes.
  const command = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$fixture = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${fixture}')) | ConvertFrom-Json
$script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${script}'))
$env:ProgramW6432 = 'C:\\Program Files'
$actions = [Collections.Generic.List[string]]::new()
$queries = [Collections.Generic.List[string]]::new()
function Get-CimInstance {
    param($ClassName, $Filter)
    $queries.Add($ClassName)
    if ($ClassName -eq 'Win32_Service') {
        if ($fixture.service) { [pscustomobject]@{ PathName = $fixture.service } }
    } elseif ($ClassName -eq 'Win32_Process') {
        foreach ($item in $fixture.processes) {
            [pscustomobject]@{ Name = $item.name; ExecutablePath = $item.path; ProcessId = $item.id }
        }
    } else { throw 'Unexpected CIM query' }
}
function Get-Service {
    param($Name)
    $controller = [pscustomobject]@{ Status = $(if ($fixture.stopped) { 'Stopped' } else { 'Running' }) }
    $controller | Add-Member ScriptMethod WaitForStatus {
        param($Status, $Timeout)
        $actions.Add('wait-service')
        if ($fixture.failServiceWait) { throw 'Service wait timed out' }
    }
    $controller
}
function Stop-Service { param($Name) $actions.Add('stop-service') }
function sc.exe { param($Operation, $Name) $actions.Add('delete-service'); $global:LASTEXITCODE = [int]$fixture.deleteExitCode }
function Get-Process {
    [CmdletBinding()] param($Id)
    $item = $fixture.processes | Where-Object { $_.id -eq $Id } | Select-Object -First 1
    if (-not $item -or $item.exited) { return }
    $process = [pscustomobject]@{ Id = $Id; Path = $(if ($item.PSObject.Properties['currentPath']) { $item.currentPath } else { $item.path }) }
    $process | Add-Member ScriptMethod WaitForExit {
        param($Timeout)
        $actions.Add("wait-process:$($this.Id)")
        return -not $fixture.failProcessWait
    }
    $process
}
function Stop-Process {
    param($Id, $InputObject, [switch]$Force)
    if ($Id -or -not $InputObject) { throw 'Use the validated Process object, not a bare PID' }
    $Id = $InputObject.Id
    if (-not $Id) { throw 'Missing process identity' }
    $actions.Add("stop-process:$Id")
}
$arguments = @{ InstallRoot = $fixture.installRoot; Uninstall = [bool]$fixture.uninstall; WhatIf = [bool]$fixture.whatIf }
$message = $null
try { & $script @arguments } catch { $message = $_.Exception.Message }
'HOOK_RESULT:' + (@{ error = $message; actions = @($actions.ToArray()); queries = @($queries.ToArray()) } | ConvertTo-Json -Compress)
`
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 20_000 })
  const result = output.split(/\r?\n/).find((line) => line.startsWith('HOOK_RESULT:'))
  assert.ok(result, `Missing mock result: ${output}`)
  return JSON.parse(result.slice('HOOK_RESULT:'.length))
}

test('Windows installer rejects drive-relative, root-relative and root directories before querying OS state', windowsOnly, () => {
  for (const directory of ['C:Apps\\ClashNova', '\\Apps\\ClashNova', '.\\ClashNova', 'C:\\', '\\\\server\\share']) {
    const result = runHook({ installRoot: directory })
    assert.match(result.error ?? '', /absolute|root|fully qualified/i, directory)
    assert.deepEqual(result.queries, [], directory)
    assert.deepEqual(result.actions, [], directory)
  }
})

test('Windows installer stops only named executables inside the exact installation directory', windowsOnly, () => {
  const result = runHook({ processes: [installed(10), installed(11, 'clashnova.exe', `${installRoot}-preview`), installed(12, 'mihomo.exe', 'D:\\Other'), installed(13, 'other.exe'), { id: 14, name: 'mihomo.exe', path: null }, installed(15, 'MIHOMO.EXE', 'c:\\apps\\clashnova')] })
  assert.equal(result.error, null)
  assert.deepEqual(result.actions, ['stop-process:10', 'wait-process:10', 'stop-process:15', 'wait-process:15'])
})

test('Windows installer accepts fully qualified paths with spaces, alternate separators and UNC roots', windowsOnly, () => {
  for (const directory of ['C:\\Apps\\ClashNova Test', 'C:/Apps/ClashNova/', '\\\\server\\share\\ClashNova']) {
    const result = runHook({ installRoot: directory, processes: [installed(16, 'clashnova.exe', directory)] })
    assert.equal(result.error, null, directory)
    assert.deepEqual(result.actions, ['stop-process:16', 'wait-process:16'], directory)
  }
})

test('Windows installer does not kill a reused PID or a process that has already exited', windowsOnly, () => {
  const result = runHook({ processes: [{ ...installed(20), currentPath: 'D:\\Other\\clashnova.exe' }, { ...installed(21), currentPath: `${installRoot}\\other.exe` }, { ...installed(22), exited: true }, { ...installed(23), currentPath: null }] })
  assert.equal(result.error, null)
  assert.deepEqual(result.actions, [])
})

test('Windows installer stops its managed service without deleting it during upgrade', windowsOnly, () => {
  const result = runHook({ service: '"C:\\Program Files\\ClashNova\\service\\clashnova-service.exe" --service' })
  assert.equal(result.error, null)
  assert.deepEqual(result.actions, ['stop-service', 'wait-service'])
})

test('Windows uninstaller removes only its own service and respects already-stopped state', windowsOnly, () => {
  const owned = runHook({ service: `"${installRoot}\\clashnova-service.exe"`, uninstall: true, stopped: true })
  assert.equal(owned.error, null)
  assert.deepEqual(owned.actions, ['delete-service'])
  const unrelated = runHook({ service: '"D:\\Other\\clashnova-service.exe"', uninstall: true, processes: [installed(30)] })
  assert.match(unrelated.error, /another installation/)
  assert.deepEqual(unrelated.actions, [])
})

test('Windows installer WhatIf never stops processes or mutates service registration', windowsOnly, () => {
  const result = runHook({ service: `"${installRoot}\\clashnova-service.exe"`, uninstall: true, whatIf: true, processes: [installed(40)] })
  assert.equal(result.error, null)
  assert.deepEqual(result.actions, [])
})

test('Windows installer propagates service and process failures instead of continuing installation', windowsOnly, () => {
  const service = runHook({ service: `"${installRoot}\\clashnova-service.exe"`, uninstall: true, failServiceWait: true })
  assert.match(service.error, /Service wait timed out/)
  assert.deepEqual(service.actions, ['stop-service', 'wait-service'])
  const process = runHook({ processes: [installed(50)], failProcessWait: true })
  assert.match(process.error, /Installed process did not stop/)
  const deletion = runHook({ service: `"${installRoot}\\clashnova-service.exe"`, uninstall: true, stopped: true, deleteExitCode: 5 })
  assert.match(deletion.error, /Failed to remove/)
})
