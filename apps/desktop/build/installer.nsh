; Use native process enumeration instead of PowerShell/tasklist/findstr. Wine can
; return misleading exit codes for those shell commands (a fresh bottle was
; reported as already running pi-kit). Keep this check on real Windows as well.
; nsProcess: 0 = found, 603 = not running; other values are detection errors.
!macro customCheckAppRunning
  ; An update installs silently right after the app quit: give the service host and its backend time to exit after it.
  StrCpy $R1 0
  pi_kit_wait_exit:
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
    ${AndIf} ${Silent}
    ${AndIf} $R1 < 30
      IntOp $R1 $R1 + 1
      Sleep 500
      Goto pi_kit_wait_exit
    ${EndIf}

  pi_kit_check_process:
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      ; Silently, nobody can answer: what still runs after the wait is background processes, which would block the update.
      ${If} ${Silent}
        Goto pi_kit_close_process
      ${EndIf}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDCANCEL IDOK pi_kit_close_process
      Quit

      pi_kit_close_process:
        DetailPrint "$(appClosing)"
        ${nsProcess::CloseProcess} "${APP_EXECUTABLE_FILENAME}" $R0
        Sleep 500
        ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
        ${If} $R0 == 0
          ; The background service's host and backend have no window to close.
          ${nsProcess::KillProcess} "${APP_EXECUTABLE_FILENAME}" $R0
          Sleep 500
          ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
        ${EndIf}
        ${If} $R0 == 0
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY pi_kit_check_process
          Quit
        ${EndIf}
    ${EndIf}

    ${If} $R0 != 603
      ; Do not misreport a failed check as a running app, or silently overwrite it.
      MessageBox MB_RETRYCANCEL|MB_ICONSTOP "Could not check whether pi-kit is running (process check error $R0). Close pi-kit and retry." /SD IDCANCEL IDRETRY pi_kit_check_process
      Quit
    ${EndIf}
    ${nsProcess::Unload}
!macroend

; A real uninstall, not the old version's during an update: the sign-in entry of the background service and the pi-kit
; command would point at a deleted pi-kit.exe. The user's data stays (deleteAppDataOnUninstall is off).
!macro customUnInstall
  ${IfNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "dev.pi-kit.app.service"
    Delete "$LOCALAPPDATA\pi-kit\bin\pi-kit.cmd"
  ${EndIf}
!macroend
