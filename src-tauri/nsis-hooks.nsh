!macro CLASHNOVA_STOP_INSTALLED_PROCESSES
  DetailPrint "Stopping running ClashNova processes..."
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& { $$ErrorActionPreference = 'SilentlyContinue'; for($$i = 0; $$i -lt 40; $$i++) { $$svc = Get-Service -Name 'clashnova-core' -ErrorAction SilentlyContinue; if (-not $$svc -or $$svc.Status -eq 'Stopped') { break }; if ($$i -eq 0) { Stop-Service -Name 'clashnova-core' -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 250 }; $$installDir = [System.IO.Path]::GetFullPath('$INSTDIR').TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar; $$targetNames = @('ClashNova.exe', 'clashnova.exe', 'clashnova-service.exe', 'mihomo.exe'); Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$targetNames.Contains([System.IO.Path]::GetFileName($$_.ExecutablePath)) -and ([System.IO.Path]::GetFullPath($$_.ExecutablePath)).StartsWith($$installDir, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } }"`
  Sleep 1200
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro CLASHNOVA_STOP_INSTALLED_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CLASHNOVA_STOP_INSTALLED_PROCESSES
!macroend
