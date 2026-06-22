!macro CLASHNOVA_STOP_INSTALLED_PROCESSES
  DetailPrint "Stopping running ClashNova processes..."
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& { $$ErrorActionPreference = 'SilentlyContinue'; $$installDir = [System.IO.Path]::GetFullPath('$INSTDIR').TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar; $$targetNames = @('ClashNova.exe', 'clashnova.exe', 'clashnova-service.exe', 'clashnova-service-install.exe', 'clashnova-service-uninstall.exe', 'mihomo.exe', 'mihomo-x86_64-pc-windows-msvc.exe'); for($$i = 0; $$i -lt 60; $$i++) { $$svc = Get-Service -Name 'clashnova-core' -ErrorAction SilentlyContinue; if($$svc -and $$svc.Status -ne 'Stopped' -and $$i -eq 0) { Stop-Service -Name 'clashnova-core' -Force -ErrorAction SilentlyContinue }; $$procs = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$targetNames.Contains([System.IO.Path]::GetFileName($$_.ExecutablePath)) -and ([System.IO.Path]::GetFullPath($$_.ExecutablePath)).StartsWith($$installDir, [System.StringComparison]::OrdinalIgnoreCase) }); if($$procs.Count -eq 0 -and (-not $$svc -or $$svc.Status -eq 'Stopped')) { break }; $$procs | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 250 } }"`
  Sleep 1600
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro CLASHNOVA_STOP_INSTALLED_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CLASHNOVA_STOP_INSTALLED_PROCESSES
!macroend
