; Use native process enumeration instead of PowerShell/tasklist/findstr. Wine can
; return misleading exit codes for those shell commands (a fresh bottle was
; reported as already running pi-kit). Keep this check on real Windows as well.
; nsProcess: 0 = found, 603 = not running; other values are detection errors.
!macro customCheckAppRunning
  pi_kit_check_process:
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDCANCEL IDOK pi_kit_close_process
      Quit

      pi_kit_close_process:
        DetailPrint "$(appClosing)"
        ${nsProcess::CloseProcess} "${APP_EXECUTABLE_FILENAME}" $R0
        Sleep 500
        ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
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
