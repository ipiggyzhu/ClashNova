import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const windowsOnly = { skip: process.platform !== 'win32' }
const source = readFileSync(new URL('../../src-tauri/src/diagnostics_windows.ps1', import.meta.url), 'utf8')
const listener = (port, owner = 123, address = '127.0.0.1') => ({ LocalPort: port, OwningProcess: owner, LocalAddress: address })

function snapshot(options = {}) {
  const fixture = Buffer.from(JSON.stringify({ pid: 123, tcp: [], udp: [], tun: false, adapters: [], ...options })).toString('base64')
  const command = `
$ProgressPreference = 'SilentlyContinue'
$fixture = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${fixture}')) | ConvertFrom-Json
$env:CLASHNOVA_DIAG_PID = [string]$fixture.pid
$env:CLASHNOVA_DIAG_MIXED_PORT = '7897'
$env:CLASHNOVA_DIAG_CONTROLLER_PORT = '9097'
$env:CLASHNOVA_DIAG_CONTROLLER_IP = '::1'
$env:CLASHNOVA_DIAG_DNS_PORT = '5335'
$env:CLASHNOVA_DIAG_DNS_IP = '127.0.0.1'
$env:CLASHNOVA_DIAG_TUN = if ($fixture.tun) { '1' } else { '0' }
$env:CLASHNOVA_DIAG_DEVICE = 'private-adapter-name'
$actions = [Collections.Generic.List[string]]::new()
function Get-NetTCPConnection { [CmdletBinding()] param($State) if ($fixture.failTcp) { throw 'private-tcp-error' }; $fixture.tcp }
function Get-NetUDPEndpoint { [CmdletBinding()] param() if ($fixture.failUdp) { throw 'private-udp-error' }; $fixture.udp }
function Get-CimInstance { [CmdletBinding()] param($ClassName, $Filter)
  if ($ClassName -ne 'Win32_Service' -or $Filter -ne "Name='clashnova-core'") { throw 'Unexpected query' }
  if ($fixture.failService) { throw 'private-service-error' }; $fixture.service
}
function Get-NetAdapter { [CmdletBinding()] param([switch]$IncludeHidden) if ($fixture.failAdapter) { throw 'private-adapter-error' }; $fixture.adapters }
function Stop-Service { $actions.Add('stop-service'); throw 'Unexpected mutation' }
function Start-Service { $actions.Add('start-service'); throw 'Unexpected mutation' }
function Set-ItemProperty { $actions.Add('set-registry'); throw 'Unexpected mutation' }
function Remove-Item { $actions.Add('remove-file'); throw 'Unexpected mutation' }
$report = & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(source).toString('base64')}'))))
@{ report = ($report | ConvertFrom-Json); actions = @($actions.ToArray()) } | ConvertTo-Json -Depth 5 -Compress
`
  const executable = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const raw = execFileSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 })
  assert.doesNotMatch(raw, /private-|127\.0\.0\.1|7897|9097|5335|OwningProcess/)
  const result = JSON.parse(raw)
  assert.deepEqual(result.actions, [])
  return result.report
}

test('diagnostics identify owned TCP and UDP listeners without exporting addresses or PID', windowsOnly, () => {
  const report = snapshot({ tcp: [listener(7897), listener(9097, 123, '::')], udp: [listener(5335, 123, '0.0.0.0')], service: { State: 'Running' } })
  for (const name of ['mixed', 'controller', 'dns']) assert.deepEqual(report[name], { occupied: true, owned: true })
  assert.equal(report.service, 'running')
  assert.equal(report.tunUp, null)
})

test('diagnostics distinguish foreign processes and wrong address families', windowsOnly, () => {
  const report = snapshot({ tcp: [listener(7897, 999), listener(9097, 123, '0.0.0.0')] })
  assert.deepEqual(report.mixed, { occupied: true, owned: false })
  assert.deepEqual(report.controller, { occupied: false, owned: false })
  assert.equal(report.service, 'missing')
})

test('diagnostics leave ownership unknown when the current core PID is unavailable', windowsOnly, () => {
  assert.deepEqual(snapshot({ pid: 0, tcp: [listener(7897)] }).mixed, { occupied: true, owned: null })
})

test('diagnostic query failures remain unknown, are independent and never leak raw errors', windowsOnly, () => {
  const partial = snapshot({ failTcp: true, udp: [listener(5335)], service: { State: 'Stopped' } })
  assert.equal(partial.mixed, null)
  assert.deepEqual(partial.dns, { occupied: true, owned: true })
  assert.equal(partial.service, 'stopped')
  const failed = snapshot({ tun: true, failTcp: true, failUdp: true, failService: true, failAdapter: true })
  assert.ok(Object.values(failed).every(value => value === null))
})

test('diagnostics inspect only the selected TUN adapter and do not report a stopped one as active', windowsOnly, () => {
  const adapters = [{ Name: 'unrelated', Status: 'Up' }, { Name: 'private-adapter-name', Status: 'Down' }]
  assert.equal(snapshot({ tun: true, adapters }).tunUp, false)
  adapters[1].Status = 'Up'
  assert.equal(snapshot({ tun: true, adapters }).tunUp, true)
  assert.equal(snapshot({ tun: false, adapters }).tunUp, null)
})
