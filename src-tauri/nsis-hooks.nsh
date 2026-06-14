!macro CLASHNOVA_STOP_INSTALLED_PROCESSES
  DetailPrint "Stopping running ClashNova processes..."
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& { $$ErrorActionPreference = 'SilentlyContinue'; Get-Service -Name 'clashnova-core' | Stop-Service -Force; Start-Sleep -Milliseconds 500; $$installDir = [System.IO.Path]::GetFullPath('$INSTDIR').TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar; $$targetNames = @('ClashNova.exe', 'clashnova.exe', 'mihomo.exe'); Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$targetNames.Contains([System.IO.Path]::GetFileName($$_.ExecutablePath)) -and ([System.IO.Path]::GetFullPath($$_.ExecutablePath)).StartsWith($$installDir, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } }"`
  Sleep 1200
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro CLASHNOVA_STOP_INSTALLED_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CLASHNOVA_STOP_INSTALLED_PROCESSES
!macroend
