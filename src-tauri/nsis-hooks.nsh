!include "LogicLib.nsh"
!define CLASHNOVA_HOOK_DIR "${__FILEDIR__}"

!macro CLASHNOVA_STOP_PROCESSES MODE
  Push $0
  InitPluginsDir
  File /oname=$PLUGINSDIR\clashnova-processes.ps1 "${CLASHNOVA_HOOK_DIR}\nsis-processes.ps1"
  StrCpy $0 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ; Use native PowerShell: WOW64 cannot read 64-bit process executable paths.
  ${If} ${FileExists} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    StrCpy $0 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  nsExec::ExecToLog '"$0" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\clashnova-processes.ps1" -InstallRoot "$INSTDIR" ${MODE}'
  Pop $0
  ${If} $0 != 0
    Pop $0
    MessageBox MB_ICONSTOP "ClashNova processes could not be stopped. Close the application and retry."
    Abort
  ${EndIf}
  Pop $0
!macroend

; Never replace another client's protocol association.
!macro CLASHNOVA_REGISTER_PROTOCOL SCHEME
  ReadRegStr $0 HKCR "${SCHEME}\shell\open\command" ""
  ${If} $0 == ""
  ${OrIf} $0 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
    WriteRegStr SHCTX "Software\Classes\${SCHEME}" "" "URL:ClashNova subscription"
    WriteRegStr SHCTX "Software\Classes\${SCHEME}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\${SCHEME}\DefaultIcon" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
    WriteRegStr SHCTX "Software\Classes\${SCHEME}\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
  ${EndIf}
!macroend

!macro CLASHNOVA_UNREGISTER_PROTOCOL SCHEME
  ReadRegStr $0 SHCTX "Software\Classes\${SCHEME}\shell\open\command" ""
  ${If} $0 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
    DeleteRegKey SHCTX "Software\Classes\${SCHEME}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Let the Tauri installer handle upgrades; do not pre-uninstall every copy.
  !insertmacro CLASHNOVA_STOP_PROCESSES ""
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  !insertmacro CLASHNOVA_REGISTER_PROTOCOL "clashnova"
  !insertmacro CLASHNOVA_REGISTER_PROTOCOL "clash"
  !insertmacro CLASHNOVA_REGISTER_PROTOCOL "clash-verge"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CLASHNOVA_STOP_PROCESSES "-Uninstall"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Push $0
  !insertmacro CLASHNOVA_UNREGISTER_PROTOCOL "clashnova"
  !insertmacro CLASHNOVA_UNREGISTER_PROTOCOL "clash"
  !insertmacro CLASHNOVA_UNREGISTER_PROTOCOL "clash-verge"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  Pop $0
!macroend
